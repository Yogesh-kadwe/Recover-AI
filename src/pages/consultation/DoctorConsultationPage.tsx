import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import {
  Video,
  Mic,
  MicOff,
  VideoOff,
  PhoneOff,
  Copy,
  Check,
  Stethoscope,
  User,
  ShieldCheck,
  AlertCircle,
  Clock,
  RefreshCw,
  Sparkles,
  Lock,
  ArrowRight,
  Radio,
} from 'lucide-react';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

interface DoctorConsultationPageProps {
  initialRole?: 'patient' | 'doctor';
}

export const DoctorConsultationPage: React.FC<DoctorConsultationPageProps> = ({ initialRole }) => {
  const { role: contextRole, currentPatient } = useApp();
  const currentRole: 'patient' | 'doctor' = initialRole || (contextRole === 'doctor' ? 'doctor' : 'patient');

  // Consultation Session State
  const [sessionState, setSessionState] = useState<'lobby' | 'permission_check' | 'waiting' | 'in_call' | 'ended'>('lobby');
  const [roomId, setRoomId] = useState<string>('');
  const [inputRoomId, setInputRoomId] = useState<string>('');
  const [participantName, setParticipantName] = useState<string>(
    currentRole === 'doctor' ? 'Dr. Vikramaditya Rao' : currentPatient?.name || 'Rajesh Sharma'
  );
  const [peerName, setPeerName] = useState<string>(
    currentRole === 'doctor' ? currentPatient?.name || 'Patient' : 'Dr. Vikramaditya Rao'
  );

  // Media & Device State
  const [micEnabled, setMicEnabled] = useState<boolean>(true);
  const [cameraEnabled, setCameraEnabled] = useState<boolean>(true);
  const [hasCameraPermission, setHasCameraPermission] = useState<boolean | null>(null);
  const [hasMicPermission, setHasMicPermission] = useState<boolean | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  // WebRTC Connection State
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'reconnecting'>('disconnected');
  const [callDuration, setCallDuration] = useState<number>(0);
  const [copiedRoomId, setCopiedRoomId] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // WebRTC & DOM Refs
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const pollingIntervalRef = useRef<any>(null);
  const callTimerRef = useRef<any>(null);
  const iceCandidatesQueueRef = useRef<RTCIceCandidateInit[]>([]);

  // Generate unique room ID on mount for patient
  useEffect(() => {
    if (!roomId) {
      const randDigits = Math.floor(100000 + Math.random() * 900000);
      setRoomId(`RECOVERAI-${randDigits}`);
    }
  }, [roomId]);

  // Clean up media tracks and WebRTC on unmount
  useEffect(() => {
    return () => {
      cleanupCall();
    };
  }, []);

  // Format call duration MM:SS
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Copy Room ID to Clipboard
  const handleCopyRoomId = () => {
    const code = roomId || inputRoomId;
    if (!code) return;
    navigator.clipboard.writeText(code);
    setCopiedRoomId(true);
    setTimeout(() => setCopiedRoomId(false), 2500);
  };

  // ============================================================================
  // MEDIA DEVICE & PERMISSION HANDLING
  // ============================================================================
  const requestMediaPermissions = async (): Promise<MediaStream | null> => {
    setPermissionError(null);
    setErrorMessage(null);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setPermissionError('WebRTC media capture is not supported in this browser environment.');
      return null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      setHasCameraPermission(true);
      setHasMicPermission(true);
      localStreamRef.current = stream;

      // Attach stream to local preview if video element is ready
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      return stream;
    } catch (err: any) {
      console.warn('[WebRTC] Media permission error:', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setPermissionError('Camera and Microphone permission was denied. Please allow camera and mic access in your browser address bar.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setPermissionError('No camera or microphone hardware found on this device.');
      } else {
        setPermissionError(`Failed to access media devices: ${err.message || 'Unknown error'}`);
      }
      setHasCameraPermission(false);
      setHasMicPermission(false);
      return null;
    }
  };

  // Toggle Microphone
  const toggleMicrophone = () => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      const newState = !micEnabled;
      audioTracks.forEach((track) => {
        track.enabled = newState;
      });
      setMicEnabled(newState);
    }
  };

  // Toggle Camera
  const toggleCamera = () => {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      const newState = !cameraEnabled;
      videoTracks.forEach((track) => {
        track.enabled = newState;
      });
      setCameraEnabled(newState);
    }
  };

  // ============================================================================
  // WEBRTC SIGNALING & PEER CONNECTION
  // ============================================================================
  const createPeerConnection = (stream: MediaStream, targetRoomId: string): RTCPeerConnection => {
    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.close();
      } catch {
        // ignore
      }
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnectionRef.current = pc;

    // Add local tracks to WebRTC peer connection
    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });

    // Send local ICE candidates to backend signaling queue
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        fetch('http://localhost:5000/api/consultation/signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            room_id: targetRoomId,
            sender_role: currentRole,
            type: 'ice-candidate',
            payload: event.candidate.toJSON(),
          }),
        }).catch(() => {});
      }
    };

    // Receive remote tracks from peer
    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
      }
    };

    // Connection state listeners
    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case 'connected':
          setConnectionStatus('connected');
          setSessionState('in_call');
          break;
        case 'connecting':
          setConnectionStatus('connecting');
          break;
        case 'disconnected':
        case 'failed':
          setConnectionStatus('reconnecting');
          break;
        case 'closed':
          setConnectionStatus('disconnected');
          break;
      }
    };

    return pc;
  };

  // Start Signaling Polling Loop
  const startSignalingPolling = useCallback((activeRoomId: string) => {
    if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);

    pollingIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:5000/api/consultation/poll?room_id=${activeRoomId}&role=${currentRole}`);
        if (!res.ok) return;

        const data = await res.json();
        if (!data.success) return;

        if (data.peer_info?.name) {
          setPeerName(data.peer_info.name);
        }

        const pc = peerConnectionRef.current;
        const messages: any[] = data.messages || [];

        for (const msg of messages) {
          if (msg.type === 'peer_joined') {
            // Peer joined! If we are the patient (initiator), create and send SDP offer
            if (currentRole === 'patient' && pc && pc.signalingState === 'stable') {
              const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
              });
              await pc.setLocalDescription(offer);

              await fetch('http://localhost:5000/api/consultation/signal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  room_id: activeRoomId,
                  sender_role: currentRole,
                  type: 'offer',
                  payload: { type: offer.type, sdp: offer.sdp },
                }),
              });
            }
          } else if (msg.type === 'offer') {
            // Receiver (Doctor) gets offer -> setRemoteDescription, create answer, setLocalDescription
            if (pc) {
              await pc.setRemoteDescription(new RTCSessionDescription(msg.payload));

              // Process any queued ICE candidates
              while (iceCandidatesQueueRef.current.length > 0) {
                const cand = iceCandidatesQueueRef.current.shift();
                if (cand) await pc.addIceCandidate(new RTCIceCandidate(cand));
              }

              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);

              await fetch('http://localhost:5000/api/consultation/signal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  room_id: activeRoomId,
                  sender_role: currentRole,
                  type: 'answer',
                  payload: { type: answer.type, sdp: answer.sdp },
                }),
              });
            }
          } else if (msg.type === 'answer') {
            // Initiator (Patient) receives answer -> setRemoteDescription
            if (pc && pc.signalingState === 'have-local-offer') {
              await pc.setRemoteDescription(new RTCSessionDescription(msg.payload));

              // Process queued candidates
              while (iceCandidatesQueueRef.current.length > 0) {
                const cand = iceCandidatesQueueRef.current.shift();
                if (cand) await pc.addIceCandidate(new RTCIceCandidate(cand));
              }
            }
          } else if (msg.type === 'ice-candidate') {
            // Remote ICE candidate received
            if (pc && pc.remoteDescription && pc.remoteDescription.type) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(msg.payload));
              } catch (e) {
                console.warn('[WebRTC] Error adding ICE candidate:', e);
              }
            } else {
              iceCandidatesQueueRef.current.push(msg.payload);
            }
          } else if (msg.type === 'peer_left' || msg.type === 'end_call') {
            setErrorMessage(`${peerName} has ended the consultation.`);
            cleanupCall();
            setSessionState('ended');
          }
        }
      } catch (err) {
        console.warn('[Signaling] Poll error:', err);
      }
    }, 800);
  }, [currentRole, peerName]);

  // ============================================================================
  // PATIENT FLOW: CREATE ROOM & START CONSULTATION
  // ============================================================================
  const handleStartPatientConsultation = async () => {
    setPermissionError(null);
    setErrorMessage(null);

    // 1. Request camera and mic permissions
    const stream = await requestMediaPermissions();
    if (!stream) {
      setSessionState('permission_check');
      return;
    }

    const activeRoom = roomId || `RECOVERAI-${Math.floor(100000 + Math.random() * 900000)}`;
    setRoomId(activeRoom);

    // 2. Register room in backend
    try {
      await fetch('http://localhost:5000/api/consultation/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_id: activeRoom,
          patient_id: currentPatient?.id || 'P-101',
          patient_name: participantName,
        }),
      });
    } catch {
      // Offline fallback
    }

    // 3. Initialize WebRTC peer connection
    createPeerConnection(stream, activeRoom);

    // 4. Start signaling polling
    startSignalingPolling(activeRoom);

    // 5. Update state to waiting for doctor
    setSessionState('waiting');
  };

  // ============================================================================
  // DOCTOR FLOW: JOIN ROOM & CONNECT
  // ============================================================================
  const handleJoinDoctorConsultation = async () => {
    setPermissionError(null);
    setErrorMessage(null);

    const targetRoom = (inputRoomId || roomId).trim().toUpperCase();
    if (!targetRoom) {
      setErrorMessage('Please enter a valid Consultation Room ID.');
      return;
    }

    // 1. Check if room exists
    try {
      const roomCheck = await fetch(`http://localhost:5000/api/consultation/room/${targetRoom}`);
      if (!roomCheck.ok) {
        setErrorMessage(`Consultation Room '${targetRoom}' not found. Verify the code with the patient.`);
        return;
      }
    } catch {
      // Proceed gracefully
    }

    // 2. Request camera & mic permissions
    const stream = await requestMediaPermissions();
    if (!stream) {
      setSessionState('permission_check');
      return;
    }

    // 3. Join consultation room in backend
    try {
      await fetch('http://localhost:5000/api/consultation/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_id: targetRoom,
          role: currentRole,
          name: participantName,
        }),
      });
    } catch {
      // Offline fallback
    }

    setRoomId(targetRoom);

    // 4. Create WebRTC Peer Connection
    createPeerConnection(stream, targetRoom);

    // 5. Start signaling polling
    startSignalingPolling(targetRoom);

    // 6. Move into connecting / in_call state
    setSessionState('in_call');
    setConnectionStatus('connecting');
  };

  // ============================================================================
  // CALL TIMER & CLEANUP
  // ============================================================================
  useEffect(() => {
    if (sessionState === 'in_call' && connectionStatus === 'connected') {
      callTimerRef.current = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } else {
      if (callTimerRef.current) clearInterval(callTimerRef.current);
    }
    return () => {
      if (callTimerRef.current) clearInterval(callTimerRef.current);
    };
  }, [sessionState, connectionStatus]);

  // Clean up all tracks and WebRTC resources
  const cleanupCall = () => {
    // 1. Stop all media tracks to turn off camera & mic hardware lights
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore
        }
      });
      localStreamRef.current = null;
    }

    // 2. Disconnect video DOM sources
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

    // 3. Close WebRTC PeerConnection
    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.close();
      } catch {
        // ignore
      }
      peerConnectionRef.current = null;
    }

    // 4. Clear polling intervals and timers
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }

    iceCandidatesQueueRef.current = [];
  };

  // End Call Handler
  const handleEndCall = async () => {
    const activeRoom = roomId || inputRoomId;
    if (activeRoom) {
      try {
        await fetch('http://localhost:5000/api/consultation/leave', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            room_id: activeRoom,
            role: currentRole,
          }),
        });
      } catch {
        // ignore
      }
    }

    cleanupCall();
    setSessionState('ended');
  };

  // Reset to Lobby
  const handleResetToLobby = () => {
    cleanupCall();
    const newRoom = `RECOVERAI-${Math.floor(100000 + Math.random() * 900000)}`;
    setRoomId(newRoom);
    setInputRoomId('');
    setCallDuration(0);
    setSessionState('lobby');
    setConnectionStatus('disconnected');
    setPermissionError(null);
    setErrorMessage(null);
  };

  // Ensure local video attaches when video element mounts in call or waiting state
  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [sessionState, cameraEnabled]);

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-fadeIn pb-12">
      
      {/* HEADER CARD */}
      <div className="bg-gradient-to-r from-slate-900 via-teal-950 to-slate-900 p-6 sm:p-8 rounded-3xl text-white shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-6 border border-slate-800">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="px-3 py-1 bg-teal-500/20 text-teal-300 border border-teal-500/30 rounded-full text-xs font-extrabold uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Real-Time WebRTC Telehealth</span>
            </span>
            <span className="px-3 py-1 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-full text-xs font-bold flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5" />
              <span>Zero Recording Privacy</span>
            </span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight flex items-center gap-2">
            <span>👨‍⚕️ Doctor Consultation</span>
            <span className="text-xs font-bold text-teal-400 bg-teal-900/60 px-2.5 py-0.5 rounded-full uppercase">
              {currentRole === 'doctor' ? 'Doctor Desk' : 'Patient View'}
            </span>
          </h1>
          <p className="text-xs sm:text-sm text-slate-300 max-w-2xl leading-relaxed">
            Direct, secure, peer-to-peer audio/video follow-up between patient and doctor. 
            All streams are transmitted purely in real-time with zero cloud recording or video storage.
          </p>
        </div>

        {sessionState === 'in_call' && (
          <div className="flex items-center gap-3 bg-slate-800/80 px-4 py-2.5 rounded-2xl border border-slate-700 shrink-0">
            <Radio className="w-4 h-4 text-emerald-400 animate-pulse" />
            <div className="text-right">
              <div className="text-[10px] text-slate-400 uppercase font-bold">Call Duration</div>
              <div className="text-sm font-mono font-black text-white">{formatDuration(callDuration)}</div>
            </div>
          </div>
        )}
      </div>

      {/* ERROR / PERMISSION BANNER */}
      {(permissionError || errorMessage) && (
        <div className="p-4 bg-rose-50 border border-rose-200 text-rose-800 rounded-2xl flex items-start justify-between gap-3 text-xs font-semibold animate-fadeIn">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-rose-900 mb-0.5">Consultation Notice</div>
              <div>{permissionError || errorMessage}</div>
            </div>
          </div>
          <button
            onClick={() => {
              setPermissionError(null);
              setErrorMessage(null);
            }}
            className="text-rose-600 hover:text-rose-950 font-bold p-1"
          >
            ✕
          </button>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 1. LOBBY / SETUP SCREEN */}
      {/* ========================================================================= */}
      {sessionState === 'lobby' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Left 7 Cols: Quick Start / Create Session */}
          <div className="lg:col-span-7 bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-xs space-y-6">
            <div>
              <div className="text-[11px] font-bold text-teal-600 uppercase tracking-wider mb-1">
                {currentRole === 'doctor' ? 'Clinical Telehealth Desk' : 'Patient Recovery Portal'}
              </div>
              <h2 className="text-xl font-black text-slate-900">
                {currentRole === 'doctor' ? 'Connect with Patient' : 'Start Consultation with Doctor'}
              </h2>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Connect directly with your clinician for post-operative recovery reviews, wound assessment, or medication adjustments.
              </p>
            </div>

            {/* Room ID Display Box */}
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-2">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">
                Generated Consultation Room ID
              </span>
              <div className="flex items-center justify-between gap-3">
                <div className="font-mono text-lg font-black text-slate-900 tracking-wider">
                  {roomId}
                </div>
                <button
                  onClick={handleCopyRoomId}
                  className="px-3 py-1.5 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 flex items-center gap-1.5 transition-colors cursor-pointer"
                  title="Copy Room ID"
                >
                  {copiedRoomId ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-slate-500" />}
                  <span>{copiedRoomId ? 'Copied!' : 'Copy ID'}</span>
                </button>
              </div>
              <p className="text-[11px] text-slate-400">
                Share this Room ID with your {currentRole === 'doctor' ? 'patient' : 'doctor'} so they can join the session.
              </p>
            </div>

            {/* Participant Name Input */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-slate-700 block">Your Display Name</label>
              <input
                type="text"
                value={participantName}
                onChange={(e) => setParticipantName(e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-900 focus:outline-teal-500"
                placeholder="Enter your name..."
              />
            </div>

            {/* Action Buttons */}
            <div className="pt-2 flex flex-col sm:flex-row gap-3">
              {currentRole === 'patient' ? (
                <button
                  onClick={handleStartPatientConsultation}
                  className="flex-1 py-3.5 bg-teal-600 hover:bg-teal-700 text-white font-extrabold text-xs uppercase tracking-wider rounded-2xl transition-all shadow-md shadow-teal-600/20 flex items-center justify-center gap-2 cursor-pointer active:scale-98"
                >
                  <Video className="w-4 h-4" />
                  <span>Start Doctor Consultation</span>
                </button>
              ) : (
                <button
                  onClick={handleStartPatientConsultation}
                  className="flex-1 py-3.5 bg-teal-600 hover:bg-teal-700 text-white font-extrabold text-xs uppercase tracking-wider rounded-2xl transition-all shadow-md shadow-teal-600/20 flex items-center justify-center gap-2 cursor-pointer active:scale-98"
                >
                  <Video className="w-4 h-4" />
                  <span>Host New Consultation</span>
                </button>
              )}
            </div>
          </div>

          {/* Right 5 Cols: Join Existing Room & Privacy Info */}
          <div className="lg:col-span-5 space-y-6">
            
            {/* Join by ID Box */}
            <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-xs space-y-4">
              <div className="flex items-center gap-2 text-slate-900 font-extrabold text-sm">
                <Stethoscope className="w-4 h-4 text-teal-600" />
                <span>Join with Existing Room ID</span>
              </div>
              <p className="text-xs text-slate-500">
                If the {currentRole === 'doctor' ? 'patient' : 'doctor'} already provided a Consultation ID, paste it below to enter.
              </p>

              <div className="space-y-2">
                <input
                  type="text"
                  value={inputRoomId}
                  onChange={(e) => setInputRoomId(e.target.value.toUpperCase())}
                  placeholder="e.g. RECOVERAI-123456"
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-mono font-bold text-slate-900 uppercase focus:outline-teal-500"
                />

                <button
                  onClick={handleJoinDoctorConsultation}
                  disabled={!inputRoomId.trim()}
                  className="w-full py-3 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-extrabold text-xs uppercase tracking-wider rounded-xl transition-all shadow-xs flex items-center justify-center gap-2 cursor-pointer active:scale-98"
                >
                  <span>Join Consultation</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Privacy & Safety Guarantee */}
            <div className="p-5 bg-gradient-to-br from-teal-50 to-emerald-50 border border-teal-200 rounded-3xl space-y-2.5">
              <div className="flex items-center gap-2 text-teal-900 font-bold text-xs">
                <ShieldCheck className="w-4 h-4 text-teal-600" />
                <span>Privacy & Telehealth Architecture</span>
              </div>
              <ul className="text-[11px] text-teal-800 space-y-1.5 leading-relaxed list-disc list-inside">
                <li>Real-time peer-to-peer WebRTC connection.</li>
                <li>Zero audio or video stored on disk or server.</li>
                <li>Camera and microphone are only activated upon your explicit consent.</li>
                <li>Independent of emergency alarm and camera monitoring.</li>
              </ul>
            </div>

          </div>

        </div>
      )}

      {/* ========================================================================= */}
      {/* 2. PERMISSION CHECK SCREEN */}
      {/* ========================================================================= */}
      {sessionState === 'permission_check' && (
        <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-xs max-w-xl mx-auto text-center space-y-6 animate-fadeIn">
          <div className="w-14 h-14 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center mx-auto border border-amber-200">
            <Video className="w-7 h-7" />
          </div>

          <div className="space-y-2">
            <h2 className="text-xl font-black text-slate-900">Device Permissions Required</h2>
            <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
              To start the video consultation, please grant your browser permission to access your camera and microphone.
            </p>
          </div>

          <div className="p-4 bg-slate-50 rounded-2xl text-xs text-slate-600 space-y-2 text-left">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Camera Access</span>
              <span className={`font-bold ${hasCameraPermission ? 'text-emerald-600' : 'text-amber-600'}`}>
                {hasCameraPermission ? 'Granted ✓' : 'Pending Request'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-semibold">Microphone Access</span>
              <span className={`font-bold ${hasMicPermission ? 'text-emerald-600' : 'text-amber-600'}`}>
                {hasMicPermission ? 'Granted ✓' : 'Pending Request'}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-center gap-3">
            <button
              onClick={handleResetToLobby}
              className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-xs transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={currentRole === 'patient' ? handleStartPatientConsultation : handleJoinDoctorConsultation}
              className="px-6 py-2.5 bg-teal-600 hover:bg-teal-700 text-white font-extrabold rounded-xl text-xs uppercase tracking-wider transition-all shadow-md cursor-pointer"
            >
              Grant Permissions & Proceed
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 3. WAITING FOR PEER TO JOIN SCREEN */}
      {/* ========================================================================= */}
      {sessionState === 'waiting' && (
        <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-xs max-w-2xl mx-auto space-y-6 text-center animate-fadeIn">
          
          <div className="w-16 h-16 bg-teal-50 border border-teal-200 rounded-3xl flex items-center justify-center mx-auto text-teal-600">
            <RefreshCw className="w-8 h-8 animate-spin text-teal-600" />
          </div>

          <div className="space-y-2">
            <span className="text-xs font-bold text-teal-600 uppercase tracking-wider">
              Session Initialized
            </span>
            <h2 className="text-2xl font-black text-slate-900">
              Waiting for {currentRole === 'patient' ? 'doctor' : 'patient'} to join...
            </h2>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Please share the Consultation Room ID with the doctor. Once they join, the video connection will establish automatically.
            </p>
          </div>

          {/* Room ID Banner */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl max-w-sm mx-auto flex items-center justify-between gap-3">
            <div className="text-left">
              <span className="text-[10px] text-slate-400 font-bold uppercase block">Room ID</span>
              <span className="font-mono text-base font-black text-slate-900">{roomId}</span>
            </div>
            <button
              onClick={handleCopyRoomId}
              className="px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              {copiedRoomId ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedRoomId ? 'Copied' : 'Copy'}</span>
            </button>
          </div>

          {/* Local Camera Self-Preview */}
          <div className="relative w-64 h-44 mx-auto rounded-2xl overflow-hidden bg-slate-950 border border-slate-200 shadow-sm">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover ${!cameraEnabled ? 'hidden' : ''}`}
            />
            {!cameraEnabled && (
              <div className="w-full h-full flex flex-col items-center justify-center text-slate-400 text-xs">
                <VideoOff className="w-8 h-8 mb-1 opacity-50" />
                <span>Camera Off</span>
              </div>
            )}
            <div className="absolute bottom-2 left-2 px-2 py-0.5 bg-slate-900/80 backdrop-blur-xs text-white text-[10px] font-bold rounded-md">
              Self Preview ({participantName})
            </div>
          </div>

          {/* Cancel Button */}
          <div className="pt-2">
            <button
              onClick={handleEndCall}
              className="px-6 py-2.5 bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold rounded-xl text-xs transition-colors cursor-pointer"
            >
              Cancel Session
            </button>
          </div>

        </div>
      )}

      {/* ========================================================================= */}
      {/* 4. ACTIVE VIDEO CONFERENCE VIEW (IN_CALL) */}
      {/* ========================================================================= */}
      {sessionState === 'in_call' && (
        <div className="space-y-4 animate-fadeIn">
          
          {/* Status Bar */}
          <div className="bg-white px-5 py-3 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className={`w-3 h-3 rounded-full ${
                  connectionStatus === 'connected' ? 'bg-emerald-500 animate-pulse' :
                  connectionStatus === 'connecting' ? 'bg-amber-500 animate-ping' : 'bg-rose-500'
                }`} />
                <span className="text-xs font-extrabold text-slate-900 capitalize">
                  Status: {connectionStatus === 'connected' ? 'Connected 🟢' : connectionStatus === 'connecting' ? 'Establishing P2P WebRTC 🟡' : 'Reconnecting 🔴'}
                </span>
              </div>
              <span className="text-slate-300">|</span>
              <span className="text-xs font-mono font-bold text-slate-600">Room: {roomId}</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyRoomId}
                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded-lg text-xs font-semibold text-slate-700 flex items-center gap-1 cursor-pointer"
              >
                {copiedRoomId ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                <span>{copiedRoomId ? 'Copied' : 'Share ID'}</span>
              </button>
              <div className="text-xs font-bold text-slate-700 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-teal-600" />
                <span className="font-mono">{formatDuration(callDuration)}</span>
              </div>
            </div>
          </div>

          {/* DUAL VIDEO GRID */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            
            {/* TILE 1: DOCTOR VIDEO TILE */}
            <div className="relative bg-slate-950 rounded-3xl overflow-hidden aspect-video border border-slate-800 shadow-lg flex flex-col justify-between p-4">
              
              {/* Doctor Video Stream */}
              {currentRole === 'doctor' ? (
                // If current user is doctor -> show local video stream in Doctor tile
                <>
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`absolute inset-0 w-full h-full object-cover ${!cameraEnabled ? 'hidden' : ''}`}
                  />
                  {!cameraEnabled && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 bg-slate-900">
                      <div className="w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center mb-2 text-teal-400 font-black text-xl">
                        DR
                      </div>
                      <span className="text-xs font-bold">Camera Off</span>
                    </div>
                  )}
                </>
              ) : (
                // If current user is patient -> show remote video stream in Doctor tile
                <>
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  {connectionStatus !== 'connected' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 bg-slate-900/90 z-10 space-y-2">
                      <RefreshCw className="w-8 h-8 animate-spin text-teal-400" />
                      <span className="text-xs font-bold">Waiting for Doctor Stream...</span>
                    </div>
                  )}
                </>
              )}

              {/* Top Doctor Badge */}
              <div className="relative z-20 flex items-center justify-between">
                <div className="flex items-center gap-2 px-3 py-1 bg-slate-900/80 backdrop-blur-md rounded-xl text-white text-xs font-bold border border-white/10">
                  <Stethoscope className="w-3.5 h-3.5 text-teal-400" />
                  <span>{currentRole === 'doctor' ? `${participantName} (You)` : peerName || 'Dr. Vikramaditya Rao'}</span>
                </div>
                {currentRole === 'doctor' && !micEnabled && (
                  <div className="px-2.5 py-1 bg-rose-600/90 text-white text-[11px] font-bold rounded-xl flex items-center gap-1">
                    <MicOff className="w-3 h-3" />
                    <span>Microphone Off</span>
                  </div>
                )}
              </div>

              {/* Bottom Doctor Info */}
              <div className="relative z-20 flex items-center justify-between text-[11px] text-white/80">
                <span className="px-2 py-0.5 bg-black/60 backdrop-blur-xs rounded-md">
                  Consulting Surgeon
                </span>
                <span className="px-2 py-0.5 bg-teal-500/30 text-teal-300 font-mono rounded-md">
                  Doctor Video
                </span>
              </div>
            </div>

            {/* TILE 2: PATIENT VIDEO TILE */}
            <div className="relative bg-slate-950 rounded-3xl overflow-hidden aspect-video border border-slate-800 shadow-lg flex flex-col justify-between p-4">
              
              {/* Patient Video Stream */}
              {currentRole === 'patient' ? (
                // If current user is patient -> show local video in Patient tile
                <>
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`absolute inset-0 w-full h-full object-cover ${!cameraEnabled ? 'hidden' : ''}`}
                  />
                  {!cameraEnabled && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 bg-slate-900">
                      <div className="w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center mb-2 text-emerald-400 font-black text-xl">
                        PT
                      </div>
                      <span className="text-xs font-bold">Camera Off</span>
                    </div>
                  )}
                </>
              ) : (
                // If current user is doctor -> show remote stream in Patient tile
                <>
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  {connectionStatus !== 'connected' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 bg-slate-900/90 z-10 space-y-2">
                      <RefreshCw className="w-8 h-8 animate-spin text-emerald-400" />
                      <span className="text-xs font-bold">Waiting for Patient Stream...</span>
                    </div>
                  )}
                </>
              )}

              {/* Top Patient Badge */}
              <div className="relative z-20 flex items-center justify-between">
                <div className="flex items-center gap-2 px-3 py-1 bg-slate-900/80 backdrop-blur-md rounded-xl text-white text-xs font-bold border border-white/10">
                  <User className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{currentRole === 'patient' ? `${participantName} (You)` : peerName || currentPatient?.name || 'Patient'}</span>
                </div>
                {currentRole === 'patient' && !micEnabled && (
                  <div className="px-2.5 py-1 bg-rose-600/90 text-white text-[11px] font-bold rounded-xl flex items-center gap-1">
                    <MicOff className="w-3 h-3" />
                    <span>Microphone Off</span>
                  </div>
                )}
              </div>

              {/* Bottom Patient Info */}
              <div className="relative z-20 flex items-center justify-between text-[11px] text-white/80">
                <span className="px-2 py-0.5 bg-black/60 backdrop-blur-xs rounded-md">
                  {currentPatient?.surgeryType || 'Post-Op Knee'} • Day {currentPatient?.recoveryDay || 3}
                </span>
                <span className="px-2 py-0.5 bg-emerald-500/30 text-emerald-300 font-mono rounded-md">
                  Patient Video
                </span>
              </div>
            </div>

          </div>

          {/* CALL CONTROLS BAR */}
          <div className="bg-slate-900 text-white p-4 rounded-3xl shadow-xl flex flex-wrap items-center justify-between gap-4 border border-slate-800">
            
            {/* Left: Device Status */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-300">
                <span>Microphone:</span>
                <span className={micEnabled ? 'text-emerald-400 font-extrabold' : 'text-rose-400 font-extrabold'}>
                  {micEnabled ? 'ON' : 'OFF (Muted)'}
                </span>
              </div>
              <span className="text-slate-700">|</span>
              <div className="flex items-center gap-2 text-xs font-bold text-slate-300">
                <span>Camera:</span>
                <span className={cameraEnabled ? 'text-emerald-400 font-extrabold' : 'text-rose-400 font-extrabold'}>
                  {cameraEnabled ? 'ON' : 'OFF'}
                </span>
              </div>
            </div>

            {/* Center Controls: Mic, Camera, End Call */}
            <div className="flex items-center gap-3 mx-auto sm:mx-0">
              
              {/* Mic Toggle Button */}
              <button
                onClick={toggleMicrophone}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-extrabold transition-all cursor-pointer ${
                  micEnabled
                    ? 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700'
                    : 'bg-rose-600 hover:bg-rose-500 text-white shadow-md shadow-rose-600/30'
                }`}
                title={micEnabled ? 'Mute Microphone' : 'Unmute Microphone'}
              >
                {micEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                <span>{micEnabled ? 'Mute' : 'Unmute'}</span>
              </button>

              {/* Camera Toggle Button */}
              <button
                onClick={toggleCamera}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-extrabold transition-all cursor-pointer ${
                  cameraEnabled
                    ? 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700'
                    : 'bg-rose-600 hover:bg-rose-500 text-white shadow-md shadow-rose-600/30'
                }`}
                title={cameraEnabled ? 'Turn Camera Off' : 'Turn Camera On'}
              >
                {cameraEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
                <span>{cameraEnabled ? 'Camera ON' : 'Camera OFF'}</span>
              </button>

              {/* End Call Button */}
              <button
                onClick={handleEndCall}
                className="flex items-center gap-2 px-5 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-black text-xs uppercase tracking-wider rounded-2xl transition-all shadow-lg shadow-rose-600/30 active:scale-95 cursor-pointer"
                title="End Consultation"
              >
                <PhoneOff className="w-4 h-4" />
                <span>End Call</span>
              </button>

            </div>

            {/* Right: Privacy Indicator */}
            <div className="hidden lg:flex items-center gap-1.5 text-[11px] text-teal-400 font-bold bg-teal-950/80 px-3 py-1.5 rounded-xl border border-teal-800/60">
              <ShieldCheck className="w-3.5 h-3.5 text-teal-400" />
              <span>Zero Video Recorded</span>
            </div>

          </div>

        </div>
      )}

      {/* ========================================================================= */}
      {/* 5. CALL ENDED SUMMARY SCREEN */}
      {/* ========================================================================= */}
      {sessionState === 'ended' && (
        <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-xs max-w-lg mx-auto text-center space-y-6 animate-fadeIn">
          
          <div className="w-16 h-16 bg-slate-100 rounded-3xl flex items-center justify-center mx-auto text-slate-700">
            <Check className="w-8 h-8 text-teal-600" />
          </div>

          <div className="space-y-2">
            <h2 className="text-2xl font-black text-slate-900">Consultation Completed</h2>
            <p className="text-xs text-slate-500">
              The video session has ended and all camera and audio streams have been completely disconnected and released.
            </p>
          </div>

          <div className="p-4 bg-slate-50 rounded-2xl text-xs text-slate-600 space-y-2 text-left">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Total Duration:</span>
              <span className="font-mono font-bold text-slate-900">{formatDuration(callDuration)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Consultation ID:</span>
              <span className="font-mono font-bold text-slate-900">{roomId}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Data Recording:</span>
              <span className="font-bold text-emerald-600">None (0 MB Recorded)</span>
            </div>
          </div>

          <div className="pt-2">
            <button
              onClick={handleResetToLobby}
              className="px-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-extrabold text-xs uppercase tracking-wider rounded-2xl transition-all shadow-md cursor-pointer"
            >
              Start Another Consultation
            </button>
          </div>

        </div>
      )}

    </div>
  );
};

export default DoctorConsultationPage;
