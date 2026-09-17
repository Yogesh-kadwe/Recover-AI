"""
Unit tests for Doctor-Patient WebRTC Consultation Signaling
===========================================================
Tests room creation, joining, SDP offer/answer message passing,
ICE candidate queuing, and room termination.
"""

import unittest
from ai.consultation_signaling import ConsultationSignalingManager
from app import app


class TestConsultationSignaling(unittest.TestCase):
    """Test signaling manager logic directly."""

    def setUp(self):
        self.mgr = ConsultationSignalingManager()

    def test_01_create_room(self):
        res = self.mgr.create_room(patient_id="P-101", patient_name="Rajesh Sharma")
        self.assertTrue(res["success"])
        self.assertTrue(res["room_id"].startswith("RECOVERAI-"))
        self.assertEqual(res["status"], "waiting")
        self.assertEqual(res["patient"]["name"], "Rajesh Sharma")

    def test_02_join_room_doctor(self):
        create_res = self.mgr.create_room(patient_id="P-101", patient_name="Rajesh Sharma")
        room_id = create_res["room_id"]

        join_res = self.mgr.join_room(room_id=room_id, role="doctor", name="Dr. Vikramaditya Rao")
        self.assertTrue(join_res["success"])
        self.assertEqual(join_res["status"], "active")
        self.assertEqual(join_res["doctor"]["name"], "Dr. Vikramaditya Rao")

        # Patient should receive peer_joined event
        poll_patient = self.mgr.poll_signals(room_id=room_id, role="patient")
        self.assertTrue(poll_patient["success"])
        self.assertEqual(len(poll_patient["messages"]), 1)
        self.assertEqual(poll_patient["messages"][0]["type"], "peer_joined")
        self.assertEqual(poll_patient["messages"][0]["sender_name"], "Dr. Vikramaditya Rao")

    def test_03_signal_offer_answer_and_ice(self):
        create_res = self.mgr.create_room(patient_id="P-101", patient_name="Rajesh")
        room_id = create_res["room_id"]
        self.mgr.join_room(room_id=room_id, role="doctor", name="Dr. Rao")

        # Flush initial messages
        self.mgr.poll_signals(room_id=room_id, role="patient")
        self.mgr.poll_signals(room_id=room_id, role="doctor")

        # Patient sends SDP offer
        fake_offer = {"type": "offer", "sdp": "v=0\r\no=- 123 456 IN IP4 127.0.0.1..."}
        sig_res = self.mgr.send_signal(room_id=room_id, sender_role="patient", signal_type="offer", payload=fake_offer)
        self.assertTrue(sig_res["success"])

        # Doctor polls and gets offer
        doc_poll = self.mgr.poll_signals(room_id=room_id, role="doctor")
        self.assertEqual(len(doc_poll["messages"]), 1)
        self.assertEqual(doc_poll["messages"][0]["type"], "offer")
        self.assertEqual(doc_poll["messages"][0]["payload"]["sdp"], fake_offer["sdp"])

        # Doctor sends SDP answer
        fake_answer = {"type": "answer", "sdp": "v=0\r\no=- 789 012 IN IP4 127.0.0.1..."}
        self.mgr.send_signal(room_id=room_id, sender_role="doctor", signal_type="answer", payload=fake_answer)

        # Doctor sends ICE candidate
        fake_ice = {"candidate": "candidate:1 1 UDP 2122260223 192.168.1.5 50000 typ host", "sdpMid": "0"}
        self.mgr.send_signal(room_id=room_id, sender_role="doctor", signal_type="ice-candidate", payload=fake_ice)

        # Patient polls and receives answer + candidate
        patient_poll = self.mgr.poll_signals(room_id=room_id, role="patient")
        self.assertEqual(len(patient_poll["messages"]), 2)
        self.assertEqual(patient_poll["messages"][0]["type"], "answer")
        self.assertEqual(patient_poll["messages"][1]["type"], "ice-candidate")

    def test_04_leave_room(self):
        create_res = self.mgr.create_room(patient_id="P-101", patient_name="Rajesh")
        room_id = create_res["room_id"]
        self.mgr.join_room(room_id=room_id, role="doctor", name="Dr. Rao")

        leave_res = self.mgr.leave_room(room_id=room_id, role="doctor")
        self.assertTrue(leave_res["success"])
        self.assertEqual(leave_res["status"], "ended")

        # Patient polls and sees peer_left
        patient_poll = self.mgr.poll_signals(room_id=room_id, role="patient")
        msg_types = [m["type"] for m in patient_poll["messages"]]
        self.assertIn("peer_left", msg_types)


class TestConsultationFlaskEndpoints(unittest.TestCase):
    """Test Flask HTTP API endpoints for consultation."""

    def setUp(self):
        self.client = app.test_client()

    def test_api_create_and_join_flow(self):
        # 1. Create room
        res = self.client.post("/api/consultation/create", json={
            "patient_id": "P-101",
            "patient_name": "Rajesh Sharma"
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        room_id = data["room_id"]

        # 2. Query room info
        info_res = self.client.get(f"/api/consultation/room/{room_id}")
        self.assertEqual(info_res.status_code, 200)
        info_data = info_res.get_json()
        self.assertTrue(info_data["exists"])

        # 3. Doctor joins
        join_res = self.client.post("/api/consultation/join", json={
            "room_id": room_id,
            "role": "doctor",
            "name": "Dr. Rao"
        })
        self.assertEqual(join_res.status_code, 200)

        # 4. Exchange signal
        sig_res = self.client.post("/api/consultation/signal", json={
            "room_id": room_id,
            "sender_role": "doctor",
            "type": "test_signal",
            "payload": {"hello": "world"}
        })
        self.assertEqual(sig_res.status_code, 200)

        # 5. Poll signal as patient
        poll_res = self.client.get(f"/api/consultation/poll?room_id={room_id}&role=patient")
        self.assertEqual(poll_res.status_code, 200)
        poll_data = poll_res.get_json()
        self.assertTrue(poll_data["success"])
        msg_types = [m["type"] for m in poll_data["messages"]]
        self.assertIn("peer_joined", msg_types)
        self.assertIn("test_signal", msg_types)

        # 6. Leave room
        leave_res = self.client.post("/api/consultation/leave", json={
            "room_id": room_id,
            "role": "patient"
        })
        self.assertEqual(leave_res.status_code, 200)


if __name__ == "__main__":
    unittest.main()
