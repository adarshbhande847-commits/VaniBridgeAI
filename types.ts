export enum AppStep {
  UPLOAD = 'UPLOAD',
  PROCESSING = 'PROCESSING',
  RESULT = 'RESULT'
}

export enum TargetLanguage {
  HINDI = 'Hindi',
  MARATHI = 'Marathi',
  TAMIL = 'Tamil',
  TELUGU = 'Telugu',
  INDIAN_ENGLISH = 'Indian English'
}

export enum InputMode {
  FILE = 'FILE',
  YOUTUBE = 'YOUTUBE'
}

export enum Voice {
  PUCK = 'Puck',
  CHARON = 'Charon',
  KORE = 'Kore',
  FENRIR = 'Fenrir',
  ZEPHYR = 'Zephyr'
}

export interface ProcessingState {
  step: AppStep;
  inputMode: InputMode;
  isMockMode: boolean;
  videoFile: File | null;
  youtubeUrl: string;
  youtubeId: string | null;
  videoUrl: string | null;
  detectedLanguage: string | null;
  transcript: string;
  translatedText: string;
  audioUrl: string | null;
  isProcessing: boolean;
  progress: number; // 0 to 100
  logs: string[];
  statusMessage: string;
}

export interface GeminiError {
  message: string;
}