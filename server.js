const express = require("express");
const compression = require("compression");
const multer = require("multer");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Hỗ trợ ESP32 gửi raw wav trực tiếp
app.use("/api/stt-command-raw", express.raw({
  type: ["audio/wav", "audio/x-wav", "application/octet-stream"],
  limit: "2mb"
}));

// Hỗ trợ cách hiện tại: multipart/form-data
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }
});

// Cache TTS đơn giản trong RAM
const ttsCache = new Map();
const TTS_CACHE_LIMIT = 50;

function putCache(key, value) {
  if (ttsCache.size >= TTS_CACHE_LIMIT) {
    const firstKey = ttsCache.keys().next().value;
    if (firstKey) ttsCache.delete(firstKey);
  }
  ttsCache.set(key, value);
}

function normalizeText(s = "") {
  return String(s).trim().toLowerCase();
}

function removeVietnameseAccents(str = "") {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function normVN(s = "") {
  return removeVietnameseAccents(normalizeText(s));
}

function parseVietnameseCommand(text) {
  const raw = normalizeText(text);
  const t = normVN(text);

  if (!t) {
    return { ok: false, action: "none", message: "Khong nghe ro lenh" };
  }

  if (t.includes("xoa gio an them")) {
    return {
      ok: true,
      action: "disable_extra_feed_time",
      message: "Da xoa gio an them"
    };
  }

  const timeMatch = t.match(/cho an them\s+(\d{1,2})\s+gio\s+(\d{1,2})\s+phut/);
  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);

    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return {
        ok: true,
        action: "set_extra_feed_time",
        message: `Da dat gio an them ${hour} gio ${minute} phut`,
        params: { hour, minute }
      };
    }

    return {
      ok: false,
      action: "none",
      message: "Gio an them khong hop le"
    };
  }

  if (t.includes("bat bom nuoc") || t.includes("bat bom")) {
    return {
      ok: true,
      action: "pump_on_manual",
      message: "Da bat bom nuoc"
    };
  }

  if (t.includes("tat bom nuoc") || t.includes("tat bom")) {
    return {
      ok: true,
      action: "pump_off_manual",
      message: "Da tat bom nuoc"
    };
  }

  if (t.includes("cho an")) {
    return {
      ok: true,
      action: "feed_now",
      message: "Da cho an"
    };
  }

  return {
    ok: false,
    action: "none",
    message: `Lenh chua duoc ho tro: ${raw}`
  };
}

// Trang goc
app.get("/", (req, res) => {
  res.type("text/plain").send("pet-feeder-server OK");
});

// Health check cho Render
app.get("/healthz", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "pet-feeder-server",
    uptime_sec: Math.round(process.uptime()),
    now: new Date().toISOString()
  });
});

// Ping giu service am
app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

// STT demo / fallback
// Tạm thời để test toàn bộ luồng trước.
// Sau này bạn thay bằng STT thật.
async function speechToTextFromBuffer(buffer) {
  if (!buffer || !buffer.length) return "";
  return "cho an";
}

// API đang khớp với ESP32 hiện tại của bạn: multipart/form-data
app.post("/api/stt-command", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        action: "none",
        message: "Thieu file audio"
      });
    }

    const transcript = await speechToTextFromBuffer(req.file.buffer);
    const result = parseVietnameseCommand(transcript);

    return res.json({
      ...result,
      transcript_raw: transcript
    });
  } catch (err) {
    console.error("STT multipart error:", err);
    return res.status(500).json({
      ok: false,
      action: "none",
      message: "Loi xu ly giong noi"
    });
  }
});

// API raw de toi uu hon sau nay
app.post("/api/stt-command-raw", async (req, res) => {
  try {
    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({
        ok: false,
        action: "none",
        message: "Thieu du lieu audio"
      });
    }

    const transcript = await speechToTextFromBuffer(req.body);
    const result = parseVietnameseCommand(transcript);

    return res.json({
      ...result,
      transcript_raw: transcript
    });
  } catch (err) {
    console.error("STT raw error:", err);
    return res.status(500).json({
      ok: false,
      action: "none",
      message: "Loi xu ly audio raw"
    });
  }
});

// TTS demo: tra WAV gia
app.get("/api/tts", async (req, res) => {
  try {
    const text = String(req.query.text || "").trim();
    if (!text) {
      return res.status(400).send("Missing text");
    }

    const key = crypto.createHash("sha1").update(text).digest("hex");
    const cached = ttsCache.get(key);
    if (cached) {
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(cached);
    }

    // WAV placeholder 44 bytes
    const wav = Buffer.alloc(44);
    putCache(key, wav);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(wav);
  } catch (err) {
    console.error("TTS error:", err);
    return res.status(500).send("TTS error");
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 121000;
