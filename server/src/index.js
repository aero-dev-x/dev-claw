import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "./db.js";
import { encryptSecret, decryptSecret } from "./cryptoUtil.js";
import {
  checkDailyAssistantLimit,
  checkNewChatLimit,
  checkSessionMessageLimit,
  getUsageSnapshot,
  incrementDailyAssistantReplies,
  checkGuestDailyAssistantLimit,
  checkGuestThreadMessageLimit,
  getGuestRequestKeyHash,
  getGuestUsageSnapshot,
  incrementGuestDailyAssistantReplies,
  guestLimits,
} from "./limits.js";
import { streamOpenAI, streamAnthropic, streamGoogleGemini } from "./modelStream.js";
import { userFacingModelError } from "./userFacingModelError.js";
import {
  recordAssistantUsage,
  getUsageDashboard,
  estimateInputTokensFromMessages,
  charEstimateTokens,
} from "./usageRecord.js";

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const COOKIE_NAME = "devclaw_token";

app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) {
    return res.status(401).json({ error: "Sign in to continue." });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}

const builtInModels = [
  { id: "gpt-4o", label: "GPT-4o — OpenAI" },
  { id: "gpt-4o-mini", label: "GPT-4o mini — OpenAI" },
  { id: "o3-mini", label: "o3-mini — OpenAI" },
  { id: "o1", label: "o1 — OpenAI" },
  { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet — Anthropic" },
  { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku — Anthropic" },
  {
    id: "google/gemini-3-flash-preview",
    label: "Gemini 3 Flash (preview) — Google API key (AI Studio)",
  },
];

// --- auth ---
const signupSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120).trim(),
  agentName: z.string().min(1).max(80).trim(),
});

app.post("/api/auth/signup", (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Check your information and try again." });
  }
  const { email, password, name, agentName } = parsed.data;
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    return res.status(400).json({ error: "An account with this email already exists." });
  }
  const password_hash = bcrypt.hashSync(password, 12);
  const result = db
    .prepare("INSERT INTO users (email, password_hash, name, agent_name) VALUES (?, ?, ?, ?)")
    .run(email, password_hash, name, agentName);
  const user = db.prepare("SELECT id, email, name, agent_name FROM users WHERE id = ?").get(result.lastInsertRowid);
  const token = jwt.sign(
    { sub: String(user.id), email: user.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === "production",
  });
  return res.json({ user });
});

app.post("/api/auth/login", (req, res) => {
  const body = z
    .object({ email: z.string().email(), password: z.string().min(1) })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Enter your email and password." });
  }
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(body.data.email);
  if (!row || !bcrypt.compareSync(body.data.password, row.password_hash)) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  const user = { id: row.id, email: row.email, name: row.name, agent_name: row.agent_name };
  const token = jwt.sign({ sub: String(user.id), email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === "production",
  });
  return res.json({ user });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, { sameSite: "lax" });
  return res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, name, agent_name FROM users WHERE id = ?").get(req.user.id);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }
  return res.json({ user });
});

// --- models list ---
app.get("/api/models", requireAuth, (_req, res) => {
  return res.json({ models: builtInModels });
});

app.get("/api/usage", requireAuth, (req, res) => {
  const sessionId = req.query.sessionId ? Number(req.query.sessionId) : null;
  const sid = sessionId && Number.isInteger(sessionId) && sessionId > 0 ? sessionId : null;
  if (sid) {
    const row = db
      .prepare("SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?")
      .get(sid, req.user.id);
    if (!row) {
      return res.status(404).json({ error: "Chat not found." });
    }
  }
  return res.json({ usage: getUsageSnapshot(req.user.id, sid) });
});

/** Sign-up / signed-in only: token & cost style analytics (not available for /guest). */
app.get("/api/usage/dashboard", requireAuth, (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  return res.json({ dashboard: getUsageDashboard(req.user.id, days) });
});

// --- instances (assistant profiles) ---
function mapInstance(row) {
  return {
    id: row.id,
    name: row.name,
    modelId: row.model_id,
    hasApiKey: Boolean(row.api_key_enc),
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

app.get("/api/instances", requireAuth, (req, res) => {
  const rows = db
    .prepare("SELECT * FROM instances WHERE user_id = ? ORDER BY updated_at DESC")
    .all(req.user.id);
  return res.json({ instances: rows.map(mapInstance) });
});

app.post("/api/instances", requireAuth, (req, res) => {
  const body = z
    .object({
      name: z.string().min(1).max(120).trim(),
      modelId: z.string().min(1).max(200).trim(),
      apiKey: z.string().min(1).max(2000),
      notes: z.string().max(2000).optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Name, model, and API key are required." });
  }
  const { name, modelId, apiKey, notes = "" } = body.data;
  const enc = encryptSecret(apiKey);
  const r = db
    .prepare(
      "INSERT INTO instances (user_id, name, model_id, api_key_enc, notes) VALUES (?, ?, ?, ?, ?)"
    )
    .run(req.user.id, name, modelId, enc, notes);
  const row = db.prepare("SELECT * FROM instances WHERE id = ?").get(r.lastInsertRowid);
  return res.json({ instance: mapInstance(row) });
});

app.patch("/api/instances/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db
    .prepare("SELECT * FROM instances WHERE id = ? AND user_id = ?")
    .get(id, req.user.id);
  if (!row) {
    return res.status(404).json({ error: "Not found." });
  }
  const body = z
    .object({
      name: z.string().min(1).max(120).trim().optional(),
      modelId: z.string().min(1).max(200).trim().optional(),
      apiKey: z.string().min(1).max(2000).optional(),
      notes: z.string().max(2000).optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid data." });
  }
  const d = body.data;
  const name = d.name ?? row.name;
  const modelId = d.modelId ?? row.model_id;
  let enc = row.api_key_enc;
  if (d.apiKey) {
    enc = encryptSecret(d.apiKey);
  }
  const notes = d.notes !== undefined ? d.notes : row.notes;
  db.prepare(
    "UPDATE instances SET name = ?, model_id = ?, api_key_enc = ?, notes = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(name, modelId, enc, notes, id);
  const updated = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
  return res.json({ instance: mapInstance(updated) });
});

app.delete("/api/instances/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare("DELETE FROM instances WHERE id = ? AND user_id = ?").run(id, req.user.id);
  if (r.changes === 0) {
    return res.status(404).json({ error: "Not found." });
  }
  return res.json({ ok: true });
});

// --- chat sessions (conversations) ---
const DEFAULT_SESSION_PREFS = {
  thinking: "inherit",
  fast: "inherit",
  verbose: "inherit",
  reasoning: "inherit",
};

function normalizeSessionPrefValue(v) {
  if (v === "on" || v === "off" || v === "inherit") {
    return v;
  }
  return "inherit";
}

function parseSessionPrefs(prefsJson) {
  if (!prefsJson) {
    return { ...DEFAULT_SESSION_PREFS };
  }
  try {
    const o = JSON.parse(prefsJson);
    return {
      thinking: normalizeSessionPrefValue(o.thinking),
      fast: normalizeSessionPrefValue(o.fast),
      verbose: normalizeSessionPrefValue(o.verbose),
      reasoning: normalizeSessionPrefValue(o.reasoning),
    };
  } catch {
    return { ...DEFAULT_SESSION_PREFS };
  }
}

function serializeSessionPrefs(prefs) {
  return JSON.stringify({ ...DEFAULT_SESSION_PREFS, ...prefs });
}

/** Session-config flags (signed-in) merged into the system message. */
function augmentSystemForSession(base, prefsJson) {
  const p = parseSessionPrefs(prefsJson);
  const parts = [base];
  if (p.thinking === "on" || p.reasoning === "on") {
    parts.push("When it helps, outline your reasoning or steps before the final answer.");
  }
  if (p.fast === "on") {
    parts.push("Prefer short, scannable answers unless the user needs depth.");
  } else if (p.fast === "off") {
    parts.push("Take the space you need to answer fully.");
  }
  if (p.verbose === "on") {
    parts.push("Include useful context and be thorough when appropriate.");
  } else if (p.verbose === "off") {
    parts.push("Keep explanations compact.");
  }
  if (p.reasoning === "on") {
    parts.push("State assumptions and tradeoffs when they matter to the user.");
  }
  return parts.join("\n\n");
}

function mapSession(row) {
  return {
    id: row.id,
    instanceId: row.instance_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    prefs: parseSessionPrefs(row.prefs_json),
  };
}

app.get("/api/sessions", requireAuth, (req, res) => {
  const instanceId = req.query.instanceId ? Number(req.query.instanceId) : null;
  let rows;
  if (instanceId) {
    const inst = db
      .prepare("SELECT id FROM instances WHERE id = ? AND user_id = ?")
      .get(instanceId, req.user.id);
    if (!inst) {
      return res.status(404).json({ error: "Assistant setup not found." });
    }
    rows = db
      .prepare(
        "SELECT * FROM chat_sessions WHERE user_id = ? AND instance_id = ? ORDER BY updated_at DESC"
      )
      .all(req.user.id, instanceId);
  } else {
    rows = db
      .prepare("SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC")
      .all(req.user.id);
  }
  return res.json({ sessions: rows.map(mapSession) });
});

app.post("/api/sessions", requireAuth, (req, res) => {
  const body = z
    .object({
      instanceId: z.number().int().positive(),
      title: z.string().max(200).optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Choose an assistant setup first." });
  }
  const inst = db
    .prepare("SELECT id FROM instances WHERE id = ? AND user_id = ?")
    .get(body.data.instanceId, req.user.id);
  if (!inst) {
    return res.status(404).json({ error: "Assistant setup not found." });
  }
  const chatBlock = checkNewChatLimit(req.user.id);
  if (chatBlock) {
    return res.status(chatBlock.status).json({ error: chatBlock.error });
  }
  const title = body.data.title?.trim() || "New chat";
  const r = db
    .prepare(
      "INSERT INTO chat_sessions (user_id, instance_id, title) VALUES (?, ?, ?)"
    )
    .run(req.user.id, body.data.instanceId, title);
  const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(r.lastInsertRowid);
  return res.json({ session: mapSession(row) });
});

app.patch("/api/sessions/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const body = z.object({ title: z.string().min(1).max(200).trim() }).safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Enter a name for this chat." });
  }
  const r = db
    .prepare(
      "UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
    )
    .run(body.data.title, id, req.user.id);
  if (r.changes === 0) {
    return res.status(404).json({ error: "Not found." });
  }
  const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id);
  return res.json({ session: mapSession(row) });
});

const sessionBrowserTokenCap = () =>
  Math.min(10_000_000, Math.max(1000, Number(process.env.DEVCLAW_SESSION_TOKEN_CAP_DISPLAY) || 200_000));

/** Signed-in: full session list for the Sessions console (search, pagination, token ratio). */
app.get("/api/sessions/browser", requireAuth, (req, res) => {
  const userId = req.user.id;
  const q = (req.query.q || "").trim();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 120));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const instanceId = req.query.instanceId ? Number(req.query.instanceId) : null;
  const cap = sessionBrowserTokenCap();

  const where = [];
  const params = [];
  where.push("s.user_id = ?");
  params.push(userId);
  if (instanceId && Number.isInteger(instanceId) && instanceId > 0) {
    const ok = db.prepare("SELECT 1 FROM instances WHERE id = ? AND user_id = ?").get(instanceId, userId);
    if (ok) {
      where.push("s.instance_id = ?");
      params.push(instanceId);
    }
  }
  if (q) {
    const like = "%" + q + "%";
    where.push("(s.title LIKE ? OR i.name LIKE ? OR i.model_id LIKE ?)");
    params.push(like, like, like);
  }
  const whereSql = where.join(" AND ");

  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM chat_sessions s
       JOIN instances i ON i.id = s.instance_id AND i.user_id = s.user_id
       WHERE ` + whereSql
    )
    .get(...params);
  const total = countRow ? countRow.c : 0;

  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.updated_at, s.prefs_json, s.instance_id,
              i.name AS instance_name, i.model_id,
              COALESCE((SELECT SUM(e.total_tokens) FROM user_usage_events e WHERE e.session_id = s.id), 0) AS tokens_used
       FROM chat_sessions s
       JOIN instances i ON i.id = s.instance_id AND i.user_id = s.user_id
       WHERE ` +
        whereSql +
        ` ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const out = rows.map((r) => ({
    key: `agent:main:instance/${r.instance_id}/session/${r.id}`,
    kind: "direct",
    sessionId: r.id,
    title: r.title,
    instanceId: r.instance_id,
    instanceName: r.instance_name,
    modelId: r.model_id,
    updatedAt: r.updated_at,
    tokensUsed: r.tokens_used,
    tokenCap: cap,
    compaction: "none",
    prefs: parseSessionPrefs(r.prefs_json),
  }));

  return res.json({ rows: out, total, displayTokenCap: cap, limit, offset });
});

app.patch("/api/sessions/:id/prefs", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const prefSchema = z.enum(["inherit", "on", "off"]);
  const parsed = z
    .object({
      thinking: prefSchema.optional(),
      fast: prefSchema.optional(),
      verbose: prefSchema.optional(),
      reasoning: prefSchema.optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid preferences." });
  }
  const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?").get(id, req.user.id);
  if (!row) {
    return res.status(404).json({ error: "Not found." });
  }
  const cur = parseSessionPrefs(row.prefs_json);
  const next = { ...cur, ...parsed.data };
  db.prepare("UPDATE chat_sessions SET prefs_json = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(
    serializeSessionPrefs(next),
    id,
    req.user.id
  );
  const updated = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id);
  return res.json({ session: mapSession(updated) });
});

app.delete("/api/sessions/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const r = db
    .prepare("DELETE FROM chat_sessions WHERE id = ? AND user_id = ?")
    .run(id, req.user.id);
  if (r.changes === 0) {
    return res.status(404).json({ error: "Not found." });
  }
  return res.json({ ok: true });
});

app.get("/api/sessions/:id/messages", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const sess = db
    .prepare("SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?")
    .get(id, req.user.id);
  if (!sess) {
    return res.status(404).json({ error: "Chat not found." });
  }
  const messages = db
    .prepare("SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC")
    .all(id);
  return res.json({
    session: mapSession(sess),
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
    })),
  });
});

function modelRetryConfig() {
  return {
    max: Math.max(1, Math.min(8, Number(process.env.DEVCLAW_MODEL_RETRY_MAX) || 3)),
    baseMs: Math.max(200, Math.min(30_000, Number(process.env.DEVCLAW_MODEL_RETRY_BASE_MS) || 1_000)),
  };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Throttling / capacity text from OpenAI, Anthropic, or Google, or 429 / 5xx.
 */
function isRetriableModelError(e) {
  if (e && e.name === "ModelChatError") {
    return false;
  }
  const code = e && (e.statusCode != null ? e.statusCode : e.status);
  if (code != null) {
    if (code === 400 || code === 401 || code === 403 || code === 404 || code === 402) {
      return false;
    }
    if (code === 429 || code === 408) {
      return true;
    }
    if (code >= 500 && code <= 599) {
      return true;
    }
  }
  const msg = String((e && e.message) || e);
  if (!msg) {
    return false;
  }
  return /high demand|spikes in demand|try again|overloaded|temporar(ily|y)|rate limit|too many requests|Resource exhausted|exhaust|capacity|throttl|unavailable|server_error|concurrent|model is busy|5\d\d|429/i.test(
    msg
  );
}

async function withTransientModelRetry(fn) {
  const { max, baseMs } = modelRetryConfig();
  let last;
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt < max - 1 && isRetriableModelError(e)) {
        const delay = Math.min(baseMs * 2 ** attempt + Math.random() * 500, 20_000);
        await sleepMs(delay);
        continue;
      }
      throw e;
    }
  }
  throw last;
}

function throwWithStatus(message, status) {
  const e = new Error(message);
  e.statusCode = status;
  return e;
}

/** Which API was used for rate & analytics (matches runModelCompletion routing). */
function completionProviderName(model, apiKey) {
  const m = normalizeModelIdForProvider(model);
  if (isGoogleGeminiModel(m) || isLikelyGoogleGenerativeKey(apiKey)) {
    return "google";
  }
  if (m.startsWith("claude")) {
    return "anthropic";
  }
  return "openai";
}

async function callOpenAI(apiKey, model, chatMessages) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: chatMessages,
      ...(String(model).startsWith("o1") || String(model).startsWith("o3")
        ? {}
        : { temperature: 0.7 }),
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    const err = data?.error?.message || r.statusText || "API error";
    throw throwWithStatus(err, r.status);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("Empty response from model.");
  }
  const u = data?.usage;
  const inputT =
    u?.prompt_tokens != null ? u.prompt_tokens : estimateInputTokensFromMessages(chatMessages);
  const outputT =
    u?.completion_tokens != null ? u.completion_tokens : charEstimateTokens(String(text).length);
  return { text, inputTokens: inputT, outputTokens: outputT };
}

async function callAnthropic(apiKey, model, chatMessages) {
  const system = chatMessages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const payloadMessages = chatMessages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: system || undefined,
      messages: payloadMessages,
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    const err = data?.error?.message || r.statusText || "API error";
    throw throwWithStatus(err, r.status);
  }
  const block = data?.content?.[0];
  if (block?.type !== "text") {
    throw new Error("Unexpected response format.");
  }
  const uu = data?.usage;
  const text = block.text;
  const inputT = uu?.input_tokens != null ? uu.input_tokens : estimateInputTokensFromMessages(chatMessages);
  const outputT = uu?.output_tokens != null ? uu.output_tokens : charEstimateTokens(String(text).length);
  return { text, inputTokens: inputT, outputTokens: outputT };
}

function geminiModelNameForApi(model) {
  const s = String(model);
  if (s.startsWith("google/")) {
    return s.slice(7);
  }
  return s;
}

function isGoogleGeminiModel(model) {
  const s = String(model);
  if (s.startsWith("google/")) {
    return true;
  }
  if (/gemini/i.test(s) && s.includes("google")) {
    return true;
  }
  return s.startsWith("gemini") || s.includes("gemini-");
}

/**
 * Invisible or control chars in stored model ids (e.g. from DB) break `google/` and provider routing.
 */
function normalizeModelIdForProvider(model) {
  return String(model)
    .replace(/[\u200B-\u200D\uFEFF\0\u00A0\u00AD\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
}

/**
 * Strips BOM / zero-width / odd whitespace so provider detection is reliable
 * (otherwise "AIza…" can fail startsWith and get sent to the wrong API).
 * Also strips `\\0` (common after bad decrypt/encoding) and in-string ZWSP that breaks "AIza".
 */
function normalizeApiKeyString(apiKey) {
  let s = String(apiKey)
    .replace(/^\uFEFF+/, "")
    .replace(/^[\s\u200B-\u200D\uFEFF\u00A0]+/g, "")
    .replace(/\0/g, "")
    .trim();
  if (/^bearer\s+/i.test(s)) {
    s = s.replace(/^bearer\s+/i, "").trim();
  }
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length > 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length > 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/[\u200B-\u200D\uFEFF\0\u00A0\u00AD\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return s;
}

/** Google AI Studio / Generative Language API keys start with AIza. */
function isLikelyGoogleGenerativeKey(apiKey) {
  const k = normalizeApiKeyString(apiKey);
  if (k.startsWith("AIza")) {
    return true;
  }
  if (k.length >= 4 && k.slice(0, 4).toLowerCase() === "aiza") {
    return true;
  }
  const alnum = k.replace(/[^A-Za-z0-9_-]/g, "");
  if (alnum.startsWith("AIza") && alnum.length >= 12) {
    return true;
  }
  return false;
}

const DEFAULT_GEMINI_MODEL = process.env.DEVCLAW_GEMINI_DEFAULT_MODEL || "gemini-2.0-flash";

/**
 * @param {string} apiModelName - bare model id for the Generative Language API, e.g. gemini-2.0-flash
 */
async function callGoogleGemini(apiKey, apiModelName, chatMessages) {
  const modelName = String(apiModelName).trim();
  const system = chatMessages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const rest = chatMessages.filter((m) => m.role !== "system");
  const contents = rest.map((m) => {
    const role = m.role === "assistant" ? "model" : "user";
    return { role, parts: [{ text: m.content }] };
  });
  const body = {
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelName
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    const errRaw = data?.error?.message || data?.error?.status || r.statusText || "API error";
    const err = userFacingModelError(String(errRaw), { provider: "google" });
    throw throwWithStatus(String(err), r.status);
  }
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    throw new Error("Empty or blocked response from Gemini.");
  }
  const text = parts.map((p) => p.text || "").join("");
  if (!text) {
    throw new Error("Empty response from model.");
  }
  const um = data.usageMetadata;
  let inputT = um?.promptTokenCount;
  let outputT;
  if (um?.candidatesTokenCount != null) {
    outputT = um.candidatesTokenCount;
  } else if (um?.totalTokenCount != null && inputT != null) {
    outputT = Math.max(0, um.totalTokenCount - inputT);
  } else {
    outputT = charEstimateTokens(String(text).length);
  }
  if (inputT == null) {
    inputT = estimateInputTokensFromMessages(chatMessages);
  }
  return { text, inputTokens: inputT, outputTokens: outputT };
}

class ModelChatError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ModelChatError";
    this.status = status;
  }
}

/**
 * Call the right provider. Throws ModelChatError(400) on bad key/model match.
 * @param {string} model
 * @param {string} apiKey
 * @param {{ role: string, content: string }[]} forProvider
 */
async function runModelCompletion(model, apiKey, forProvider) {
  const m = normalizeModelIdForProvider(model);
  const k = normalizeApiKeyString(apiKey);
  const isGem = isGoogleGeminiModel(m);
  const isAnthropic = m.startsWith("claude");
  const keyIsGoogle = isLikelyGoogleGenerativeKey(apiKey);
  const keyIsOpenaiStyle = k.startsWith("sk-") && !k.startsWith("sk-ant-");

  if (isGem && (keyIsOpenaiStyle || k.startsWith("sk-ant-"))) {
    throw new ModelChatError(
      400,
      "This model is Gemini, but the key does not look like a Google (AIza) key. " +
        "Get one at https://aistudio.google.com/apikey and set the model name to a Gemini id (e.g. google/gemini-2.0-flash)."
    );
  }
  if (isAnthropic && keyIsGoogle) {
    throw new ModelChatError(
      400,
      "This is a Claude model. Use an Anthropic API key (sk-ant-… from console.anthropic.com), not a Google (AIza) key."
    );
  }
  if (m.startsWith("claude") && keyIsOpenaiStyle) {
    throw new ModelChatError(400, "Claude needs an Anthropic key (sk-ant-…), not an OpenAI sk- key.");
  }
  const useGoogleApi = isGem || keyIsGoogle;
  let googleApiModelName;
  if (useGoogleApi) {
    googleApiModelName = isGem ? geminiModelNameForApi(m) : DEFAULT_GEMINI_MODEL;
  }
  if (useGoogleApi) {
    const o = await withTransientModelRetry(() => callGoogleGemini(k, googleApiModelName, forProvider));
    return { text: o.text, inputTokens: o.inputTokens, outputTokens: o.outputTokens, provider: "google" };
  }
  if (isAnthropic) {
    const o = await withTransientModelRetry(() => callAnthropic(k, m, forProvider));
    return { text: o.text, inputTokens: o.inputTokens, outputTokens: o.outputTokens, provider: "anthropic" };
  }
  const o = await withTransientModelRetry(() => callOpenAI(k, m, forProvider));
  return { text: o.text, inputTokens: o.inputTokens, outputTokens: o.outputTokens, provider: "openai" };
}

/**
 * Same routing as `runModelCompletion` but async-generator chunks (no retry).
 * @param {string} model
 * @param {string} apiKey
 * @param {{ role: string, content: string }[]} forProvider
 */
async function* runModelCompletionStreamGen(model, apiKey, forProvider) {
  const m = normalizeModelIdForProvider(model);
  const k = normalizeApiKeyString(apiKey);
  const isGem = isGoogleGeminiModel(m);
  const isAnthropic = m.startsWith("claude");
  const keyIsGoogle = isLikelyGoogleGenerativeKey(apiKey);
  const keyIsOpenaiStyle = k.startsWith("sk-") && !k.startsWith("sk-ant-");

  if (isGem && (keyIsOpenaiStyle || k.startsWith("sk-ant-"))) {
    throw new ModelChatError(
      400,
      "This model is Gemini, but the key does not look like a Google (AIza) key. " +
        "Get one at https://aistudio.google.com/apikey and set the model name to a Gemini id (e.g. google/gemini-2.0-flash)."
    );
  }
  if (isAnthropic && keyIsGoogle) {
    throw new ModelChatError(
      400,
      "This is a Claude model. Use an Anthropic API key (sk-ant-… from console.anthropic.com), not a Google (AIza) key."
    );
  }
  if (m.startsWith("claude") && keyIsOpenaiStyle) {
    throw new ModelChatError(400, "Claude needs an Anthropic key (sk-ant-…), not an OpenAI sk- key.");
  }
  const useGoogleApi = isGem || keyIsGoogle;
  const googleApiModelName = useGoogleApi
    ? isGem
      ? geminiModelNameForApi(m)
      : DEFAULT_GEMINI_MODEL
    : "";
  if (useGoogleApi) {
    yield* streamGoogleGemini(k, googleApiModelName, forProvider);
    return;
  }
  if (isAnthropic) {
    yield* streamAnthropic(k, m, forProvider);
    return;
  }
  yield* streamOpenAI(k, m, forProvider);
}

function writeSseData(res, obj) {
  if (res.writableEnded) {
    return;
  }
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const guestModeDisabled = () => process.env.DEVCLAW_DISABLE_GUEST === "1";

// --- public guest: one chat, no account (set DEVCLAW_DISABLE_GUEST=1 to turn off) ---
app.get("/api/guest/models", (_req, res) => {
  if (guestModeDisabled()) {
    return res.status(404).json({ error: "Guest mode is disabled." });
  }
  return res.json({ models: builtInModels });
});

app.get("/api/guest/limits", (req, res) => {
  if (guestModeDisabled()) {
    return res.status(404).json({ error: "Guest mode is disabled." });
  }
  const keyHash = getGuestRequestKeyHash(req);
  return res.json({ usage: getGuestUsageSnapshot(keyHash, 0) });
});

app.post("/api/guest/chat", async (req, res) => {
  if (guestModeDisabled()) {
    return res.status(404).json({ error: "Guest mode is disabled." });
  }
  const parsed = z
    .object({
      modelId: z.string().min(1).max(200).trim(),
      apiKey: z.string().min(1).max(2000),
      text: z.string().min(1).max(120000),
      stream: z.boolean().optional(),
      customInstructions: z.string().max(8000).optional(),
      history: z
        .array(
          z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(0).max(200000),
          })
        )
        .max(200)
        .optional()
        .default([]),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Model, API key, and message are required." });
  }
  const { modelId, apiKey, text, history } = parsed.data;
  const wantStream = parsed.data.stream === true;
  const customRaw = (parsed.data.customInstructions || "").trim();
  if (customRaw.length > guestLimits.customInstructionsMaxChars) {
    return res.status(400).json({
      error: `Custom instructions are too long (max ${guestLimits.customInstructionsMaxChars} characters).`,
    });
  }
  const keyHash = getGuestRequestKeyHash(req);
  const threadBlock = checkGuestThreadMessageLimit(history.length);
  if (threadBlock) {
    return res.status(threadBlock.status).json({ error: threadBlock.error });
  }
  const dailyBlock = checkGuestDailyAssistantLimit(keyHash);
  if (dailyBlock) {
    return res.status(dailyBlock.status).json({ error: dailyBlock.error });
  }

  const base = `You are a friendly assistant. Be clear and helpful for someone who may not be technical. Today is a quick chat: no account, one conversation.`;
  const system = customRaw ? `${base}\n\nAdditional instructions from the user:\n${customRaw}` : base;
  const forProvider = [
    { role: "system", content: system },
    ...history,
    { role: "user", content: String(text).trim() },
  ];
  if (wantStream) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }
    let full = "";
    try {
      for await (const chunk of runModelCompletionStreamGen(modelId, apiKey, forProvider)) {
        full += chunk;
        writeSseData(res, { type: "delta", text: chunk });
      }
      incrementGuestDailyAssistantReplies(keyHash);
      const usage = getGuestUsageSnapshot(keyHash, history.length + 2);
      writeSseData(res, { type: "done", message: { role: "assistant", content: full }, usage });
      return res.end();
    } catch (e) {
      if (e.name === "ModelChatError" && e.status) {
        writeSseData(res, { type: "error", error: e.message, status: e.status });
      } else {
        const msg = e?.message || "Could not reach the model.";
        writeSseData(res, { type: "error", error: String(msg) });
      }
      return res.end();
    }
  }
  try {
    const out = await runModelCompletion(modelId, apiKey, forProvider);
    incrementGuestDailyAssistantReplies(keyHash);
    const usage = getGuestUsageSnapshot(keyHash, history.length + 2);
    return res.json({ message: { role: "assistant", content: out.text }, usage });
  } catch (e) {
    if (e.name === "ModelChatError" && e.status) {
      return res.status(e.status).json({ error: e.message });
    }
    const msg = e?.message || "Could not reach the model.";
    return res.status(502).json({ error: msg });
  }
});

app.post("/api/sessions/:id/messages", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = z
    .object({
      text: z.string().min(1).max(120000),
      stream: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Type a message to send." });
  }
  const text = parsed.data.text.trim();
  const wantStream = parsed.data.stream === true;
  const sess = db
    .prepare("SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?")
    .get(id, req.user.id);
  if (!sess) {
    return res.status(404).json({ error: "Chat not found." });
  }
  const inst = db
    .prepare("SELECT * FROM instances WHERE id = ? AND user_id = ?")
    .get(sess.instance_id, req.user.id);
  if (!inst) {
    return res.status(404).json({ error: "Assistant setup is missing." });
  }
  const apiKey = decryptSecret(inst.api_key_enc);
  if (!apiKey) {
    return res.status(400).json({ error: "Add an API key to this assistant setup." });
  }

  const dailyBlock = checkDailyAssistantLimit(req.user.id);
  if (dailyBlock) {
    return res.status(dailyBlock.status).json({ error: dailyBlock.error });
  }
  const sessionMsgBlock = checkSessionMessageLimit(id);
  if (sessionMsgBlock) {
    return res.status(sessionMsgBlock.status).json({ error: sessionMsgBlock.error });
  }

  const userRow = db
    .prepare("SELECT agent_name, name FROM users WHERE id = ?")
    .get(req.user.id);
  const systemPrompt = augmentSystemForSession(
    `You are ${userRow.agent_name}, a friendly assistant for ${userRow.name}. Be clear and helpful for someone who may not be technical.`,
    sess.prefs_json
  );

  db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)").run(
    id,
    text
  );
  const prior = db
    .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC")
    .all(id);

  // Retitle first message
  if (prior.length === 1) {
    const shortTitle = text.length > 48 ? text.slice(0, 45) + "…" : text;
    db.prepare("UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?").run(
      shortTitle,
      id
    );
  } else {
    db.prepare("UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?").run(id);
  }

  const forProvider = [
    { role: "system", content: systemPrompt },
    ...prior
      .filter((x) => x.role !== "system")
      .map((x) => ({ role: x.role, content: x.content })),
  ];

  if (wantStream) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }
    let full = "";
    try {
      for await (const chunk of runModelCompletionStreamGen(inst.model_id, apiKey, forProvider)) {
        full += chunk;
        writeSseData(res, { type: "delta", text: chunk });
      }
      const ins = db
        .prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)")
        .run(id, full);
      incrementDailyAssistantReplies(req.user.id);
      recordAssistantUsage({
        userId: req.user.id,
        sessionId: id,
        instanceId: inst.id,
        modelId: inst.model_id,
        provider: completionProviderName(inst.model_id, apiKey),
        inputTokens: estimateInputTokensFromMessages(forProvider),
        outputTokens: charEstimateTokens(full.length),
      });
      writeSseData(res, {
        type: "done",
        message: { id: ins.lastInsertRowid, role: "assistant", content: full },
      });
      return res.end();
    } catch (e) {
      if (e.name === "ModelChatError" && e.status) {
        writeSseData(res, { type: "error", error: e.message, status: e.status });
      } else {
        const msg = e?.message || "Could not reach the model.";
        writeSseData(res, { type: "error", error: String(msg) });
      }
      return res.end();
    }
  }

  try {
    const out = await runModelCompletion(inst.model_id, apiKey, forProvider);

    const ins = db
      .prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)")
      .run(id, out.text);
    incrementDailyAssistantReplies(req.user.id);
    recordAssistantUsage({
      userId: req.user.id,
      sessionId: id,
      instanceId: inst.id,
      modelId: inst.model_id,
      provider: out.provider,
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
    });
    return res.json({
      message: {
        id: ins.lastInsertRowid,
        role: "assistant",
        content: out.text,
      },
    });
  } catch (e) {
    if (e.name === "ModelChatError" && e.status) {
      return res.status(e.status).json({ error: e.message });
    }
    const msg = e?.message || "Could not reach the model.";
    return res.status(502).json({ error: msg });
  }
});

app.get("/api/health", (_req, res) => {
  return res.json({ ok: true, name: "DevClaw" });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  return res.status(500).json({ error: "Something went wrong." });
});

app.listen(PORT, () => {
  console.log(`DevClaw server http://localhost:${PORT}`);
});
