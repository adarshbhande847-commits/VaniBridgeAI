import express from "express";
import { createServer as createViteServer } from "vite";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import ytdl from "@distube/ytdl-core";

const app = express();
const PORT = 3000;

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const upload = multer({ dest: "uploads/" });

async function startServer() {
  app.use(cors());
  app.use(express.json());

  // API: Download and Merge
  app.post("/api/merge-video", upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
    const { youtubeId } = req.body;
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const audioFile = files?.audio?.[0];
    const videoFile = files?.video?.[0];

    if (!audioFile) {
      return res.status(400).json({ error: "Audio file is required" });
    }

    const outputFileName = `dubbed_${Date.now()}.mp4`;
    const uploadsDir = path.resolve("uploads");
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
    const outputPath = path.join(uploadsDir, outputFileName);

    try {
      let videoInput: string;
      let isTempVideo = false;

      if (youtubeId) {
        console.log(`Fetching YouTube info for ${youtubeId}`);
        const info = await ytdl.getInfo(youtubeId);
        const format = ytdl.chooseFormat(info.formats, { quality: "highestvideo", filter: "videoonly" });
        if (!format) throw new Error("No suitable high-quality video format found");
        videoInput = format.url;
      } else if (videoFile) {
        videoInput = videoFile.path;
      } else {
        return res.status(400).json({ error: "YouTube ID or Video file is required" });
      }

      console.log(`Starting FFmpeg merge for ${outputFileName}`);
      const ffmpegArgs = [
        "-i", videoInput,
        "-i", audioFile.path,
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-shortest",
        "-y",
        outputPath
      ];

      // Add reconnect flags only for network URLs (YouTube)
      if (youtubeId) {
        ffmpegArgs.unshift("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
      }

      const ffmpeg = spawn("ffmpeg", ffmpegArgs);

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          res.download(outputPath, "dubbed_video.mp4", (err) => {
            // Cleanup
            if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
            if (videoFile && fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          });
        } else {
          console.error(`FFmpeg exited with code ${code}`);
          res.status(500).json({ error: "Failed to merge video and audio" });
          if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
          if (videoFile && fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);
        }
      });

      ffmpeg.on("error", (err) => {
        console.error("FFmpeg error:", err);
        res.status(500).json({ error: "FFmpeg not found or failed" });
        if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
        if (videoFile && fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);
      });

    } catch (error) {
      console.error("Merge error:", error);
      res.status(500).json({ error: "Internal server error during merge" });
      if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
      if (videoFile && fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve("dist/index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
