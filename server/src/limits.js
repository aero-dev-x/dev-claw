import crypto from "node:crypto";
import db from "./db.js";

function num(name, d = 0) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    return d;
  }
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

/**
 * Public guest (IP-hashed) caps. 0 = unlimited.
 * Counts are UTC day, per hashed client key. Thread cap counts user+assistant messages
 * in the in-memory history for one guest view (excludes the new pair being sent).
 */
export const guestLimits = {
  dailyAssistantReplies: num("DEVCLAW_GUEST_DAILY_ASSISTANT_REPLY_LIMIT", 0),
  maxThreadMessages: num("DEVCLAW_GUEST_MAX_THREAD_MESSAGES", 0),
  customInstructionsMaxChars: num("DEVCLAW_GUEST_MAX_CUSTOM_INSTRUCTIONS", 2000),
};

/** 0 = unlimited for each */
export const limits = {
  /** Counts one completion per day (each assistant reply) */
  dailyAssistantReplies: num("DEVCLAW_DAILY_ASSISTANT_REPLY_LIMIT", 0),
  /** Max chat_sessions rows per user */
  maxChats: num("DEVCLAW_MAX_CHATS", 0),
  /**
   * Max message rows in one chat (user + assistant; one exchange = 2 rows).
   * Blocked when `currentCount + 2` would exceed this.
   */
  maxMessagesPerSession: num("DEVCLAW_MAX_MESSAGES_PER_SESSION", 0),
};

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export function getDailyAssistantReplies(userId) {
  const day = todayUtc();
  const row = db
    .prepare("SELECT assistant_replies FROM user_usage_daily WHERE user_id = ? AND day_utc = ?")
    .get(userId, day);
  return row ? row.assistant_replies : 0;
}

export function incrementDailyAssistantReplies(userId) {
  const day = todayUtc();
  const existing = db
    .prepare("SELECT 1 FROM user_usage_daily WHERE user_id = ? AND day_utc = ?")
    .get(userId, day);
  if (existing) {
    db.prepare(
      "UPDATE user_usage_daily SET assistant_replies = assistant_replies + 1 WHERE user_id = ? AND day_utc = ?"
    ).run(userId, day);
  } else {
    db.prepare("INSERT INTO user_usage_daily (user_id, day_utc, assistant_replies) VALUES (?, ?, 1)").run(
      userId,
      day
    );
  }
}

export function getChatCountForUser(userId) {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM chat_sessions WHERE user_id = ?")
    .get(userId);
  return row ? row.c : 0;
}

export function getMessageCountForSession(sessionId) {
  const row = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get(sessionId);
  return row ? row.c : 0;
}

/**
 * @returns {null | { status: 429, error: string }}
 */
export function checkDailyAssistantLimit(userId) {
  if (limits.dailyAssistantReplies <= 0) {
    return null;
  }
  if (getDailyAssistantReplies(userId) >= limits.dailyAssistantReplies) {
    return {
      status: 429,
      error: `Daily assistant limit reached (${limits.dailyAssistantReplies} replies per day, UTC). Try again tomorrow or ask an admin to raise DEVCLAW_DAILY_ASSISTANT_REPLY_LIMIT.`,
    };
  }
  return null;
}

export function checkNewChatLimit(userId) {
  if (limits.maxChats <= 0) {
    return null;
  }
  if (getChatCountForUser(userId) >= limits.maxChats) {
    return {
      status: 429,
      error: `Chat limit reached (${limits.maxChats} chats). Delete an old chat or raise DEVCLAW_MAX_CHATS.`,
    };
  }
  return null;
}

/**
 * Before sending a new user message we add user+assistant rows.
 */
export function checkSessionMessageLimit(sessionId) {
  if (limits.maxMessagesPerSession <= 0) {
    return null;
  }
  const n = getMessageCountForSession(sessionId);
  if (n + 2 > limits.maxMessagesPerSession) {
    return {
      status: 429,
      error: `This chat is full (${limits.maxMessagesPerSession} messages max). Start a new chat or raise DEVCLAW_MAX_MESSAGES_PER_SESSION.`,
    };
  }
  return null;
}

export function getUsageSnapshot(userId, sessionId) {
  const out = {
    dailyAssistantReplies: getDailyAssistantReplies(userId),
    dailyAssistantRepliesLimit: limits.dailyAssistantReplies,
    chatCount: getChatCountForUser(userId),
    chatCountLimit: limits.maxChats,
    sessionMessageCount: null,
    sessionMessageLimit: limits.maxMessagesPerSession,
  };
  if (sessionId != null && Number.isInteger(sessionId) && sessionId > 0) {
    out.sessionMessageCount = getMessageCountForSession(sessionId);
  }
  return out;
}

const guestSalt = process.env.DEVCLAW_GUEST_SALT || "devclaw-guest";

/**
 * Opaque per-request key (hashed client IP) for guest rate limits. Not reversible without salt.
 * @param {import("express").Request} req
 */
export function getGuestRequestKeyHash(req) {
  const ip =
    (req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim() || req.socket?.remoteAddress || "unknown";
  return crypto.createHash("sha256").update(String(ip) + "\0" + guestSalt, "utf8").digest("hex");
}

function getGuestDailyReplies(keyHash) {
  const day = todayUtc();
  const row = db
    .prepare("SELECT assistant_replies FROM guest_usage_daily WHERE key_hash = ? AND day_utc = ?")
    .get(keyHash, day);
  return row ? row.assistant_replies : 0;
}

export function incrementGuestDailyAssistantReplies(keyHash) {
  const day = todayUtc();
  const existing = db
    .prepare("SELECT 1 FROM guest_usage_daily WHERE key_hash = ? AND day_utc = ?")
    .get(keyHash, day);
  if (existing) {
    db.prepare(
      "UPDATE guest_usage_daily SET assistant_replies = assistant_replies + 1 WHERE key_hash = ? AND day_utc = ?"
    ).run(keyHash, day);
  } else {
    db.prepare("INSERT INTO guest_usage_daily (key_hash, day_utc, assistant_replies) VALUES (?, ?, 1)").run(
      keyHash,
      day
    );
  }
}

/**
 * @param {string} keyHash
 * @param {number} [threadMessageCount] — after the completed exchange
 */
export function getGuestUsageSnapshot(keyHash, threadMessageCount) {
  return {
    dailyAssistantReplies: getGuestDailyReplies(keyHash),
    dailyAssistantRepliesLimit: guestLimits.dailyAssistantReplies,
    sessionMessageCount: threadMessageCount == null ? null : threadMessageCount,
    sessionMessageLimit: guestLimits.maxThreadMessages,
    customInstructionsMaxChars: guestLimits.customInstructionsMaxChars,
  };
}

/**
 * @param {string} keyHash
 * @returns {null | { status: 429, error: string }}
 */
export function checkGuestDailyAssistantLimit(keyHash) {
  if (guestLimits.dailyAssistantReplies <= 0) {
    return null;
  }
  if (getGuestDailyReplies(keyHash) >= guestLimits.dailyAssistantReplies) {
    return {
      status: 429,
      error: `Guest daily assistant limit reached (${guestLimits.dailyAssistantReplies} replies per day, UTC). Try again tomorrow or use an account, or an admin can raise DEVCLAW_GUEST_DAILY_ASSISTANT_REPLY_LIMIT.`,
    };
  }
  return null;
}

/**
 * @param {number} historyLength — number of prior messages in the client thread
 * @returns {null | { status: 429, error: string }}
 */
export function checkGuestThreadMessageLimit(historyLength) {
  if (guestLimits.maxThreadMessages <= 0) {
    return null;
  }
  if (historyLength + 2 > guestLimits.maxThreadMessages) {
    return {
      status: 429,
      error: `This quick chat is full (${guestLimits.maxThreadMessages} messages max in one thread). Clear messages, sign in for a full account, or raise DEVCLAW_GUEST_MAX_THREAD_MESSAGES.`,
    };
  }
  return null;
}
