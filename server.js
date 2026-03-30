require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const os = require("os");
const OpenAI = require("openai");

const app = express();
const upload = multer({ dest: os.tmpdir() });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/stt-command", upload.single("audio"), async (req, res) => {
  try {
    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "whisper-1",
      language: "vi"
    });

    const text = String(result.text || "").toLowerCase();

    let action = "none";
    let message = "Khong hieu lenh";
    let params = {};

    if (text.includes("cho an them")) {
      const match = text.match(/(\d{1,2})\s*(gio|h)?\s*(\d{1,2})?/);
      if (match) {
        const hour = Number(match[1]);
        const minute = match[3] ? Number(match[3]) : 0;
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
          action = "set_extra_feed_time";
          params = { hour, minute };
          message = `Da luu gio an them ${hour} gio ${minute} phut`;
        }
      }
    } else if (text.includes("xoa gio an them")) {
      action = "disable_extra_feed_time";
      message = "Da xoa gio an them";
    } else if (text.includes("cho an")) {
      action = "feed_now";
      message = "Da cho an";
    } else if (text.includes("bat bom")) {
      action = "pump_on_manual";
      message = "Da bat bom nuoc";
    } else if (text.includes("tat bom")) {
      action = "pump_off_manual";
      message = "Da tat bom nuoc";
    }

    res.json({
      ok: true,
      action,
      params,
      message,
      transcript_raw: text
    });
  } catch (e) {
    res.json({
      ok: false,
      action: "none",
      params: {},
      message: "Loi STT"
    });
  }
});

app.get("/api/tts", async (req, res) => {
  try {
    const text = String(req.query.text || "").trim();

    const speech = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
      response_format: "wav"
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    res.setHeader("Content-Type", "audio/wav");
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ ok: false, message: "Loi TTS" });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
