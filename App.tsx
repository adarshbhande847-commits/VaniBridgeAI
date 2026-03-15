import React, { useState, useRef, useEffect } from 'react';
import { TargetLanguage, ProcessingState, AppStep, InputMode, Voice } from './types';
import { detectAndTranscribe, translateText, generateSpeechData, generateGenericTranscript, analyzeUrl, generateSRT, setCustomApiKey } from './services/geminiService';
import { UploadIcon, PlayIcon, PauseIcon, LoadingSpinner, YouTubeIcon, LinkIcon, VolumeIcon, DownloadIcon, SkipBackIcon, SkipForwardIcon, SubtitleIcon } from './components/Icon';
import { ProcessingLog } from './components/ProcessingLog';
import { auth, db, loginWithGoogle, logout, collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp, onAuthStateChanged, User } from './firebase';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const MAX_FILE_SIZE = 2000 * 1024 * 1024; 

// Design-specific Volume Control
const VolumeControl: React.FC<{ volume: number; onChange: (val: number) => void }> = ({ volume, onChange }) => (
  <div className="flex items-center gap-2 group">
     <button 
       onClick={() => onChange(volume === 0 ? 1 : 0)}
       className="text-slate-400 hover:text-cyan-300 transition-colors focus:outline-none"
     >
       <VolumeIcon />
     </button>
     <div className="w-20 h-1 bg-slate-700 rounded-full relative overflow-hidden group hover:bg-slate-600 transition-colors">
        <div 
          className="absolute top-0 left-0 h-full bg-cyan-400 rounded-full" 
          style={{ width: `${volume * 100}%` }}
        ></div>
        <input 
          type="range" 
          min="0" 
          max="1" 
          step="0.01" 
          value={volume} 
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
     </div>
  </div>
);

const App: React.FC = () => {
  const [targetLang, setTargetLang] = useState<TargetLanguage>(TargetLanguage.HINDI);
  const [selectedVoice, setSelectedVoice] = useState<Voice>(Voice.PUCK);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [previewMode, setPreviewMode] = useState<'dubbed' | 'original'>('dubbed');
  const [state, setState] = useState<ProcessingState>({
    step: AppStep.UPLOAD,
    inputMode: InputMode.FILE,
    isMockMode: true,
    videoFile: null,
    youtubeUrl: '',
    youtubeId: null,
    videoUrl: null,
    detectedLanguage: null,
    transcript: '',
    translatedText: '',
    audioUrl: null,
    isProcessing: false,
    progress: 0,
    logs: [],
    statusMessage: "Ready"
  });

  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [volume, setVolume] = useState<number>(1.0);
  const [currentPlaybackTime, setCurrentPlaybackTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isDownloadingVideo, setIsDownloadingVideo] = useState<boolean>(false);
  const [user, setUser] = useState<User | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [apiKeyInput, setApiKeyInput] = useState<string>(localStorage.getItem('gemini_api_key') || '');
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const ffmpegRef = useRef(new FFmpeg());

  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const currentTimeRef = useRef<number>(0);
  const isSeekingRef = useRef<boolean>(false);

  // Initialize AudioContext and FFmpeg
  useEffect(() => {
    const loadFFmpeg = async () => {
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
      const ffmpeg = ffmpegRef.current;
      
      // Add message listener for progress
      ffmpeg.on('log', ({ message }) => {
        console.log("FFmpeg Log:", message);
      });

      try {
        await ffmpeg.load({
          coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        });
        setFfmpegLoaded(true);
      } catch (err) {
        console.error("Failed to load FFmpeg:", err);
      }
    };

    loadFFmpeg();

    if (apiKeyInput) {
      setCustomApiKey(apiKeyInput);
    }

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
    });
    
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const gainNode = ctx.createGain();
    gainNode.gain.value = 1.0; 
    gainNode.connect(ctx.destination);
    audioContextRef.current = ctx;
    gainNodeRef.current = gainNode;
    
    return () => { 
      unsubscribe();
      audioContextRef.current?.close(); 
    };
  }, []);

  // Fetch History
  useEffect(() => {
    if (!user) {
      setHistory([]);
      return;
    }
    
    const q = query(
      collection(db, 'lessons'),
      where('uid', '==', user.uid),
      orderBy('createdAt', 'desc')
    );
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setHistory(docs);
    }, (error) => {
      console.error("History fetch error:", error);
    });
    
    return () => unsubscribe();
  }, [user]);

  // YouTube Message Listener for Sync
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== "https://www.youtube.com") return;
      try {
        const data = JSON.parse(event.data);
        if (data.event === 'infoDelivery' && data.info) {
          if (data.info.currentTime !== undefined) {
            currentTimeRef.current = data.info.currentTime;
            setCurrentPlaybackTime(data.info.currentTime);
          }
          if (data.info.duration !== undefined) {
            setDuration(data.info.duration);
          }
          if (data.info.playerState === 0) { // Ended
            setIsPlaying(false);
          }
        }
      } catch (e) {}
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Audio Mixing Logic
  useEffect(() => {
    // Only apply complex mixing if we have a result
    if (state.step !== AppStep.RESULT) {
       if (videoRef.current) {
          videoRef.current.muted = false;
          videoRef.current.volume = volume;
       }
       return;
    }

    const isDubbedMode = previewMode === 'dubbed';
    
    // 1. Gain Node (TTS Audio)
    if (gainNodeRef.current && audioContextRef.current) {
        const targetGain = isDubbedMode ? volume : 0;
        // Ensure context is running
        if (audioContextRef.current.state === 'suspended' && isPlaying) {
          audioContextRef.current.resume();
        }
        gainNodeRef.current.gain.setTargetAtTime(targetGain, audioContextRef.current.currentTime, 0.05);
    }
    // 2. Video Element
    if (videoRef.current) {
        videoRef.current.muted = isDubbedMode; 
        videoRef.current.volume = volume;
    }
    // 3. YouTube
    if (state.youtubeId && iframeRef.current?.contentWindow) {
        const muteCommand = isDubbedMode ? 'mute' : 'unMute';
        iframeRef.current.contentWindow.postMessage(JSON.stringify({ event: 'command', func: muteCommand, args: [] }), '*');
        iframeRef.current.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'setVolume', args: [volume * 100] }), '*');
    }
  }, [previewMode, volume, state.youtubeId, state.step, isPlaying]);

  // Sync players on mode change
  useEffect(() => {
    if (state.step === AppStep.RESULT && isPlaying) {
      const syncTime = currentTimeRef.current;
      if (previewMode === 'original' && state.youtubeId && iframeRef.current) {
        iframeRef.current.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [syncTime, true] }), '*');
        iframeRef.current.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'playVideo' }), '*');
      } else if (previewMode === 'original' && state.videoUrl && videoRef.current) {
        videoRef.current.currentTime = syncTime;
        videoRef.current.play().catch(e => console.error("Video play failed:", e));
      }
    }
  }, [previewMode, state.step, isPlaying, state.youtubeId, state.videoUrl]);

  const handlePause = React.useCallback(async () => {
    if (audioContextRef.current?.state === 'running') {
      await audioContextRef.current.suspend();
    }
    
    if (videoRef.current) {
      videoRef.current.pause();
    }

    if (state.youtubeId) {
      iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo' }), '*');
    }
    setIsPlaying(false);
  }, [state.youtubeId]);

  // Playback Loop
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isPlaying) {
      interval = setInterval(() => {
        if (videoRef.current && !videoRef.current.paused) {
          currentTimeRef.current = videoRef.current.currentTime;
          if (videoRef.current.duration) setDuration(videoRef.current.duration);
          setCurrentPlaybackTime(currentTimeRef.current);
        } else if (state.youtubeId) {
          // Request update from YouTube API
          iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening' }), '*');
        } else {
          // Dead reckoning for Mock
          currentTimeRef.current = (currentTimeRef.current || 0) + 0.1;
          setCurrentPlaybackTime(currentTimeRef.current);
          if (audioBuffer && currentTimeRef.current >= audioBuffer.duration) {
             handlePause();
             currentTimeRef.current = 0;
          }
        }
      }, 100);
    }
    return () => clearInterval(interval);
  }, [isPlaying, audioBuffer, handlePause, state.youtubeId]);

  // Helpers
  const addLog = (message: string) => {
    setState(prev => ({ ...prev, logs: [...prev.logs, message] }));
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.size > MAX_FILE_SIZE) {
        alert("File size exceeds 2GB.");
        return;
      }
      const url = URL.createObjectURL(file);
      setState(prev => ({
        ...prev,
        videoFile: file,
        videoUrl: url,
        youtubeUrl: '',
        youtubeId: null,
        logs: [`Loaded: ${file.name}`]
      }));
    }
  };

  // ... (Existing audio helper functions: createWavUrl, decodeAudio)
  const createWavUrl = (pcmData: ArrayBuffer): string => {
    const sampleRate = 24000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + pcmData.byteLength, true); 
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); 
    view.setUint16(20, 1, true); 
    view.setUint16(22, numChannels, true); 
    view.setUint32(24, sampleRate, true); 
    view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true); 
    view.setUint16(32, numChannels * (bitsPerSample / 8), true); 
    view.setUint16(34, bitsPerSample, true); 
    writeString(36, 'data');
    view.setUint32(40, pcmData.byteLength, true);
    const blob = new Blob([header, pcmData], { type: 'audio/wav' });
    return URL.createObjectURL(blob);
  };

  const decodeAudio = async (arrayBuffer: ArrayBuffer) => {
    if (!audioContextRef.current) return;
    try {
      const pcmData = new Int16Array(arrayBuffer);
      const buffer = audioContextRef.current.createBuffer(1, pcmData.length, 24000);
      const channelData = buffer.getChannelData(0);
      for (let i = 0; i < pcmData.length; i++) {
        channelData[i] = pcmData[i] / 32768.0;
      }
      setAudioBuffer(buffer);
      setDuration(buffer.duration);
    } catch (e) {
      console.error(e);
      addLog("Error decoding audio.");
    }
  };

  const getYouTubeId = (url: string) => {
    if (!url) return null;
    const cleanUrl = url.trim();

    // Comprehensive regex for various YouTube URL formats:
    // - Standard: https://www.youtube.com/watch?v=dQw4w9WgXcQ
    // - Shortened: https://youtu.be/dQw4w9WgXcQ
    // - Embed: https://www.youtube.com/embed/dQw4w9WgXcQ
    // - Shorts: https://www.youtube.com/shorts/dQw4w9WgXcQ
    // - Live: https://www.youtube.com/live/dQw4w9WgXcQ
    // - Mobile: https://m.youtube.com/watch?v=dQw4w9WgXcQ
    // - With params: https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=4s
    
    const regExp = /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/|live\/)|(?:(?:watch)?\?v(?:i)?=|\&v(?:i)?=))([^#\&\?]*).*/;
    const match = cleanUrl.match(regExp);
    
    const id = (match && match[1].length === 11) ? match[1] : null;
    return id;
  };

  const handleChangeKey = async () => {
     if ((window as any).aistudio) {
        await (window as any).aistudio.openSelectKey();
        addLog("API Key updated. Please try generating again.");
     }
  };

  const startProcessing = async (overrideIsMockMode?: boolean) => {
    // Validation
    if (state.inputMode === InputMode.FILE && !state.videoFile) {
        const msg = "Please upload a video file before generating.";
        addLog(msg);
        setState(p => ({ ...p, statusMessage: "Failed", logs: [...p.logs, msg] }));
        return;
    }
    if (state.inputMode === InputMode.URL && !state.youtubeUrl.trim()) {
        const msg = "Please provide a YouTube URL or MP4 link before generating.";
        addLog(msg);
        setState(p => ({ ...p, statusMessage: "Failed", logs: [...p.logs, msg] }));
        return;
    }

    const isMock = overrideIsMockMode !== undefined ? overrideIsMockMode : state.isMockMode;
    
    // Proactive API Key check if not in mock mode
    if (!isMock && (window as any).aistudio) {
        try {
            const hasKey = await (window as any).aistudio.hasSelectedApiKey();
            if (!hasKey) {
                await (window as any).aistudio.openSelectKey();
                // Proceed assuming selection was successful as per guidelines
            }
        } catch (e) {
            console.warn("API Key check failed:", e);
        }
    }
    
    setState(prev => ({ 
      ...prev, 
      step: AppStep.PROCESSING, 
      isProcessing: true, 
      progress: 0, 
      statusMessage: "Initializing...",
      isMockMode: isMock // Sync the state if overridden
    }));
    setIsPlaying(false);
    currentTimeRef.current = 0;
    setCurrentPlaybackTime(0);
    setPreviewMode('dubbed');

    try {
        let processingFile = state.videoFile;
        // Use local variables to track processing data synchronously
        // This prevents reading stale state during the async operation
        let currentTranscript = "";
        let currentLanguage = "English";

        if (state.inputMode === InputMode.URL) {
            const url = state.youtubeUrl.trim();
            if (!url) throw new Error("Please enter a valid URL.");
            
            const isMp4 = url.toLowerCase().endsWith('.mp4');
            const ytid = getYouTubeId(url);
            
            if (!ytid && !isMp4) {
                throw new Error("Invalid URL. Please provide a valid YouTube link or a direct MP4 URL.");
            }
            
            // Set ID initially and clear previous video file data to avoid conflicts
            setState(p => ({...p, youtubeId: ytid, videoUrl: isMp4 ? url : null, videoFile: null}));

            // 2. Analyze
            setState(p => ({...p, progress: 10, statusMessage: `Analyzing ${isMp4 ? 'MP4' : 'YouTube'} content...`}));
            
            try {
                const analysisResult = await analyzeUrl(url);
                currentTranscript = analysisResult.transcript;
                currentLanguage = analysisResult.language || "English";
            } catch (error) {
                console.warn("URL analysis failed, falling back to generic transcript:", error);
                addLog("URL analysis failed. Generating generic transcript...");
                const genericResult = await generateGenericTranscript();
                currentTranscript = genericResult.transcript;
                currentLanguage = genericResult.language || "English";
            }
            
            // Update state with the results for the next steps
            setState(p => ({
                ...p, 
                transcript: currentTranscript, 
                detectedLanguage: currentLanguage,
            }));
            
            addLog(`Detected Language: ${currentLanguage}`);
            setState(p => ({...p, progress: 60, statusMessage: `Translating from ${currentLanguage}...`}));
        }

        if (state.inputMode === InputMode.FILE) {
             if (!processingFile) throw new Error("No file uploaded.");
             const res = await detectAndTranscribe(processingFile);
             currentTranscript = res.transcript;
             currentLanguage = res.language || "English";
             
             setState(p => ({
                 ...p, 
                 transcript: currentTranscript, 
                 detectedLanguage: currentLanguage, 
                 progress: 60, 
                 statusMessage: `Translating from ${currentLanguage}...`
             }));
             addLog(`Detected Language: ${currentLanguage}`);
        }
        
        // 4. Translate & TTS (Standard Flow)
        if (!currentTranscript) throw new Error("Could not generate transcript from input.");

        const translated = await translateText(currentTranscript, targetLang, currentLanguage);
        setState(p => ({...p, translatedText: translated, progress: 80, statusMessage: "Synthesizing voice..."}));

        const audioData = await generateSpeechData(translated, selectedVoice);
        const wavUrl = createWavUrl(audioData);
        await decodeAudio(audioData);

        setState(p => ({...p, progress: 100, statusMessage: "Finalizing...", audioUrl: wavUrl}));
        await new Promise(r => setTimeout(r, 1000));
        
        // Save to Firebase if logged in
        if (user) {
          try {
            await addDoc(collection(db, 'lessons'), {
              uid: user.uid,
              title: state.videoFile?.name || (state.youtubeId ? `YouTube: ${state.youtubeId}` : "Untitled Lesson"),
              sourceUrl: state.youtubeUrl || "",
              targetLanguage: targetLang,
              transcript: currentTranscript,
              translatedText: translated,
              createdAt: serverTimestamp()
            });
            addLog("Lesson saved to your history.");
          } catch (error) {
            console.error("Error saving lesson:", error);
            addLog("Failed to save lesson to history.");
          }
        }
        
        setState(p => ({...p, step: AppStep.RESULT, isProcessing: false, statusMessage: "Ready"}));

    } catch (e) {
        const err = e as Error;
        console.error(err);
        
        const errMsg = err.message.toLowerCase();
        let status = "Failed";
        let logMsg = `Error: ${err.message}`;

        if (errMsg.includes("permission denied") || errMsg.includes("403") || errMsg.includes("authentication failed") || errMsg.includes("api key") || errMsg.includes("invalid api key") || errMsg.includes("key required") || errMsg.includes("requested entity was not found")) {
            status = "Auth Error";
            logMsg = "Authentication failed or Permission Denied. This often happens if the API key is invalid or lacks necessary permissions. Please select a valid Paid API Key to continue.";
            handleChangeKey();
        } else if (errMsg.includes("video inaccessible") || errMsg.includes("private") || errMsg.includes("restricted") || errMsg.includes("deleted")) {
            status = "Video Error";
            logMsg = `URL Error: ${err.message}. You can try using 'Mock Mode' (Settings) to simulate the process with generic content.`;
        } else if (errMsg.includes("quota") || errMsg.includes("rate limit") || errMsg.includes("429") || errMsg.includes("too many requests")) {
            status = "Rate Limit";
            logMsg = "Rate limit exceeded. Please wait a moment and try again.";
        } else if (errMsg.includes("safety") || errMsg.includes("blocked") || errMsg.includes("content filter")) {
            status = "Safety Block";
            logMsg = "Content blocked by safety filters. Please try a different video.";
        } else if (errMsg.includes("unsupported") || errMsg.includes("mime type") || errMsg.includes("format") || errMsg.includes("invalid file")) {
            status = "Format Error";
            logMsg = "Unsupported file format. Please use a standard video file (MP4, MOV).";
        } else if (errMsg.includes("overloaded") || errMsg.includes("503") || errMsg.includes("busy") || errMsg.includes("internal error")) {
            status = "Server Busy";
            logMsg = "The AI model is currently overloaded. Please try again in a few seconds.";
        } else if (errMsg.includes("failed to fetch") || errMsg.includes("network")) {
            status = "Network Error";
            logMsg = "Network error. Please check your internet connection.";
        }

        addLog(logMsg);
        setState(p => ({ ...p, isProcessing: false, statusMessage: status, logs: [...p.logs, logMsg] }));
    }
  };

  const resetApp = () => {
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.stop(); } catch (e) {}
      sourceNodeRef.current = null;
    }
    setIsPlaying(false);
    setAudioBuffer(null);
    setCurrentPlaybackTime(0);
    currentTimeRef.current = 0;
    setDuration(0);
    setState({
      step: AppStep.UPLOAD,
      inputMode: InputMode.FILE,
      isMockMode: true,
      videoFile: null,
      youtubeUrl: '',
      youtubeId: null,
      videoUrl: null,
      detectedLanguage: null,
      transcript: '',
      translatedText: '',
      audioUrl: null,
      isProcessing: false,
      progress: 0,
      logs: [],
      statusMessage: "Ready"
    });
  };

// Playback Controls
  const formatTime = (s: number) => {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const handleSeek = React.useCallback((time: number) => {
      isSeekingRef.current = true;
      const t = Math.max(0, Math.min(time, duration || 100));
      currentTimeRef.current = t;
      setCurrentPlaybackTime(t);

      if (videoRef.current) videoRef.current.currentTime = t;
      if (state.youtubeId) iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [t, true] }), '*');
      
      // Audio Seek
      if (sourceNodeRef.current) {
          try { sourceNodeRef.current.stop(); } catch(e){}
          sourceNodeRef.current = null;
      }
      if (isPlaying && audioBuffer && state.step === AppStep.RESULT) {
          const src = audioContextRef.current!.createBufferSource();
          src.buffer = audioBuffer;
          src.connect(gainNodeRef.current || audioContextRef.current!.destination);
          src.start(0, t);
          src.onended = () => { 
              sourceNodeRef.current = null;
              if(!isSeekingRef.current) setIsPlaying(false); 
          };
          sourceNodeRef.current = src;
      }
      setTimeout(() => isSeekingRef.current = false, 50);
  }, [duration, isPlaying, audioBuffer, state.step, state.youtubeId]);

  const togglePlayback = React.useCallback(async () => {
      if (isPlaying) {
          await handlePause();
      } else {
          // Reset if at end
          if (duration > 0 && currentTimeRef.current >= duration - 0.1) {
              handleSeek(0);
          }

          if (audioContextRef.current?.state === 'suspended') {
              await audioContextRef.current.resume();
          }
          
          // Start Audio if not already playing or if it was stopped
          if (audioBuffer && !sourceNodeRef.current && state.step === AppStep.RESULT) {
              const src = audioContextRef.current!.createBufferSource();
              src.buffer = audioBuffer;
              src.connect(gainNodeRef.current || audioContextRef.current!.destination);
              src.start(0, currentTimeRef.current);
              src.onended = () => { 
                  sourceNodeRef.current = null;
                  if(!isSeekingRef.current) setIsPlaying(false); 
              };
              sourceNodeRef.current = src;
          }
          
          if (videoRef.current) {
              videoRef.current.play().catch(e => console.error("Video play failed:", e));
          }
          
          if (state.youtubeId) {
              iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [currentTimeRef.current, true] }), '*');
              iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'playVideo' }), '*');
          }
          setIsPlaying(true);
      }
  }, [isPlaying, handlePause, handleSeek, audioBuffer, state.step, state.youtubeId, duration]);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        // Prevent scrolling if not typing in an input
        if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
          e.preventDefault();
          togglePlayback();
        }
      } else if (e.code === 'ArrowLeft') {
        handleSeek(currentTimeRef.current - 5);
      } else if (e.code === 'ArrowRight') {
        handleSeek(currentTimeRef.current + 5);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlayback, handleSeek]);

  const handleReset = () => {
      setState(p => ({...p, step: AppStep.UPLOAD, transcript: '', translatedText: '', audioUrl: null, logs: [], progress: 0, statusMessage: "Ready" }));
      setAudioBuffer(null);
      setCurrentPlaybackTime(0);
      setIsPlaying(false);
  };

  const handleDownloadSRT = (text: string, filename: string) => {
    const srtContent = generateSRT(text);
    const blob = new Blob([srtContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadVideo = async () => {
    if (!state.audioUrl || (!state.youtubeId && !state.videoFile && !state.videoUrl)) {
      alert("Please generate the dubbed audio first and ensure a video is selected.");
      return;
    }

    setIsDownloadingVideo(true);
    addLog("Preparing high-quality video export locally...");

    try {
      if (!ffmpegLoaded) {
        throw new Error("Video processing engine is still loading. Please wait a moment.");
      }

      const ffmpeg = ffmpegRef.current;

      // 1. Get Audio Data
      addLog("Fetching dubbed audio...");
      const audioResponse = await fetch(state.audioUrl);
      const audioBlob = await audioResponse.blob();
      await ffmpeg.writeFile('audio.mp3', await fetchFile(audioBlob));

      // 2. Get Video Data
      addLog("Fetching video source...");
      let videoData: Uint8Array;
      
      if (state.videoFile) {
        videoData = await fetchFile(state.videoFile);
      } else if (state.videoUrl) {
        // Direct MP4 URL
        const videoResponse = await fetch(state.videoUrl);
        const videoBlob = await videoResponse.blob();
        videoData = await fetchFile(videoBlob);
      } else if (state.youtubeId) {
        throw new Error("Direct YouTube downloads are not supported in serverless mode. Please upload the video file directly to use the 'Download Dubbed Video' feature.");
      } else {
        throw new Error("No video source found for merging.");
      }

      await ffmpeg.writeFile('video.mp4', videoData);

      // 3. Run FFmpeg Merge
      addLog("Merging audio and video locally (this happens on your device and is 100% free)...");
      
      // Command: ffmpeg -i video.mp4 -i audio.mp3 -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest output.mp4
      await ffmpeg.exec([
        '-i', 'video.mp4',
        '-i', 'audio.mp3',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-shortest',
        'output.mp4'
      ]);

      const data = await ffmpeg.readFile('output.mp4');
      const dubbedBlob = new Blob([data], { type: 'video/mp4' });
      const dubbedUrl = URL.createObjectURL(dubbedBlob);

      const a = document.createElement('a');
      a.href = dubbedUrl;
      
      let downloadName = "VaniBridge_Dubbed_Video.mp4";
      if (state.videoFile) downloadName = `VaniBridge_Dubbed_${state.videoFile.name.split('.')[0]}.mp4`;
      
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(dubbedUrl);

      addLog("Download complete! Enjoy your localized video.");
    } catch (error) {
      console.error("Merge error:", error);
      addLog(`Error: ${error instanceof Error ? error.message : "Failed to merge video locally"}`);
      alert(error instanceof Error ? error.message : "Failed to merge video locally");
    } finally {
      setIsDownloadingVideo(false);
    }
  };

  return (
    <div className="min-h-screen text-slate-100 overflow-x-hidden selection:bg-cyan-500/30">
      
      {/* Dynamic Background Elements */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="halftone w-[800px] h-[800px] rounded-full opacity-20 blur-3xl -top-40 -left-40 absolute animate-pulse"></div>
        <div className="halftone w-[600px] h-[600px] rounded-full opacity-20 blur-3xl bottom-0 -right-20 absolute"></div>
      </div>

      <header className="relative z-10 border-b border-white/5 bg-[#0b1020]/80 backdrop-blur-md sticky top-0">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
             <div className="w-10 h-10 rounded-xl glass flex items-center justify-center text-cyan-300 shadow-[0_0_15px_rgba(110,231,240,0.3)]">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3z"/><path d="M12 7l4 4H8l4-4zm0 8v4m-4-4h8"/></svg>
             </div>
             <div>
                <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-cyan-200 to-violet-300 bg-clip-text text-transparent">VaniBridge</h1>
                <p className="text-xs text-slate-400 font-medium tracking-wide">AI VIDEO LOCALIZATION</p>
             </div>
          </div>
          <div className="flex items-center gap-4">
             {user ? (
               <div className="flex items-center gap-3">
                 <button 
                   onClick={() => setShowHistory(!showHistory)}
                   className="text-xs font-bold text-slate-400 hover:text-cyan-300 transition-colors"
                 >
                   History ({history.length})
                 </button>
                 <div className="flex items-center gap-2">
                   <img src={user.photoURL || ""} alt={user.displayName || ""} className="w-8 h-8 rounded-full border border-white/10" />
                   <button onClick={logout} className="text-xs font-bold text-red-400 hover:text-red-300">Logout</button>
                   <button 
                     onClick={() => setShowSettings(true)}
                     className="hidden sm:flex p-2 rounded-lg hover:bg-white/5 text-slate-400 transition-colors"
                     title="Settings"
                   >
                     <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                   </button>
                 </div>
               </div>
             ) : (
               <button 
                 onClick={async () => {
                   if (isLoggingIn) return;
                   setIsLoggingIn(true);
                   try {
                     await loginWithGoogle();
                   } catch (e) {
                     // Error handled in firebase.ts
                   } finally {
                     setIsLoggingIn(false);
                   }
                 }}
                 disabled={isLoggingIn}
                 className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold hover:bg-white/10 transition-all disabled:opacity-50"
               >
                 {isLoggingIn ? 'Logging in...' : 'Login'}
               </button>
             )}
             <button 
                onClick={() => setShowSettings(true)}
                className="p-2 rounded-lg hover:bg-white/5 text-slate-400 transition-colors sm:hidden"
             >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
             </button>
             <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 backdrop-blur-sm">
                <span className={`status-dot ${state.isProcessing ? 'processing animate-pulse' : 'live'}`}></span>
                <span className="text-xs font-medium text-slate-300">{state.isProcessing ? 'Processing' : 'Live Inference'}</span>
             </div>
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-7xl mx-auto px-6 py-8">
        {showHistory && (
          <section className="glass rounded-2xl p-6 mb-8 animate-fadeIn">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-white">Lesson History</h2>
              <button onClick={() => setShowHistory(false)} className="text-slate-400 hover:text-white">Close</button>
            </div>
            {history.length === 0 ? (
              <p className="text-slate-500 text-center py-8">No lessons saved yet. Generate your first regional lesson!</p>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {history.map((item) => (
                  <div key={item.id} className="bg-white/5 border border-white/10 rounded-xl p-4 hover:border-cyan-500/30 transition-all group">
                    <div className="flex justify-between items-start mb-2">
                      <h3 className="text-sm font-bold text-slate-200 truncate pr-4">{item.title}</h3>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400">{item.targetLanguage}</span>
                    </div>
                    <p className="text-[10px] text-slate-500 mb-3">
                      {item.createdAt?.toDate ? item.createdAt.toDate().toLocaleDateString() : 'Just now'}
                    </p>
                    <div className="flex gap-2">
                      <button 
                        onClick={() => {
                          setState(p => ({
                            ...p,
                            step: AppStep.RESULT,
                            transcript: item.transcript,
                            translatedText: item.translatedText,
                            detectedLanguage: 'English',
                            statusMessage: 'Ready'
                          }));
                          setTargetLang(item.targetLanguage);
                          setShowHistory(false);
                          addLog(`Loaded lesson: ${item.title}`);
                        }}
                        className="text-[10px] font-bold text-cyan-400 hover:underline"
                      >
                        View Details
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <div className="grid lg:grid-cols-2 gap-8 items-start">
          
          {/* LEFT COLUMN: Controls & Input */}
          <section className="glass rounded-2xl p-1 flex flex-col gap-6 animate-fadeIn">
            <div className="p-6 pb-0">
                <div className="flex items-center justify-between mb-4">
                   <h2 className="text-lg font-bold text-slate-100">Configuration</h2>
                   <div className="flex bg-slate-800/50 rounded-lg p-1 border border-white/5">
                      <button 
                        onClick={() => setState(p => ({...p, inputMode: InputMode.FILE}))}
                        className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${state.inputMode === InputMode.FILE ? 'bg-slate-700 text-cyan-300 shadow-sm' : 'text-slate-400 hover:text-white'}`}
                      >File</button>
                      <button 
                        onClick={() => setState(p => ({...p, inputMode: InputMode.URL}))}
                        className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${state.inputMode === InputMode.URL ? 'bg-slate-700 text-red-400 shadow-sm' : 'text-slate-400 hover:text-white'}`}
                      >URL</button>
                   </div>
                </div>

                {state.inputMode === InputMode.FILE ? (
                   <div className="dropzone rounded-xl p-8 text-center cursor-pointer relative group" onClick={() => document.getElementById('fileUpload')?.click()}>
                      <input id="fileUpload" type="file" accept="video/mp4" className="hidden" onChange={handleFileUpload} />
                      <div className="w-14 h-14 mx-auto rounded-2xl bg-white/5 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                         <UploadIcon />
                      </div>
                      <p className="text-sm font-medium text-slate-200">{state.videoFile ? state.videoFile.name : "Drop English Lecture MP4"}</p>
                      <p className="text-xs text-slate-500 mt-1">Max 2GB • MP4 Format</p>
                   </div>
                ) : (
                   <div className="bg-white/5 border border-white/10 rounded-xl p-6 relative">
                      <label className="text-xs font-bold text-slate-400 uppercase mb-2 block">Video URL</label>
                      <div className="relative">
                         <input 
                           type="text" 
                           value={state.youtubeUrl}
                           onChange={(e) => {
                             const url = e.target.value;
                             const id = getYouTubeId(url);
                             setState(p => ({
                               ...p, 
                               youtubeUrl: url, 
                               youtubeId: id,
                               videoUrl: null,
                               videoFile: null
                             }));
                           }}
                           className="field w-full rounded-lg py-3 pl-10 pr-4 text-sm focus:bg-slate-900/50"
                           placeholder="YouTube link or direct MP4 URL..."
                         />
                         <div className="absolute left-3 top-3 text-slate-500"><LinkIcon /></div>
                      </div>
                      <p className="text-[10px] text-slate-500 mt-2 flex items-center gap-1">
                        <YouTubeIcon size={12} /> Supports YouTube, Shorts, and direct .mp4 links
                      </p>
                   </div>
                )}
            </div>

            <div className="px-6 grid grid-cols-2 gap-4">
                <div>
                   <label className="text-xs text-slate-400 font-medium mb-1.5 block">Learning Language</label>
                   <select 
                     value={targetLang}
                     onChange={(e) => setTargetLang(e.target.value as TargetLanguage)}
                     className="field w-full rounded-lg p-2.5 text-sm bg-slate-900/50 appearance-none cursor-pointer"
                   >
                     {Object.values(TargetLanguage).map(l => <option key={l} value={l}>{l}</option>)}
                   </select>
                </div>
                <div>
                   <label className="text-xs text-slate-400 font-medium mb-1.5 block">AI Voice</label>
                   <select 
                     value={selectedVoice}
                     onChange={(e) => setSelectedVoice(e.target.value as Voice)}
                     className="field w-full rounded-lg p-2.5 text-sm bg-slate-900/50 appearance-none cursor-pointer"
                   >
                     {Object.values(Voice).map(v => <option key={v} value={v}>{v}</option>)}
                   </select>
                </div>
            </div>

            <div className="px-6">
                <label className="text-xs text-slate-400 font-medium mb-1.5 block">Processing Mode</label>
                
                {/* Mock Mode Toggle */}
                <div className="flex items-center justify-between field rounded-lg p-2 bg-slate-900/50 mb-2">
                   <span className="text-xs text-slate-300 ml-1">Mock Mode</span>
                   <div 
                     className={`toggle ${state.isMockMode ? 'active' : ''}`}
                     onClick={() => setState(p => ({...p, isMockMode: !p.isMockMode, statusMessage: p.statusMessage === "Auth Error" ? "Ready" : p.statusMessage}))}
                   ></div>
                </div>
            </div>

            <div className="p-6 pt-2 space-y-3">
                <button 
                   onClick={() => startProcessing()}
                   disabled={state.step !== AppStep.UPLOAD || state.isProcessing}
                   className="btn-primary w-full py-3.5 rounded-xl text-sm font-bold tracking-wide uppercase shadow-lg disabled:opacity-50 disabled:shadow-none"
                >
                   {state.isProcessing ? 'Processing...' : 'Generate Regional Lesson'}
                </button>

                <button 
                   onClick={resetApp}
                   disabled={state.isProcessing}
                   className="w-full py-2.5 rounded-xl text-xs font-bold tracking-wide uppercase border border-white/10 hover:bg-white/5 transition-colors text-slate-400 hover:text-white"
                >
                   Reset Process
                </button>
                
                {state.statusMessage === "Auth Error" && (
                   <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 space-y-3">
                     <p className="text-[11px] text-red-300 text-center leading-relaxed">
                        Authentication failed. Please check your API key configuration.
                     </p>
                     <div className="flex flex-col gap-2">
                         <div className="flex gap-2">
                             {typeof (window as any).aistudio !== 'undefined' && (
                               <button 
                                 onClick={handleChangeKey}
                                 className="flex-1 py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-red-200 text-[10px] font-bold hover:bg-red-500/30 transition-colors uppercase tracking-wider"
                               >
                                  Select Paid Key
                               </button>
                             )}
                             <button 
                               onClick={() => setState(p => ({...p, statusMessage: "Ready"}))}
                               className="flex-1 py-2 rounded-lg border border-white/10 text-slate-400 text-[10px] font-bold hover:bg-white/5 transition-colors uppercase tracking-wider"
                             >
                                Dismiss
                             </button>
                         </div>
                     </div>
                   </div>
                )}

                {["Rate Limit", "Safety Block", "Format Error", "Server Busy", "Network Error", "Failed"].includes(state.statusMessage) && (
                   <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 animate-shake">
                      <p className="text-[11px] text-red-300 text-center leading-relaxed">
                         {state.logs[state.logs.length - 1]?.replace("Error: ", "") || "An unexpected error occurred."}
                      </p>
                      <button 
                        onClick={() => setState(p => ({...p, statusMessage: "Ready"}))}
                        className="w-full mt-2 py-1.5 text-[10px] text-red-400 hover:text-red-300 transition-colors uppercase font-bold tracking-wider"
                      >
                         Dismiss
                      </button>
                   </div>
                )}
            </div>
          </section>

          {/* RIGHT COLUMN: Output Preview */}
          <section className="glass rounded-2xl overflow-hidden flex flex-col h-full min-h-[400px]">
             <div className="p-4 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
                <h2 className="text-sm font-bold flex items-center gap-2">
                   Output Preview
                   {state.step === AppStep.RESULT && <span className="badge text-[10px] px-2 py-0.5 rounded-full">Ready</span>}
                </h2>
                {state.step === AppStep.RESULT && (
                   <div className="flex gap-2 items-center">
                      <div className="flex gap-1 bg-white/5 p-1 rounded-lg border border-white/5 mr-2">
                        <button onClick={() => setPreviewMode('original')} className={`text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded transition-all ${previewMode === 'original' ? 'bg-white/10 text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}>Original</button>
                        <button onClick={() => setPreviewMode('dubbed')} className={`text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded transition-all ${previewMode === 'dubbed' ? 'bg-cyan-500/20 text-cyan-300 shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}>AI Dubbed</button>
                      </div>
                   </div>
                )}
             </div>

             <div 
               className={`relative flex-grow bg-black flex items-center justify-center group ${state.step === AppStep.RESULT ? 'cursor-pointer' : ''}`}
               onClick={state.step === AppStep.RESULT ? togglePlayback : undefined}
             >
                 {state.youtubeId ? (
                    <iframe 
                      ref={iframeRef}
                      className="w-full h-full absolute inset-0 pointer-events-none"
                      src={`https://www.youtube.com/embed/${state.youtubeId}?enablejsapi=1&controls=0&modestbranding=1&rel=0&origin=${window.location.origin}`} 
                    />
                 ) : state.videoUrl ? (
                    <video 
                       ref={videoRef} 
                       src={state.videoUrl} 
                       className="w-full h-full absolute inset-0 object-contain" 
                       playsInline 
                       muted={false} 
                       onEnded={handlePause}
                       onTimeUpdate={(e) => {
                          const t = (e.target as HTMLVideoElement).currentTime;
                          currentTimeRef.current = t;
                          setCurrentPlaybackTime(t);
                       }}
                       onLoadedMetadata={(e) => setDuration((e.target as HTMLVideoElement).duration)}
                     />
                 ) : (
                    <div className="text-center p-8">
                       <div className="w-16 h-16 mx-auto rounded-full border border-white/10 flex items-center justify-center mb-4 text-slate-600">
                          <PlayIcon />
                       </div>
                       <p className="text-slate-500 text-sm">Preview will appear here</p>
                    </div>
                 )}

                 {/* Central Play/Pause Overlay */}
                 {state.step === AppStep.RESULT && (
                    <div className={`absolute inset-0 flex items-center justify-center z-20 pointer-events-none transition-opacity duration-300 ${!isPlaying ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                      <div className="w-20 h-20 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center text-white scale-125 transition-transform group-active:scale-110">
                        {isPlaying ? <PauseIcon /> : <PlayIcon />}
                      </div>
                    </div>
                 )}

                 {/* Overlays */}
                 {state.step === AppStep.PROCESSING && (
                    <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-20 flex flex-col items-center justify-center p-8">
                       <div className="w-full max-w-xs space-y-4">
                          <div className="flex justify-between text-xs font-mono text-cyan-300">
                             <span>{state.statusMessage}</span>
                             <span>{Math.round(state.progress)}%</span>
                          </div>
                          <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                             <div className="h-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-all duration-300" style={{ width: `${state.progress}%` }}></div>
                          </div>
                          {state.detectedLanguage && (
                             <div className="text-center animate-fadeIn">
                                <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold block mb-1">Detected Language</span>
                                <p className="text-cyan-400 font-mono text-sm">{state.detectedLanguage}</p>
                             </div>
                          )}
                          <div className="h-32 overflow-hidden relative">
                             <ProcessingLog logs={state.logs} isProcessing={true} />
                          </div>
                       </div>
                    </div>
                 )}

                 {/* Custom Controls Overlay */}
                 {(state.videoUrl || state.youtubeId) && state.step !== AppStep.PROCESSING && (
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4 z-30">
                       <div className="flex items-center gap-4 mb-2">
                           <button 
                             onClick={(e) => { e.stopPropagation(); togglePlayback(); }} 
                             className="w-10 h-10 flex items-center justify-center rounded-full bg-white text-black hover:scale-105 transition-transform"
                           >
                              {isPlaying ? <PauseIcon /> : <PlayIcon />}
                           </button>
                           <div className="flex-grow">
                              <input 
                                type="range" 
                                min="0" 
                                max={duration || 100} 
                                value={currentPlaybackTime} 
                                onChange={(e) => handleSeek(parseFloat(e.target.value))}
                                className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer accent-cyan-400 hover:h-1.5 transition-all"
                              />
                           </div>
                           <div className="text-xs font-mono text-white/80 w-16 text-right">
                              {formatTime(currentPlaybackTime)}
                           </div>
                       </div>
                       <div className="flex justify-between items-center">
                          <div className="flex gap-2">
                             <button onClick={() => handleSeek(currentPlaybackTime - 10)} className="p-1.5 hover:bg-white/10 rounded text-slate-300"><SkipBackIcon /></button>
                             <button onClick={() => handleSeek(currentPlaybackTime + 10)} className="p-1.5 hover:bg-white/10 rounded text-slate-300"><SkipForwardIcon /></button>
                          </div>
                          <VolumeControl volume={volume} onChange={setVolume} />
                       </div>
                    </div>
                 )}
             </div>

             {/* Output Text Tabs */}
             {state.step === AppStep.RESULT && (
                <div className="h-48 border-t border-white/5 bg-slate-900/50 flex">
                   <div className="w-1/2 border-r border-white/5 p-4 overflow-y-auto custom-scrollbar relative group">
                      <div className="flex justify-between items-center mb-2">
                         <div className="flex flex-col">
                            <h3 className="text-[10px] uppercase font-bold text-slate-500">Transcription</h3>
                            <span className="text-[9px] text-cyan-400 font-mono">Detected: {state.detectedLanguage}</span>
                         </div>
                        <button onClick={() => handleDownloadSRT(state.transcript, `transcription_${state.detectedLanguage}.srt`)} title="Export SRT" className="text-slate-500 hover:text-white transition-colors"><SubtitleIcon /></button>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed font-mono">{state.transcript}</p>
                   </div>
                   <div className="w-1/2 p-4 overflow-y-auto custom-scrollbar bg-cyan-500/[0.02] relative group">
                      <div className="flex justify-between items-center mb-2">
                         <h3 className="text-[10px] uppercase font-bold text-cyan-700/70">Translation ({targetLang})</h3>
                         <button onClick={() => handleDownloadSRT(state.translatedText, `translation_${targetLang}.srt`)} title="Export SRT" className="text-cyan-700/70 hover:text-cyan-300 transition-colors"><SubtitleIcon /></button>
                      </div>
                      <p className="text-xs text-cyan-100/80 leading-relaxed font-mono">{state.translatedText}</p>
                   </div>
                </div>
             )}
          </section>
        </div>
        
        {/* Reset / Download Actions Footer */}
        {state.step === AppStep.RESULT && (
            <div className="mt-8 flex flex-wrap justify-end gap-4 animate-fadeIn">
               <button onClick={handleReset} className="px-6 py-3 rounded-xl border border-white/10 hover:bg-white/5 text-sm font-medium transition-colors">Process Another</button>
                              {state.audioUrl && (
                  <div className="flex gap-2">
                    <a href={state.audioUrl} download={`vanibridge_${targetLang}.wav`} className="px-6 py-3 rounded-xl border border-cyan-500/30 text-cyan-300 text-sm font-medium hover:bg-cyan-500/10 transition-colors flex items-center gap-2">
                       <VolumeIcon /> Audio Only
                    </a>
                    
                    <button 
                      onClick={handleDownloadVideo}
                      disabled={isDownloadingVideo}
                      className="btn-primary px-6 py-3 rounded-xl text-sm font-bold flex items-center gap-2 min-w-[200px] justify-center"
                    >
                      {isDownloadingVideo ? (
                        <>
                          <div className="w-4 h-4 border-2 border-slate-900 border-t-transparent rounded-full animate-spin"></div>
                          Exporting HD...
                        </>
                      ) : (
                        <>
                          <DownloadIcon /> Download Dubbed Video
                        </>
                      )}
                    </button>

                  </div>
               )}
            </div>
        )}

        {/* Powered by Google Technology Stack */}
        <div className="mt-16 pt-10 border-t border-white/5">
           <div className="text-center mb-10">
              <h3 className="text-transparent bg-clip-text bg-gradient-to-r from-blue-300 to-cyan-300 font-bold text-lg tracking-tight">Powered by Google Cloud AI</h3>
              <p className="text-slate-500 text-xs mt-2 uppercase tracking-widest">Built with the latest Gemini Models</p>
           </div>
           
           <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {/* Card 1: Gemini 3 Flash */}
              <div className="bg-gradient-to-br from-white/5 to-transparent border border-white/5 p-5 rounded-xl hover:border-blue-400/30 transition-colors group">
                 <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center mb-3 text-blue-400 group-hover:scale-110 transition-transform">
                    <svg width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                 </div>
                 <h4 className="text-white font-semibold text-sm">Gemini 3 Flash</h4>
                 <p className="text-slate-500 text-xs mt-1 leading-relaxed">Multimodal context analysis, translation, and reasoning.</p>
              </div>

              {/* Card 2: Gemini TTS */}
              <div className="bg-gradient-to-br from-white/5 to-transparent border border-white/5 p-5 rounded-xl hover:border-cyan-400/30 transition-colors group">
                 <div className="w-10 h-10 rounded-lg bg-cyan-500/10 flex items-center justify-center mb-3 text-cyan-400 group-hover:scale-110 transition-transform">
                     <svg width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                 </div>
                 <h4 className="text-white font-semibold text-sm">Gemini TTS</h4>
                 <p className="text-slate-500 text-xs mt-1 leading-relaxed">Neural speech synthesis (Puck voice) for natural audio.</p>
              </div>

              {/* Card 3: Search Grounding */}
              <div className="bg-gradient-to-br from-white/5 to-transparent border border-white/5 p-5 rounded-xl hover:border-emerald-400/30 transition-colors group">
                 <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center mb-3 text-emerald-400 group-hover:scale-110 transition-transform">
                     <svg width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                 </div>
                 <h4 className="text-white font-semibold text-sm">Google Search</h4>
                 <p className="text-slate-500 text-xs mt-1 leading-relaxed">Real-time grounding for accurate YouTube transcript retrieval.</p>
              </div>
           </div>
        </div>

      </main>

      <footer className="max-w-7xl mx-auto px-6 py-8 border-t border-white/5 mt-8">
         <div className="flex justify-between items-center text-xs text-slate-500">
            <div>© 2026 VaniBridge. Built for GSA India Tech Summit.</div>
            <div className="flex gap-3">
               <span className="badge px-2 py-0.5 rounded">Privacy-First</span>
               <span className="badge px-2 py-0.5 rounded">Gemini Powered</span>
            </div>
         </div>
      </footer>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm animate-fadeIn">
           <div className="glass w-full max-w-md rounded-3xl p-8 shadow-2xl border border-white/10">
              <div className="flex justify-between items-center mb-6">
                 <h2 className="text-xl font-bold text-white">Settings</h2>
                 <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-white transition-colors">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                 </button>
              </div>

              <div className="space-y-6">
                 <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Gemini API Key</label>
                    <div className="relative">
                       <input 
                          type="password"
                          value={apiKeyInput}
                          onChange={(e) => setApiKeyInput(e.target.value)}
                          placeholder="Enter your API Key..."
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500/50 transition-all"
                       />
                    </div>
                    <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                       Get your free API key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">Google AI Studio</a>. Your key is stored locally in your browser.
                    </p>
                 </div>

                 <button 
                   onClick={() => {
                     localStorage.setItem('gemini_api_key', apiKeyInput);
                     setCustomApiKey(apiKeyInput);
                     setShowSettings(false);
                     addLog("API Key saved successfully.");
                   }}
                   className="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-bold text-sm shadow-lg shadow-cyan-500/20 hover:scale-[1.02] active:scale-[0.98] transition-all"
                 >
                   Save Configuration
                 </button>
              </div>
           </div>
        </div>
      )}
    </div>
  );
};

export default App;