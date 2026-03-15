import React from 'react';
import { 
  Upload, 
  CheckCircle, 
  Play, 
  Pause, 
  RotateCcw, 
  RotateCw, 
  Youtube, 
  Link as LinkIconLucide, 
  Volume2, 
  Download, 
  Type 
} from 'lucide-react';

export const UploadIcon = () => <Upload className="h-12 w-12 text-blue-400" />;

export const CheckCircleIcon = () => <CheckCircle className="h-6 w-6 text-green-400" />;

export const PlayIcon = () => <Play className="h-8 w-8 text-white fill-current" />;

export const PauseIcon = () => <Pause className="h-8 w-8 text-white fill-current" />;

export const SkipBackIcon = () => (
  <div className="relative">
    <RotateCcw className="h-6 w-6 text-slate-300" />
    <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-slate-300 mt-1">10</span>
  </div>
);

export const SkipForwardIcon = () => (
  <div className="relative">
    <RotateCw className="h-6 w-6 text-slate-300" />
    <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-slate-300 mt-1">10</span>
  </div>
);

export const LoadingSpinner = () => (
  <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
);

export const YouTubeIcon = ({ size = 12 }: { size?: number }) => (
  <Youtube style={{ width: size, height: size }} className="text-red-500 fill-current" />
);

export const LinkIcon = () => <LinkIconLucide className="h-5 w-5" />;

export const VolumeIcon = () => <Volume2 className="h-5 w-5 text-slate-400" />;

export const DownloadIcon = ({ size = 20 }: { size?: number }) => (
  <Download style={{ width: size, height: size }} />
);

export const SubtitleIcon = () => <Type className="h-3.5 w-3.5" />;
