"""
RecoverAI Doctor-Patient Telehealth Video Consultation Signaling Manager
========================================================================
Lightweight, thread-safe in-memory WebRTC signaling hub for real-time
peer-to-peer audio and video consultations.

Zero Media Recording Guarantee:
- This manager only routes WebRTC SDP (Offer/Answer) and ICE Candidate metadata.
- Actual audio/video flows strictly peer-to-peer via WebRTC (SRTP/UDP).
- No audio, video, or frame data touches or persists on the server.
"""

import time
import random
import string
import threading
from typing import Dict, Any, List, Optional
import logging

logger = logging.getLogger("consultation_signaling")


class ConsultationSignalingManager:
    """Thread-safe in-memory signaling room coordinator for WebRTC consultations."""

    def __init__(self, room_timeout_seconds: float = 7200.0, inactive_timeout_seconds: float = 1800.0):
        self._lock = threading.Lock()
        self._rooms: Dict[str, Dict[str, Any]] = {}
        self.room_timeout_seconds = room_timeout_seconds
        self.inactive_timeout_seconds = inactive_timeout_seconds

    def _generate_room_id(self) -> str:
        """Generate a user-friendly unique Room ID: RECOVERAI-XXXXXX"""
        digits = "".join(random.choices(string.digits, k=6))
        return f"RECOVERAI-{digits}"

    def create_room(self, patient_id: str = "P-101", patient_name: str = "Patient", custom_room_id: Optional[str] = None) -> Dict[str, Any]:
        """Create a new consultation room."""
        with self._lock:
            self._cleanup_stale_rooms_unlocked()

            room_id = (custom_room_id or self._generate_room_id()).upper().strip()
            # If already exists and active, return existing or make unique
            if room_id in self._rooms and self._rooms[room_id]["status"] != "ended":
                # If custom requested, keep it, otherwise generate new
                if not custom_room_id:
                    while room_id in self._rooms and self._rooms[room_id]["status"] != "ended":
                        room_id = self._generate_room_id()

            now = time.time()
            self._rooms[room_id] = {
                "room_id": room_id,
                "created_at": now,
                "last_activity": now,
                "status": "waiting",  # 'waiting' | 'active' | 'ended'
                "patient": {
                    "id": patient_id,
                    "name": patient_name,
                    "joined_at": now,
                    "is_active": True,
                    "queue": []
                },
                "doctor": None
            }

            logger.info(f"[CONSULTATION] Created room {room_id} for patient {patient_name} ({patient_id})")
            return {
                "success": True,
                "room_id": room_id,
                "status": "waiting",
                "patient": {"id": patient_id, "name": patient_name},
                "doctor": None
            }

    def join_room(self, room_id: str, role: str, name: str, user_id: str = "") -> Dict[str, Any]:
        """Join an existing consultation room as 'doctor' or 'patient'."""
        with self._lock:
            self._cleanup_stale_rooms_unlocked()
            room_id = room_id.upper().strip()

            if room_id not in self._rooms:
                return {
                    "success": False,
                    "error": f"Room '{room_id}' not found. Please check the Consultation Room ID."
                }

            room = self._rooms[room_id]
            if room["status"] == "ended":
                return {
                    "success": False,
                    "error": f"Consultation session in room '{room_id}' has already ended."
                }

            now = time.time()
            room["last_activity"] = now
            role = role.lower().strip()

            if role not in ("doctor", "patient"):
                return {"success": False, "error": f"Invalid role '{role}'. Must be 'doctor' or 'patient'."}

            # Register participant
            participant_data = {
                "id": user_id or f"{role.upper()}-{int(now)}",
                "name": name or ("Doctor" if role == "doctor" else "Patient"),
                "joined_at": now,
                "is_active": True,
                "queue": []
            }

            room[role] = participant_data

            # If both are present, room is active
            if room["patient"] and room["doctor"]:
                room["status"] = "active"

            # Notify the other participant that a peer joined
            other_role = "doctor" if role == "patient" else "patient"
            if room[other_role] and room[other_role].get("queue") is not None:
                room[other_role]["queue"].append({
                    "type": "peer_joined",
                    "sender_role": role,
                    "sender_name": participant_data["name"],
                    "timestamp": now
                })

            logger.info(f"[CONSULTATION] {role.capitalize()} '{name}' joined room {room_id}. Status: {room['status']}")
            return {
                "success": True,
                "room_id": room_id,
                "status": room["status"],
                "role": role,
                "patient": {"name": room["patient"]["name"]} if room["patient"] else None,
                "doctor": {"name": room["doctor"]["name"]} if room["doctor"] else None
            }

    def send_signal(self, room_id: str, sender_role: str, signal_type: str, payload: Any) -> Dict[str, Any]:
        """
        Enqueue a WebRTC signaling message (SDP offer/answer, ICE candidate, or control event)
        for delivery to the peer.
        """
        with self._lock:
            room_id = room_id.upper().strip()
            sender_role = sender_role.lower().strip()

            if room_id not in self._rooms:
                return {"success": False, "error": f"Room '{room_id}' not found."}

            room = self._rooms[room_id]
            now = time.time()
            room["last_activity"] = now

            target_role = "doctor" if sender_role == "patient" else "patient"

            if not room[target_role]:
                # Peer has not joined yet; queue signal if it's an offer, else drop gracefully
                if signal_type in ("offer", "candidate"):
                    # We create a temporary receiver queue if needed
                    pass

            message = {
                "type": signal_type,
                "sender_role": sender_role,
                "payload": payload,
                "timestamp": now
            }

            # Enqueue to target role's queue if target exists
            if room[target_role] and "queue" in room[target_role]:
                room[target_role]["queue"].append(message)
                logger.debug(f"[SIGNAL] {sender_role} -> {target_role} ({signal_type}) in {room_id}")

            # If signal_type is 'leave' or 'end', mark status
            if signal_type in ("leave", "end_call"):
                if room[sender_role]:
                    room[sender_role]["is_active"] = False
                room["status"] = "ended"

            return {"success": True}

    def poll_signals(self, room_id: str, role: str) -> Dict[str, Any]:
        """Retrieve and flush all pending messages queued for the requesting role."""
        with self._lock:
            room_id = room_id.upper().strip()
            role = role.lower().strip()

            if room_id not in self._rooms:
                return {
                    "success": False,
                    "error": "Room not found or expired.",
                    "status": "ended",
                    "messages": []
                }

            room = self._rooms[room_id]
            now = time.time()
            room["last_activity"] = now

            participant = room.get(role)
            if not participant:
                return {
                    "success": True,
                    "status": room["status"],
                    "messages": [],
                    "peer_present": False
                }

            participant["is_active"] = True
            messages = list(participant["queue"])
            participant["queue"].clear()

            other_role = "doctor" if role == "patient" else "patient"
            peer = room.get(other_role)
            peer_present = bool(peer and peer.get("is_active"))

            return {
                "success": True,
                "room_id": room_id,
                "status": room["status"],
                "peer_present": peer_present,
                "peer_info": {"name": peer["name"]} if peer else None,
                "messages": messages
            }

    def leave_room(self, room_id: str, role: str) -> Dict[str, Any]:
        """Notify peer and gracefully close consultation session."""
        with self._lock:
            room_id = room_id.upper().strip()
            role = role.lower().strip()

            if room_id not in self._rooms:
                return {"success": True, "message": "Room already closed."}

            room = self._rooms[room_id]
            now = time.time()
            room["last_activity"] = now

            other_role = "doctor" if role == "patient" else "patient"
            if room.get(other_role) and room[other_role].get("queue") is not None:
                room[other_role]["queue"].append({
                    "type": "peer_left",
                    "sender_role": role,
                    "timestamp": now
                })

            if room.get(role):
                room[role]["is_active"] = False

            room["status"] = "ended"
            logger.info(f"[CONSULTATION] Role '{role}' left room {room_id}. Session ended.")
            return {"success": True, "room_id": room_id, "status": "ended"}

    def get_room_info(self, room_id: str) -> Dict[str, Any]:
        """Check room details."""
        with self._lock:
            room_id = room_id.upper().strip()
            if room_id not in self._rooms:
                return {"exists": False}
            room = self._rooms[room_id]
            return {
                "exists": True,
                "room_id": room_id,
                "status": room["status"],
                "has_patient": bool(room["patient"]),
                "has_doctor": bool(room["doctor"]),
                "created_at": room["created_at"]
            }

    def _cleanup_stale_rooms_unlocked(self):
        """Remove inactive rooms older than threshold (internal unlocked method)."""
        now = time.time()
        stale_ids = []
        for r_id, r in self._rooms.items():
            if (now - r["created_at"] > self.room_timeout_seconds) or \
               (now - r["last_activity"] > self.inactive_timeout_seconds and r["status"] == "ended"):
                stale_ids.append(r_id)
        for r_id in stale_ids:
            del self._rooms[r_id]


# Global Singleton
consultation_manager = ConsultationSignalingManager()
