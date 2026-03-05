import { GoogleGenAI, Modality } from "@google/genai";

// Use a function to ensure we always get the latest API key (e.g., after user selection)
const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

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

  const response = await ai.models.generateContent({
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
  });

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
 * Step 1b: Analyze YouTube URL (Fallback when download fails)
 */
export const analyzeYouTubeUrl = async (url: string): Promise<{ language: string; transcript: string }> => {
  const ai = getAI();
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          { text: `I have a YouTube video URL: ${url}. 
            Task:
            1. Use Google Search to find the EXACT transcript or captions for this video.
            2. If a direct transcript isn't available, find detailed summaries, video descriptions, or articles about this specific video.
            3. Detect the primary spoken language.
            4. Generate a Comprehensive Transcript:
               - The transcript MUST be a word-for-word or highly detailed narrative of everything said in the video.
               - It should be structured as a continuous educational lecture.
               - Length should be proportional to the video's duration (aim for at least 300-500 words for standard educational videos).
               - DO NOT summarize. Provide the actual spoken content.
               - If you cannot find the exact words, reconstruct the lecture based on the video's specific content and title with high fidelity.
            
            Return a JSON object with keys 'language' and 'transcript'. Do not add Markdown code blocks.` }
        ]
      },
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json"
      }
    });

    const text = response.text || "{}";
    const cleanText = text.replace(/```json\n?|```/g, '').trim();

    let json;
    try {
        json = JSON.parse(cleanText);
    } catch (e) {
        throw new Error("Failed to parse transcript from YouTube analysis.");
    }

    if (!json.transcript || json.transcript.includes("Could not retrieve")) {
        throw new Error("Could not retrieve a valid transcript for this YouTube video.");
    }

    return {
       language: json.language || "English",
       transcript: json.transcript
    };
  } catch (error) {
    // Check for critical auth errors and rethrow them so the UI can prompt for a new key
    const errMsg = (error as Error).message.toLowerCase();
    if (errMsg.includes("permission denied") || 
        errMsg.includes("403") || 
        errMsg.includes("not found") || 
        errMsg.includes("authentication failed") ||
        errMsg.includes("api key")) {
        throw error;
    }
    console.error("YouTube Analysis Error:", error);
    throw error;
  }
};

/**
 * Step 1c: Generate Generic Transcript (Mock/Simulated)
 */
export const generateGenericTranscript = async (): Promise<{ language: string; transcript: string }> => {
  const ai = getAI();
  const topics = ["The Water Cycle", "Photosynthesis", "Gravity", "The Solar System", "Volcanoes", "Ocean Currents", "Atoms"];
  const randomTopic = topics[Math.floor(Math.random() * topics.length)];

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: {
      parts: [
        { text: `Write a **detailed and comprehensive** educational transcript explaining ${randomTopic} to a student. It should be substantial (at least 200 words). Return a JSON object with keys 'language' (value: 'English') and 'transcript' (the text).` }
      ]
    },
    config: {
      responseMimeType: "application/json"
    }
  });

  const text = response.text || "{}";
  try {
     return JSON.parse(text);
  } catch(e) {
     return { 
       language: "English", 
       transcript: "Science helps us understand the world around us. From the smallest atoms to the largest galaxies, everything is connected." 
     };
  }
};

/**
 * Step 2: Translate Text
 */
export const translateText = async (text: string, targetLang: string, sourceLang: string): Promise<string> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: {
      parts: [
        { text: `Translate the following ${sourceLang} text to ${targetLang}. Ensure the tone is educational and suitable for rural audiences. Return ONLY the translated text. Do not summarize; translate the full text.\n\nText: "${text}"` }
      ]
    }
  });

  return response.text || "";
};

/**
 * Step 3: Generate Speech (TTS)
 */
export const generateSpeechData = async (text: string, voiceName: string = 'Puck'): Promise<ArrayBuffer> => {
   const ai = getAI();
   const response = await ai.models.generateContent({
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
  });

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