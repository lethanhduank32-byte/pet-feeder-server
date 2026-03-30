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

// Ho tro ESP32 gui raw wav truc tiep
app.use(
  "/api/stt-command-raw",
  express.raw({
    type: ["audio/wav", "audio/x-wav", "application/octet-stream"],
    limit: "2mb",
  })
);

// Ho tro cach hien tai: multipart/form-data
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

// Cache TTS don gian trong RAM
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

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ==============================
// PHAN HOI TU NHIEN
// ==============================
const naturalReplies = {
  feed_now: [
    "Da cho an roi nhe",
    "Minh vua cho an xong roi nhe",
    "Xong roi nhe, vat nuoi da duoc cho an",
    "Da hoan thanh cho an roi nhe",
  ],
  pump_on_manual: [
    "Minh da bat bom nuoc roi nhe",
    "Bom nuoc dang duoc bat roi nhe",
    "Da bat bom nuoc cho ban roi",
  ],
  pump_off_manual: [
    "Minh da tat bom nuoc roi nhe",
    "Nuoc da du roi, minh tat bom nhe",
    "Da tat bom nuoc thanh cong",
  ],
  disable_extra_feed_time: [
    "Minh da xoa gio an them roi nhe",
    "Gio an them da duoc huy roi",
    "Da xoa lich an them cho ban",
  ],
  unknown: [
    "Minh chua hieu lenh nay, ban noi lai giup minh nhe",
    "Lenh nay minh chua ho tro, ban thu noi cach khac nhe",
    "Minh nghe chua ro, ban noi lai giup minh nhe",
  ],
};

function naturalMessage(action, fallback) {
  const list = naturalReplies[action];
  if (list && list.length > 0) return pickRandom(list);
  return fallback || "Da thuc hien lenh";
}

function buildExtraFeedTimeMessage(hour, minute) {
  const mm = String(minute).padStart(2, "0");
  const options = [
    `Minh da dat gio an them luc ${hour} gio ${mm} phut roi nhe`,
    `Da luu gio an them la ${hour} gio ${mm} phut`,
    `Xong roi nhe, minh da hen gio an them luc ${hour} gio ${mm} phut`,
  ];
  return pickRandom(options);
}

// ==============================
// PHAN TICH LENH TIENG VIET
// ==============================
function parseVietnameseCommand(text) {
  const raw = normalizeText(text);
  const t = normVN(text);

  if (!t) {
    return {
      ok: false,
      action: "none",
      message: "Minh nghe chua ro, ban noi lai giup minh nhe",
    };
  }

  if (t.includes("xoa gio an them")) {
    return {
      ok: true,
      action: "disable_extra_feed_time",
      message: naturalMessage(
        "disable_extra_feed_time",
        "Da xoa gio an them"
      ),
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
        message: buildExtraFeedTimeMessage(hour, minute),
        params: { hour, minute },
      };
    }

    return {
      ok: false,
      action: "none",
      message: "Gio an them chua hop le, ban thu lai nhe",
    };
  }

  if (t.includes("bat bom nuoc") || t.includes("bat bom")) {
    return {
      ok: true,
      action: "pump_on_manual",
      message: naturalMessage("pump_on_manual", "Da bat bom nuoc"),
    };
  }

  if (t.includes("tat bom nuoc") || t.includes("tat bom")) {
    return {
      ok: true,
      action: "pump_off_manual",
      message: naturalMessage("pump_off_manual", "Da tat bom nuoc"),
    };
  }

  if (t.includes("cho an")) {
    return {
      ok: true,
      action: "feed_now",
      message: naturalMessage("feed_now", "Da cho an"),
    };
  }

  return {
    ok: false,
    action: "none",
    message: naturalMessage("unknown"),
  };
}

// ==============================
// ROUTES CO BAN
// ==============================
app.get("/", (req, res) => {
  res.type("text/plain").send("pet-feeder-server OK");
});

app.get("/healthz", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "pet-feeder-server",
    uptime_sec: Math.round(process.uptime()),
    now: new Date().toISOString(),
  });
});

app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

// ==============================
// STT DEMO / FALLBACK
// Hien tai de test luong ESP32 -> server -> JSON
// Ban co the doi tam dong return de test cac lenh khac nhau
// ==============================
async function speechToTextFromBuffer(buffer) {
  if (!buffer || !buffer.length) return "";

  // DOI DONG DUOI NEU MUON TEST LENH KHAC:
  // return "bat bom nuoc";
  // return "tat bom nuoc";
  // return "cho an them 9 gio 20 phut";
  // return "xoa gio an them";

  return "cho an";
}

// API dang khop voi ESP32 hien tai: multipart/form-data
app.post("/api/stt-command", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        action: "none",
        message: "Thieu file audio",
      });
    }

    const transcript = await speechToTextFromBuffer(req.file.buffer);
    const result = parseVietnameseCommand(transcript);

    return res.json({
      ...result,
      transcript_raw: transcript,
    });
  } catch (err) {
    console.error("STT multipart error:", err);
    return res.status(500).json({
      ok: false,
      action: "none",
      message: "Loi xu ly giong noi",
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
        message: "Thieu du lieu audio",
      });
    }

    const transcript = await speechToTextFromBuffer(req.body);
    const result = parseVietnameseCommand(transcript);

    return res.json({
      ...result,
      transcript_raw: transcript,
    });
  } catch (err) {
    console.error("STT raw error:", err);
    return res.status(500).json({
      ok: false,
      action: "none",
      message: "Loi xu ly audio raw",
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
