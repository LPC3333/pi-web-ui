// ============================================================
// Express + Socket.IO server
// ============================================================
// Guard: if spawned as a subprocess by subagent, bail out
// (subagent may pick up this file as process.argv[1])
if (process.env.PI_SUBAGENT_GUARD || process.argv.some(a => a.includes("--subagent"))) {
  console.error("[server] Refusing to run server as subagent subprocess");
  process.exit(1);
}
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import multer from "multer";
import fs from "fs";
import {
  initPiService,
  setApiKey,
  getApiKeys,
  getAvailableModels,
  createSession,
  continueSession,
  getSessionDetail,
  listSessions,
  listPiHistorySessions,
  promptSession,
  abortSession,
  navigateTree,
  editMessage,
  disposeSession,
  renameSession,
  reconstructSession,
  getSessionFull,
  getBuiltinProviders,
  getCustomProviders,
  upsertCustomProvider,
  removeCustomProvider,
  scanModelsFromEndpoint,
  removeProviderKey,
} from "./pi-service.js";

// (pi-service is imported as .js for ESM compliance with tsx.)

const PORT = process.env.PORT || 3001;
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e8, // 100MB for large payloads
});

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Serve client in production
const clientDist = path.join(process.cwd(), "client", "dist");
app.use(express.static(clientDist));

// File upload storage — saves to a temp dir accessible by pi's read/bash tools
const UPLOADS_DIR = path.join(process.cwd(), ".pi-web", "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Clean up uploads older than 24 hours on startup
(function cleanupOldUploads() {
  try {
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const items = fs.readdirSync(UPLOADS_DIR);
    let removed = 0;
    for (const item of items) {
      const fullPath = path.join(UPLOADS_DIR, item);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > ONE_DAY) {
          if (stat.isFile()) {
            fs.unlinkSync(fullPath);
            removed++;
          } else if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            removed++;
          }
        }
      } catch { /* skip locked files */ }
    }
    if (removed > 0) console.log(`[server] Cleaned ${removed} old upload(s)`);
  } catch { /* dir may not exist yet */ }
})();

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      // Keep original filename, encode non-ASCII safely using Buffer
      const rawName = Buffer.from(file.originalname, "latin1").toString("utf-8");
      const safeName = rawName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
      cb(null, `${Date.now()}_${safeName}`);
    },
  }),
});

// ==================== REST API ====================

// Health
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// File upload — accepts file drops from the browser
app.post("/api/upload", upload.array("files", 20), (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ success: false, error: "No files uploaded" });
      return;
    }
    const paths = files.map(f => f.path);
    res.json({ success: true, data: { paths } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- Providers ----
app.get("/api/providers", (_req, res) => {
  try {
    const builtin = getBuiltinProviders();
    const custom = getCustomProviders();
    res.json({ success: true, data: { builtin, custom } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/providers/builtin", async (req, res) => {
  try {
    const { provider, key } = req.body;
    setApiKey(provider, key, true);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/providers/builtin/:provider", (req, res) => {
  try {
    removeProviderKey(req.params.provider);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/providers/custom", async (req, res) => {
  try {
    const { id, baseUrl, apiType, apiKey, models } = req.body;
    const result = await upsertCustomProvider({ id, baseUrl, apiType, apiKey, models });
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/providers/custom/:id", (req, res) => {
  try {
    removeCustomProvider(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/providers/scan", async (req, res) => {
  try {
    const { baseUrl, apiKey } = req.body;
    const models = await scanModelsFromEndpoint(baseUrl, apiKey);
    res.json({ success: true, data: models });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- API Keys (legacy - kept for compatibility) ----
app.post("/api/auth/keys", async (req, res) => {
  try {
    const { provider, key, persist } = req.body;
    setApiKey(provider, key, persist ?? true);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/auth/keys", (_req, res) => {
  res.json({ success: true, data: getApiKeys() });
});

// ---- Models ----
app.get("/api/models", async (_req, res) => {
  try {
    const models = await getAvailableModels();
    res.json({ success: true, data: models });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sessions — list
app.get("/api/sessions", async (req, res) => {
  try {
    const cwd = (req.query.cwd as string) || process.cwd();
    const list = await listSessions(cwd);
    res.json({ success: true, data: list });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sessions — list pi terminal history (~/.pi/agent/sessions/)
app.get("/api/sessions/history", async (_req, res) => {
  try {
    const list = await listPiHistorySessions();
    res.json({ success: true, data: list });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sessions — create
app.post("/api/sessions", async (req, res) => {
  try {
    const { name, cwd } = req.body;
    const summary = await createSession(name || "New Chat", cwd || process.cwd());
    res.json({ success: true, data: summary });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sessions — continue
app.post("/api/sessions/continue", async (req, res) => {
  try {
    const filePath = req.body?.filePath || req.query?.filePath;
    if (!filePath) {
      res.status(400).json({ success: false, error: "filePath is required" });
      return;
    }
    const summary = await continueSession(filePath);
    if (!summary) {
      res.status(404).json({ success: false, error: "Session not found" });
      return;
    }
    res.json({ success: true, data: summary });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sessions — detail
app.get("/api/sessions/:id", async (req, res) => {
  try {
    const detail = await getSessionDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ success: false, error: "Session not found" });
      return;
    }
    res.json({ success: true, data: detail });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Tree navigate
app.post("/api/sessions/:id/navigate", async (req, res) => {
  try {
    const { targetId } = req.body;
    const detail = await navigateTree(req.params.id, targetId);
    if (!detail) {
      res.status(404).json({ success: false, error: "Session not found" });
      return;
    }
    res.json({ success: true, data: detail });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Edit message
app.post("/api/sessions/:id/edit", async (req, res) => {
  try {
    const { entryId, newContent } = req.body;
    await editMessage(req.params.id, entryId, newContent);
    const detail = await getSessionDetail(req.params.id);
    res.json({ success: true, data: detail });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rename session
app.put("/api/sessions/rename", (req, res) => {
  try {
    const { id, name } = req.body;
    if (!id || !name || !name.trim()) {
      res.status(400).json({ success: false, error: "id and name are required" });
      return;
    }
    const ok = renameSession(decodeURIComponent(id), name.trim());
    if (!ok) {
      res.status(404).json({ success: false, error: "Session not found" });
      return;
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sessions — reconstruct (rebuild in-memory state from JSONL file)
app.post("/api/sessions/reconstruct", async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) {
      res.status(400).json({ success: false, error: "filePath is required" });
      return;
    }
    const summary = await reconstructSession(filePath);
    if (!summary) {
      res.status(404).json({ success: false, error: "Session file not found or could not be reconstructed" });
      return;
    }
    res.json({ success: true, data: summary });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sessions — get full raw entries (unfiltered, including system entries)
app.get("/api/sessions/:id/full", (req, res) => {
  try {
    const entries = getSessionFull(req.params.id);
    if (!entries) {
      res.status(404).json({ success: false, error: "Session not found" });
      return;
    }
    res.json({ success: true, data: entries });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sessions — import by file path (receives a JSONL file path from the client)
app.post("/api/sessions/import", async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) {
      res.status(400).json({ success: false, error: "filePath is required" });
      return;
    }
    const summary = await reconstructSession(filePath);
    if (!summary) {
      res.status(404).json({ success: false, error: "Session file not found or invalid" });
      return;
    }
    res.json({ success: true, data: summary });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete session
app.delete("/api/sessions/delete", (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      res.status(400).json({ success: false, error: "id is required" });
      return;
    }
    disposeSession(decodeURIComponent(id));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== WebSocket ====================

io.on("connection", (socket) => {
  console.log("[ws] Client connected:", socket.id);

  // Prompt with streaming
  socket.on("prompt", async (data: {
    sessionId: string;
    message: string;
    model?: string;
    provider?: string;
    thinkingLevel?: string;
  }) => {
    console.log("[ws] Prompt:", data.sessionId.slice(0, 8), data.message.slice(0, 60));

    await promptSession(
      {
        sessionId: data.sessionId,
        message: data.message,
        model: data.model,
        provider: data.provider,
        thinkingLevel: data.thinkingLevel as any,
      },
      (event) => {
        socket.emit("stream", { ...event, sessionId: data.sessionId });
      }
    );

    // After streaming, send updated session detail
    if (data.sessionId) {
      const detail = await getSessionDetail(data.sessionId);
      if (detail) {
        socket.emit("session_updated", detail);
      }
    }
  });

  // Abort
  socket.on("abort", async (data: { sessionId: string }) => {
    await abortSession(data.sessionId);
    socket.emit("stream", { type: "aborted", sessionId: data.sessionId });

    const detail = await getSessionDetail(data.sessionId);
    if (detail) {
      socket.emit("session_updated", detail);
    }
  });

  // Steer (queue message during streaming)
  socket.on("steer", async (data: { sessionId: string; message: string }) => {
    const { getSession } = await import("./pi-service.js");
    // We don't export sessions map, so just use a simpler approach
    socket.emit("error", { error: "Steer not yet implemented via WebSocket directly" });
  });

  socket.on("disconnect", () => {
    console.log("[ws] Client disconnected:", socket.id);
  });
});

// ==================== Start ====================

async function start() {
  await initPiService();
  httpServer.listen(PORT, () => {
    console.log(`[server] Pi Web UI running at http://localhost:${PORT}`);
  });
}

start();
