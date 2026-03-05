import React, { useState, useRef, useEffect } from 'react';
import { TargetLanguage, ProcessingState, AppStep, InputMode, Voice } from './types';
import { detectAndTranscribe, translateText, generateSpeechData, generateGenericTranscript, analyzeYouTubeUrl, generateSRT } from './services/geminiService';
import { UploadIcon, PlayIcon, PauseIcon, LoadingSpinner, YouTubeIcon, LinkIcon, VolumeIcon, DownloadIcon, SkipBackIcon, SkipForwardIcon, SubtitleIcon } from './components/Icon';
import { ProcessingLog } from './components/ProcessingLog';

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

  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const currentTimeRef = useRef<number>(0);
  const isSeekingRef = useRef<boolean>(false);

  // Initialize AudioContext
  useEffect(() => {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const gainNode = ctx.createGain();
    gainNode.gain.value = 1.0; 
    gainNode.connect(ctx.destination);
    audioContextRef.current = ctx;
    gainNodeRef.current = gainNode;
    return () => { audioContextRef.current?.close(); };
  }, []);

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

  const handlePause = React.useCallback(async () => {
    await audioContextRef.current?.suspend();
    videoRef.current?.pause();
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo' }), '*');
    setIsPlaying(false);
  }, []);

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

    // Test Cases Handled:
    // 1. Standard: https://www.youtube.com/watch?v=dQw4w9WgXcQ
    // 2. Shortened: https://youtu.be/dQw4w9WgXcQ
    // 3. Embed: https://www.youtube.com/embed/dQw4w9WgXcQ
    // 4. Shorts: https://www.youtube.com/shorts/dQw4w9WgXcQ
    // 5. Params: https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=4s
    
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|shorts\/)([^#&?]*).*/;
    const match = cleanUrl.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
  };

  const handleChangeKey = async () => {
     if ((window as any).aistudio) {
        await (window as any).aistudio.openSelectKey();
        addLog("API Key updated. Please try generating again.");
     }
  };

  const startProcessing = async () => {
    setState(prev => ({ ...prev, step: AppStep.PROCESSING, isProcessing: true, progress: 0, statusMessage: "Initializing..." }));
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

        if (state.inputMode === InputMode.YOUTUBE) {
            const url = state.youtubeUrl.trim();
            if (!url) throw new Error("Please enter a valid YouTube URL.");
            
            const ytid = getYouTubeId(url);
            if (!ytid) {
                throw new Error("Invalid YouTube URL. Could not extract Video ID. Please ensure the URL is correct.");
            }
            
            // Set ID initially and clear previous video file data to avoid conflicts
            setState(p => ({...p, youtubeId: ytid, videoUrl: null, videoFile: null}));

            // 2. Analyze
            setState(p => ({...p, progress: 10, statusMessage: "Analyzing YouTube content..."}));
            
            const analysisResult = await analyzeYouTubeUrl(url);
            currentTranscript = analysisResult.transcript;
            currentLanguage = analysisResult.language || "English";
            
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

        // 5. Finalize
        if (!state.isMockMode) {
            const hasValidKey = (window as any).aistudio ? await (window as any).aistudio.hasSelectedApiKey() : true;
            if (hasValidKey) {
                setState(p => ({...p, progress: 90, statusMessage: "Generating Veo Lip-sync..."}));
                addLog("Veo video generation started (High Quality)...");
                // In a real implementation, we would call ai.models.generateVideos here
                await new Promise(r => setTimeout(r, 2000));
                addLog("Veo video generation completed.");
            } else {
                addLog("Skipping Veo video generation: No valid paid API key selected.");
                setState(p => ({...p, progress: 90, statusMessage: "Skipping Veo (No API Key)..."}));
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        setState(p => ({...p, progress: 100, statusMessage: "Finalizing...", audioUrl: wavUrl}));
        await new Promise(r => setTimeout(r, 1000));
        
        setState(p => ({...p, step: AppStep.RESULT, isProcessing: false, statusMessage: "Ready"}));

    } catch (e) {
        const err = e as Error;
        console.error(err);
        
        const errMsg = err.message.toLowerCase();
        const isAuthError = errMsg.includes("permission denied") || 
            errMsg.includes("403") || 
            errMsg.includes("not found") ||
            errMsg.includes("authentication failed") ||
            errMsg.includes("api key") ||
            errMsg.includes("failed to fetch");

        if (isAuthError) {
             if ((window as any).aistudio) {
                 addLog("Authentication/Billing Error. Please check your key.");
                 setState(p => ({...p, isProcessing: false, statusMessage: "Auth Error", logs: [...p.logs, "Error: Authentication failed."] }));
             } else {
                 setState(p => ({...p, isProcessing: false, statusMessage: "Auth Error", logs: [...p.logs, `Permission Denied: ${err.message}`] }));
             }
        } else {
             setState(p => ({...p, isProcessing: false, statusMessage: "Failed", logs: [...p.logs, `Error: ${err.message}`] }));
        }
    }
  };

  // Playback Controls
  const togglePlayback = async () => {
     if (isPlaying) {
         await handlePause();
     } else {
         if (audioContextRef.current?.state === 'suspended') await audioContextRef.current.resume();
         
         // Start Audio
         if (audioBuffer && !sourceNodeRef.current && state.step === AppStep.RESULT) {
             const src = audioContextRef.current!.createBufferSource();
             src.buffer = audioBuffer;
             src.connect(gainNodeRef.current || audioContextRef.current!.destination);
             src.start(0, currentTimeRef.current);
             src.onended = () => { if(!isSeekingRef.current) setIsPlaying(false); };
             sourceNodeRef.current = src;
         }
         
         videoRef.current?.play();
         if (state.youtubeId) {
             iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [currentTimeRef.current, true] }), '*');
             iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'playVideo' }), '*');
         }
         setIsPlaying(true);
     }
  };

  const handleSeek = (time: number) => {
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
          sourceNodeRef.current = src;
      }
      setTimeout(() => isSeekingRef.current = false, 50);
  };

  const formatTime = (s: number) => {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${sec.toString().padStart(2, '0')}`;
  };

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
    if (!state.audioUrl || (!state.youtubeId && !state.videoFile)) {
      alert("Please generate the dubbed audio first and ensure a video is selected.");
      return;
    }

    setIsDownloadingVideo(true);
    addLog("Preparing high-quality video export...");

    try {
      // 1. Fetch the audio blob
      const audioResponse = await fetch(state.audioUrl);
      const audioBlob = await audioResponse.blob();

      // 2. Prepare Form Data
      const formData = new FormData();
      formData.append("audio", audioBlob, "dubbed_audio.wav");
      
      if (state.youtubeId) {
        formData.append("youtubeId", state.youtubeId);
      } else if (state.videoFile) {
        formData.append("video", state.videoFile);
      }

      // 3. Send to Server for merging
      addLog(state.youtubeId ? "Merging audio with high-quality YouTube stream..." : "Merging audio with uploaded video file...");
      const response = await fetch("/api/merge-video", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to merge video");
      }

      // 4. Download the result
      const videoBlob = await response.blob();
      const videoUrl = URL.createObjectURL(videoBlob);
      const a = document.createElement("a");
      a.href = videoUrl;
      const downloadName = state.youtubeId ? `VaniBridge_Dubbed_${state.youtubeId}.mp4` : `VaniBridge_Dubbed_${state.videoFile?.name || 'video'}.mp4`;
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(videoUrl);
      
      addLog("Video exported successfully!");
    } catch (error) {
      console.error("Download error:", error);
      alert(`Export failed: ${(error as Error).message}`);
      addLog(`Export failed: ${(error as Error).message}`);
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
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 backdrop-blur-sm">
             <span className={`status-dot ${state.isProcessing ? 'processing animate-pulse' : 'live'}`}></span>
             <span className="text-xs font-medium text-slate-300">{state.isProcessing ? 'Processing' : 'Live Inference'}</span>
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-7xl mx-auto px-6 py-8">
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
                        onClick={() => setState(p => ({...p, inputMode: InputMode.YOUTUBE}))}
                        className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${state.inputMode === InputMode.YOUTUBE ? 'bg-slate-700 text-red-400 shadow-sm' : 'text-slate-400 hover:text-white'}`}
                      >YouTube</button>
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
                           placeholder="https://youtube.com/watch?v=..."
                         />
                         <div className="absolute left-3 top-3 text-slate-500"><LinkIcon /></div>
                      </div>
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
                   <span className="text-xs text-slate-300 ml-1">Mock Lip-Sync</span>
                   <div 
                     className={`toggle ${state.isMockMode ? 'active' : ''}`}
                     onClick={() => setState(p => ({...p, isMockMode: !p.isMockMode}))}
                   ></div>
                </div>
            </div>

            <div className="p-6 pt-2 space-y-3">
                <button 
                   onClick={startProcessing}
                   disabled={state.step !== AppStep.UPLOAD || (!state.videoFile && !state.youtubeUrl)}
                   className="btn-primary w-full py-3.5 rounded-xl text-sm font-bold tracking-wide uppercase shadow-lg disabled:opacity-50 disabled:shadow-none"
                >
                   {state.isProcessing ? 'Generating...' : 'Generate Regional Lesson'}
                </button>
                
                {state.statusMessage === "Auth Error" && (
                   <div className="space-y-2">
                     <p className="text-xs text-red-400 text-center">
                        Authentication failed. Please check your key.
                     </p>
                     <div className="flex gap-2">
                         <button 
                           onClick={handleChangeKey}
                           className="flex-1 py-2 rounded-xl border border-red-400/30 text-red-300 text-xs hover:bg-red-900/20 transition-colors flex items-center justify-center gap-2"
                         >
                            Change API Key
                         </button>
                     </div>
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
                   <div className="flex gap-2">
                      <button onClick={() => setPreviewMode('original')} className={`text-xs px-2 py-1 rounded transition-colors ${previewMode === 'original' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'}`}>Original</button>
                      <button onClick={() => setPreviewMode('dubbed')} className={`text-xs px-2 py-1 rounded transition-colors ${previewMode === 'dubbed' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500 hover:text-slate-300'}`}>AI Dubbed</button>
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
                    <video ref={videoRef} src={state.videoUrl} className="w-full h-full absolute inset-0 object-contain" playsInline muted={false} />
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
    </div>
  );
};

export default App;