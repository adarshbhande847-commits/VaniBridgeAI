import { GoogleGenAI, Modality } from "@google/genai";

// Use a function to ensure we always get the latest API key (e.g., after user selection)
let customApiKey: string | null = null;
export const setCustomApiKey = (key: string) => { customApiKey = key; };

const getAI = () => {
  const key = customApiKey || process.env.API_KEY;
  if (!key) {
    throw new Error("Gemini API Key is missing. Please provide one in Settings.");
  }
  return new GoogleGenAI({ apiKey: key });
};

/**
 * Helper for exponential backoff retries on 429 errors
 */
const withRetry = async <T>(fn: () => Promise<T>, retries = 3, delay = 2000): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    const errMsg = (error as Error).message.toLowerCase();
    if ((errMsg.includes("429") || errMsg.includes("rate limit") || errMsg.includes("quota")) && retries > 0) {
      console.log(`Rate limit hit, retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

/**
 * Helper to convert File to Base64
 */
export const fileToGenerativePart = async (file: File): Promise<{ inlineData: { data: string; mimeType: string } }> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = (reader.result as string).split(',')[1];
      resolve({
        inlineData: {
          data: base64String,
          mimeType: file.type,
        },
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

/**
 * Step 1: Detect Language & Transcribe Video Audio
 */
export const detectAndTranscribe = async (file: File): Promise<{ language: string; transcript: string }> => {
  const ai = getAI();
  const videoPart = await fileToGenerativePart(file);

  const response = await withRetry(() => ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: {
      parts: [
        videoPart,
        { text: "Listen to the audio in this video carefully. 1. Detect the dominant spoken language. 2. Transcribe the **entire** speech in that language accurately, word-for-word. Do not summarize. Return a JSON object with keys 'language' and 'transcript'. Do not add Markdown code blocks." }
      ]
    },
    config: {
      responseMimeType: "application/json"
    }
  }));

  const text = response.text || "{}";
  try {
    const json = JSON.parse(text);
    return {
      language: json.language || "Unknown",
      transcript: json.transcript || ""
    };
  } catch (e) {
    console.warn("Failed to parse JSON from Gemini, returning raw text as transcript", text);
    return { language: "Unknown", transcript: text };
  }
};

/**
 * Step 1b: Analyze URL (YouTube or direct MP4)
 */
export const analyzeUrl = async (url: string): Promise<{ language: string; transcript: string }> => {
  const ai = getAI();
  const isMp4 = url.toLowerCase().endsWith('.mp4');
  
  try {
    const response = await withRetry(() => ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          { text: `I have a video URL: ${url}. 
            ${isMp4 ? "This is a direct link to an MP4 video file." : "This is a YouTube video link."}
            
            Task:
            1. Use Google Search to find information about this video.
            2. If it's a YouTube video, find the EXACT transcript or captions.
            3. If it's a direct MP4 link, search for the source website, title, or any context that provides a transcript or detailed description.
            4. Detect the primary spoken language.
            5. Check if the video is accessible (not private, deleted, or region-restricted).
            6. Generate a Comprehensive Transcript:
               - The transcript MUST be a word-for-word or highly detailed narrative of everything said in the video.
               - It should be structured as a continuous educational lecture.
               - Length should be proportional to the video's duration (aim for at least 300-500 words for standard educational videos).
               - DO NOT summarize. Provide the actual spoken content.
               - If you cannot find the exact words, reconstruct the lecture based on the video's specific content and title with high fidelity.
            
            Return a JSON object with keys 'language', 'transcript', and 'status' (value: 'success' or 'error'). 
            If 'status' is 'error', include an 'errorMessage' explaining why (e.g., 'Private Video', 'Region Restricted', 'Invalid URL').
            Do not add Markdown code blocks.` }
        ]
      },
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json"
      }
    }));

    const text = response.text || "{}";
    const cleanText = text.replace(/```json\n?|```/g, '').trim();

    let json;
    try {
        json = JSON.parse(cleanText);
    } catch (e) {
        throw new Error("Failed to parse transcript from URL analysis.");
    }

    if (json.status === 'error') {
        throw new Error(json.errorMessage || "Could not retrieve video details.");
    }

    if (!json.transcript || json.transcript.includes("Could not retrieve")) {
        throw new Error("Could not retrieve a valid transcript for this video. The video might be private, deleted, or restricted.");
    }

    return {
       language: json.language || "English",
       transcript: json.transcript
    };
  } catch (error) {
    const errMsg = (error as Error).message.toLowerCase();
    
    // Provide user-friendly guidance based on common errors
    if (errMsg.includes("private") || errMsg.includes("deleted") || errMsg.includes("restricted")) {
        throw new Error(`Video Inaccessible: ${error instanceof Error ? error.message : 'The video is private or restricted.'} Try using 'Mock Mode' or uploading a direct MP4 file.`);
    }
    
    if (errMsg.includes("permission denied") || errMsg.includes("403") || errMsg.includes("api key")) {
        throw error; // Rethrow auth errors for UI handling
    }
    
    console.error("URL Analysis Error:", error);
    throw new Error(`URL Analysis Failed: ${error instanceof Error ? error.message : 'Unknown error'}. Please check the URL or try uploading a file.`);
  }
};

/**
 * Step 1c: Generate Generic Transcript (Mock/Simulated)
 */
export const generateGenericTranscript = async (): Promise<{ language: string; transcript: string }> => {
  const topics = ["The Water Cycle", "Photosynthesis", "Gravity", "The Solar System", "Volcanoes", "Ocean Currents", "Atoms"];
  const randomTopic = topics[Math.floor(Math.random() * topics.length)];

  // Truly local mock to avoid API errors in mock mode
  return { 
    language: "English", 
    transcript: `Science helps us understand the world around us. From the smallest atoms to the largest galaxies, everything is connected. In this lesson, we explore ${randomTopic} in detail, covering its fundamental principles and real-world applications. This topic is essential for understanding how our universe functions and how different systems interact with each other to maintain balance in nature.` 
  };
};

/**
 * Step 2: Translate Text
 */
export const translateText = async (text: string, targetLang: string, sourceLang: string): Promise<string> => {
  const ai = getAI();
  const response = await withRetry(() => ai.models.generateContent({
    model: 'gemini-3-flash-preview', // Use flash for higher rate limits (15 RPM vs 2 RPM)
    contents: {
      parts: [
        { text: `You are an expert translator specializing in educational content for rural communities. 
        Task: Translate the following ${sourceLang} text into ${targetLang}.
        
        Guidelines:
        1. Maintain the original educational meaning and technical accuracy.
        2. Use culturally appropriate idioms and terminology that a rural audience in India would easily understand.
        3. Ensure the tone is encouraging, clear, and respectful.
        4. Do NOT summarize. Translate the entire text word-for-word where possible, while ensuring natural flow in ${targetLang}.
        5. Return ONLY the translated text.
        
        Text to translate:
        "${text}"` }
      ]
    }
  }));

  return response.text || "";
};

/**
 * Step 3: Generate Speech (TTS)
 */
export const generateSpeechData = async (text: string, voiceName: string = 'Puck'): Promise<ArrayBuffer> => {
   const ai = getAI();
   const response = await withRetry(() => ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voiceName },
        },
      },
    },
  }));

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) throw new Error("No audio data returned");

  const binaryString = atob(base64Audio);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Helper to generate SRT format from raw text
 */
export const generateSRT = (text: string): string => {
  const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g);
  if (!sentences) return "";

  let srtContent = "";
  let startTime = 0;

  sentences.forEach((sentence, index) => {
    const trimmed = sentence.trim();
    if (!trimmed) return;

    const wordCount = trimmed.split(/\s+/).length;
    const duration = Math.max(1.5, wordCount * 0.4); 
    const endTime = startTime + duration;

    const formatTime = (seconds: number) => {
       const date = new Date(0);
       date.setMilliseconds(seconds * 1000);
       return date.toISOString().slice(11, 23).replace('.', ',');
    };

    srtContent += `${index + 1}\n`;
    srtContent += `${formatTime(startTime)} --> ${formatTime(endTime)}\n`;
    srtContent += `${trimmed}\n\n`;

    startTime = endTime;
  });

  return srtContent;
};