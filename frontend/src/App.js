import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import axios from 'axios';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;
const WS_URL = BACKEND_URL.replace('https://', 'wss://').replace('http://', 'ws://');

function App() {
  const [roomId, setRoomId] = useState('');
  const [currentRoom, setCurrentRoom] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [remoteAudioLevel, setRemoteAudioLevel] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [activeUsers, setActiveUsers] = useState(0);
  const [volume, setVolume] = useState(80);
  const [rooms, setRooms] = useState([]);
  const [showRooms, setShowRooms] = useState(false);
  const [peerConnectionState, setPeerConnectionState] = useState('new');

  // WebRTC and WebSocket refs
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const websocketRef = useRef(null);
  const localAudioRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const remoteAnalyserRef = useRef(null);

  // WebRTC configuration
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // Generate random room ID
  const generateRoomId = () => {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  };

  // Load existing rooms
  const loadRooms = async () => {
    try {
      const response = await axios.get(`${API}/rooms`);
      setRooms(response.data);
    } catch (error) {
      console.error('Error loading rooms:', error);
    }
  };

  // Audio level monitoring
  const monitorAudioLevel = (stream, setLevel) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }

    const audioContext = audioContextRef.current;
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    
    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    source.connect(analyser);

    const updateLevel = () => {
      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b) / bufferLength;
      setLevel(Math.min(100, (average / 255) * 100));
      
      if (stream.active) {
        requestAnimationFrame(updateLevel);
      }
    };

    updateLevel();
  };

  // Initialize WebRTC
  const initWebRTC = async () => {
    try {
      // Get user media
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      
      localStreamRef.current = stream;
      
      // Monitor local audio level
      monitorAudioLevel(stream, setAudioLevel);

      // Create peer connection
      const peerConnection = new RTCPeerConnection(rtcConfig);
      peerConnectionRef.current = peerConnection;

      // Add local stream to peer connection
      stream.getTracks().forEach(track => {
        peerConnection.addTrack(track, stream);
      });

      // Handle remote stream
      peerConnection.ontrack = (event) => {
        const [remoteStream] = event.streams;
        remoteStreamRef.current = remoteStream;
        
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.volume = volume / 100;
        }

        // Monitor remote audio level
        monitorAudioLevel(remoteStream, setRemoteAudioLevel);
      };

      // Handle ICE candidates
      peerConnection.onicecandidate = (event) => {
        if (event.candidate && websocketRef.current) {
          websocketRef.current.send(JSON.stringify({
            type: 'ice-candidate',
            candidate: event.candidate
          }));
        }
      };

      // Handle connection state changes
      peerConnection.onconnectionstatechange = () => {
        setConnectionStatus(peerConnection.connectionState);
        if (peerConnection.connectionState === 'connected') {
          setIsConnected(true);
        } else if (peerConnection.connectionState === 'disconnected' || 
                   peerConnection.connectionState === 'failed') {
          setIsConnected(false);
        }
      };

      // Handle signaling state changes
      peerConnection.onsignalingstatechange = () => {
        console.log('Signaling state changed:', peerConnection.signalingState);
        setPeerConnectionState(peerConnection.signalingState);
      };

      // Handle ICE connection state changes
      peerConnection.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', peerConnection.iceConnectionState);
      };

      // Handle ICE gathering state changes
      peerConnection.onicegatheringstatechange = () => {
        console.log('ICE gathering state:', peerConnection.iceGatheringState);
      };

      return true;
    } catch (error) {
      console.error('Error initializing WebRTC:', error);
      alert('Не удалось получить доступ к микрофону. Проверьте разрешения.');
      return false;
    }
  };

  // Connect to room
  const connectToRoom = async () => {
    if (!roomId.trim()) {
      setRoomId(generateRoomId());
      return;
    }

    try {
      // First, create room in database if it doesn't exist
      try {
        await axios.post(`${API}/rooms`, {
          name: `Room ${roomId}`,
          id: roomId
        });
        console.log('Room created/verified in database');
      } catch (error) {
        if (error.response?.status === 409) {
          console.log('Room already exists');
        } else {
          console.error('Error creating room:', error);
        }
      }

      // Initialize WebRTC first
      const webrtcInitialized = await initWebRTC();
      if (!webrtcInitialized) return;

      // Connect to WebSocket
      const ws = new WebSocket(`${WS_URL}/api/ws/${roomId}`);
      websocketRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected');
        ws.send(JSON.stringify({ type: 'join', room_id: roomId }));
      };

      ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        
        switch (message.type) {
          case 'room_info':
            setCurrentRoom(message.data);
            setActiveUsers(message.data.active_users);
            break;
            
          case 'user_joined':
            setActiveUsers(message.total_users);
            // Only create offer if we're the first user (initiator)
            if (peerConnectionRef.current && peerConnectionRef.current.connectionState === 'new') {
              try {
                console.log('Creating offer as initiator');
                const offer = await peerConnectionRef.current.createOffer();
                await peerConnectionRef.current.setLocalDescription(offer);
                setPeerConnectionState('have-local-offer');
                ws.send(JSON.stringify({
                  type: 'offer',
                  offer: offer
                }));
              } catch (error) {
                console.error('Error creating offer:', error);
              }
            }
            break;
            
          case 'user_left':
            setActiveUsers(message.total_users);
            break;
            
          case 'offer':
            if (peerConnectionRef.current) {
              try {
                console.log('Received offer, setting remote description');
                await peerConnectionRef.current.setRemoteDescription(message.offer);
                setPeerConnectionState('have-remote-offer');
                
                console.log('Creating answer');
                const answer = await peerConnectionRef.current.createAnswer();
                await peerConnectionRef.current.setLocalDescription(answer);
                setPeerConnectionState('stable');
                
                ws.send(JSON.stringify({
                  type: 'answer',
                  answer: answer
                }));
              } catch (error) {
                console.error('Error handling offer:', error);
              }
            }
            break;
            
          case 'answer':
            if (peerConnectionRef.current && peerConnectionRef.current.signalingState === 'have-local-offer') {
              try {
                console.log('Received answer, setting remote description');
                await peerConnectionRef.current.setRemoteDescription(message.answer);
                setPeerConnectionState('stable');
              } catch (error) {
                console.error('Error handling answer:', error);
              }
            } else {
              console.log('Ignoring answer - wrong signaling state:', peerConnectionRef.current?.signalingState);
            }
            break;
            
          case 'ice-candidate':
            if (peerConnectionRef.current && peerConnectionRef.current.remoteDescription) {
              try {
                await peerConnectionRef.current.addIceCandidate(message.candidate);
              } catch (error) {
                console.error('Error adding ICE candidate:', error);
              }
            } else {
              console.log('Ignoring ICE candidate - no remote description');
            }
            break;
        }
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected');
        setIsConnected(false);
        setConnectionStatus('disconnected');
        // Reset WebRTC for potential reconnection
        resetWebRTC();
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setConnectionStatus('error');
        // Reset WebRTC on error
        resetWebRTC();
      };

    } catch (error) {
      console.error('Error connecting to room:', error);
      alert('Ошибка подключения к комнате');
    }
  };

  // Disconnect from room
  const disconnectFromRoom = () => {
    // Close WebSocket
    if (websocketRef.current) {
      websocketRef.current.close();
      websocketRef.current = null;
    }

    // Close peer connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    // Stop local stream
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    // Reset state
    setIsConnected(false);
    setConnectionStatus('disconnected');
    setCurrentRoom(null);
    setActiveUsers(0);
    setPeerConnectionState('new');
  };

  // Reset WebRTC for reconnection
  const resetWebRTC = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    setPeerConnectionState('new');
  };

  // Toggle mute
  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  // Update volume
  const updateVolume = (newVolume) => {
    setVolume(newVolume);
    if (remoteAudioRef.current) {
      remoteAudioRef.current.volume = newVolume / 100;
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnectFromRoom();
    };
  }, []);

  return (
    <div className="app">
      <div className="container">
        <div className="header">
          <h1>🎙️ Голосовой чат</h1>
          <p>Общайтесь с друзьями из любой точки мира</p>
        </div>

        <div className="main-content">
          {!isConnected ? (
            <div className="connection-panel">
              <div className="room-input">
                <label>ID комнаты:</label>
                <div className="input-group">
                  <input
                    type="text"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                    placeholder="Введите ID или оставьте пустым"
                    maxLength={6}
                  />
                  <button 
                    className="generate-btn"
                    onClick={() => setRoomId(generateRoomId())}
                  >
                    🎲
                  </button>
                </div>
              </div>
              
              <button className="connect-btn" onClick={connectToRoom}>
                {roomId ? `Подключиться к ${roomId}` : 'Создать новую комнату'}
              </button>
              
              <div className="room-actions">
                <button className="secondary-btn" onClick={() => {
                  setShowRooms(!showRooms);
                  if (!showRooms) loadRooms();
                }}>
                  {showRooms ? 'Скрыть комнаты' : 'Показать существующие комнаты'}
                </button>
              </div>
              
              {showRooms && (
                <div className="rooms-list">
                  <h4>Существующие комнаты:</h4>
                  {rooms.length === 0 ? (
                    <p>Комнат пока нет. Создайте первую!</p>
                  ) : (
                    <div className="rooms-grid">
                      {rooms.map(room => (
                        <div key={room.id} className="room-item">
                          <span className="room-id">{room.id}</span>
                          <span className="room-name">{room.name}</span>
                          <span className="room-users">👥 {room.active_users}</span>
                          <button 
                            className="join-room-btn"
                            onClick={() => {
                              setRoomId(room.id);
                              setShowRooms(false);
                            }}
                          >
                            Присоединиться
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              
              <div className="instructions">
                <p>💡 <strong>Как использовать:</strong></p>
                <p>1. Введите ID комнаты или создайте новую</p>
                <p>2. Поделитесь ID с другом</p>
                <p>3. Наслаждайтесь общением!</p>
              </div>
            </div>
          ) : (
            <div className="voice-controls">
              <div className="room-info">
                <h3>Комната: {roomId}</h3>
                <div className="status-indicators">
                  <div className={`status-dot ${connectionStatus}`}></div>
                  <span>Статус: {connectionStatus === 'connected' ? 'Подключен' : 'Подключение...'}</span>
                  <span>👥 Участников: {activeUsers}</span>
                  <span>🔗 WebRTC: {peerConnectionState}</span>
                </div>
              </div>

              <div className="audio-controls">
                <button 
                  className={`control-btn ${isMuted ? 'muted' : ''}`}
                  onClick={toggleMute}
                >
                  {isMuted ? '🔇' : '🎤'}
                  <span>{isMuted ? 'Включить микрофон' : 'Выключить микрофон'}</span>
                </button>

                <div className="volume-control">
                  <label>🔊 Громкость: {volume}%</label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={volume}
                    onChange={(e) => updateVolume(parseInt(e.target.value))}
                    className="volume-slider"
                  />
                </div>
              </div>

              <div className="audio-levels">
                <div className="level-indicator">
                  <label>Ваш микрофон:</label>
                  <div className="level-bar">
                    <div 
                      className="level-fill local" 
                      style={{ width: `${audioLevel}%` }}
                    ></div>
                  </div>
                  <span>{Math.round(audioLevel)}%</span>
                </div>

                <div className="level-indicator">
                  <label>Входящий звук:</label>
                  <div className="level-bar">
                    <div 
                      className="level-fill remote" 
                      style={{ width: `${remoteAudioLevel}%` }}
                    ></div>
                  </div>
                  <span>{Math.round(remoteAudioLevel)}%</span>
                </div>
              </div>

              <button className="disconnect-btn" onClick={disconnectFromRoom}>
                Отключиться
              </button>
            </div>
          )}
        </div>

        {/* Hidden audio element for remote stream */}
        <audio ref={remoteAudioRef} autoPlay playsInline />
      </div>
    </div>
  );
}

export default App;