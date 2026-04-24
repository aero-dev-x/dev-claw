import db from "./db.js";

/**
 * Heuristic: ~4 characters per token (used when provider omits token counts, e.g. some streams).
 */
export function charEstimateTokens(n) {
  if (!n || n < 0) {
    return 0;
  }
  return Math.max(0, Math.ceil(n / 4));
}

export function estimateInputTokensFromMessages(chatMessages) {
  try {
    return charEstimateTokens(JSON.stringify(chatMessages).length);
  } catch {
    return 0;
  }
}

const numEnv = (name, d) => {
  const v = process.env[name];
  if (v === undefined || v === "") {
    return d;
  }
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/** Default USD per 1M input / output tokens (rough, for display only). Env overrides. */
const pricePer1M = {
  openai: { in: numEnv("DEVCLAW_USAGE_OPENAI_IN_PER_1M", 2.5), out: numEnv("DEVCLAW_USAGE_OPENAI_OUT_PER_1M", 10) },
  anthropic: {
    in: numEnv("DEVCLAW_USAGE_ANTHROPIC_IN_PER_1M", 3),
    out: numEnv("DEVCLAW_USAGE_ANTHROPIC_OUT_PER_1M", 15),
  },
  google: { in: numEnv("DEVCLAW_USAGE_GOOGLE_IN_PER_1M", 0.15), out: numEnv("DEVCLAW_USAGE_GOOGLE_OUT_PER_1M", 0.6) },
};

export function estimateCostUsd(provider, inputTokens, outputTokens) {
  const p = pricePer1M[provider] || pricePer1M.openai;
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

/**
 * @param {object} p
 * @param {number} p.userId
 * @param {number} p.sessionId
 * @param {number} p.instanceId
 * @param {string} p.modelId
 * @param {'openai'|'anthropic'|'google'} p.provider
 * @param {number} p.inputTokens
 * @param {number} p.outputTokens
 */
export function recordAssistantUsage(p) {
  const total = Math.max(0, p.inputTokens) + Math.max(0, p.outputTokens);
  const est = estimateCostUsd(p.provider, p.inputTokens, p.outputTokens);
  db.prepare(
    `INSERT INTO user_usage_events (user_id, session_id, instance_id, model_id, provider, input_tokens, output_tokens, total_tokens, est_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    p.userId,
    p.sessionId,
    p.instanceId,
    p.modelId,
    p.provider,
    Math.max(0, Math.floor(p.inputTokens)),
    Math.max(0, Math.floor(p.outputTokens)),
    total,
    Math.round(est * 1_000_000) / 1_000_000
  );
}

/**
 * @param {number} userId
 * @param {number} days 1–90
 */
export function getUsageDashboard(userId, days) {
  const d = Math.min(90, Math.max(1, Math.floor(Number(days) || 7)));
  const fromSql = "datetime('now', '-" + d + " days')";
  const row = db
    .prepare(
      `SELECT 
        COALESCE(SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END), 0) AS user_msgs,
        COALESCE(SUM(CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END), 0) AS assistant_msgs
      FROM messages m
      JOIN chat_sessions s ON s.id = m.session_id
      WHERE s.user_id = ? AND m.created_at >= ` +
        fromSql
    )
    .get(userId);
  const eventAgg = db
    .prepare(
      `SELECT 
        COALESCE(SUM(input_tokens), 0) AS input_sum,
        COALESCE(SUM(output_tokens), 0) AS output_sum,
        COALESCE(SUM(total_tokens), 0) AS total_sum,
        COALESCE(SUM(est_cost_usd), 0) AS cost_sum,
        COUNT(*) AS events
      FROM user_usage_events
      WHERE user_id = ? AND created_at >= ` +
        fromSql
    )
    .get(userId);
  const byDay = db
    .prepare(
      `SELECT 
        date(created_at) AS day_utc,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(est_cost_usd), 0) AS est_cost_usd
      FROM user_usage_events
      WHERE user_id = ? AND created_at >= ` +
        fromSql +
        ` GROUP BY date(created_at) ORDER BY day_utc ASC`
    )
    .all(userId);
  const byModel = db
    .prepare(
      `SELECT 
        model_id,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
        COALESCE(SUM(est_cost_usd), 0) AS est_cost_usd,
        COUNT(*) AS completions
      FROM user_usage_events
      WHERE user_id = ? AND created_at >= ` +
        fromSql +
        ` GROUP BY model_id ORDER BY total_tokens DESC LIMIT 8`
    )
    .all(userId);
  const byProvider = db
    .prepare(
      `SELECT 
        provider,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
        COALESCE(SUM(est_cost_usd), 0) AS est_cost_usd
      FROM user_usage_events
      WHERE user_id = ? AND created_at >= ` +
        fromSql +
        ` GROUP BY provider`
    )
    .all(userId);
  const recentSessions = db
    .prepare(
      `SELECT 
        e.id,
        e.session_id,
        e.model_id,
        e.provider,
        e.input_tokens,
        e.output_tokens,
        e.total_tokens,
        e.est_cost_usd,
        e.created_at,
        s.title AS session_title
      FROM user_usage_events e
      JOIN chat_sessions s ON s.id = e.session_id AND s.user_id = e.user_id
      WHERE e.user_id = ? AND e.created_at >= ` +
        fromSql +
        ` ORDER BY e.id DESC LIMIT 20`
    )
    .all(userId);
  const sessionCount = db
    .prepare("SELECT COUNT(*) AS c FROM chat_sessions WHERE user_id = ?")
    .get(userId);
  return {
    range: { days: d },
    messages: {
      user: row ? row.user_msgs : 0,
      assistant: row ? row.assistant_msgs : 0,
    },
    fromEvents: {
      inputTokens: eventAgg ? eventAgg.input_sum : 0,
      outputTokens: eventAgg ? eventAgg.output_sum : 0,
      totalTokens: eventAgg ? eventAgg.total_sum : 0,
      estCostUsd: eventAgg ? eventAgg.cost_sum : 0,
      completionEvents: eventAgg ? eventAgg.events : 0,
    },
    byDay: byDay.map((x) => ({
      day: x.day_utc,
      inputTokens: x.input_tokens,
      outputTokens: x.output_tokens,
      totalTokens: x.total_tokens,
      estCostUsd: x.est_cost_usd,
    })),
    topModels: byModel.map((x) => ({
      modelId: x.model_id,
      totalTokens: x.total_tokens,
      estCostUsd: x.est_cost_usd,
      completions: x.completions,
    })),
    topProviders: byProvider.map((x) => ({
      provider: x.provider,
      totalTokens: x.total_tokens,
      estCostUsd: x.est_cost_usd,
    })),
    recentSessions: recentSessions.map((x) => ({
      id: x.id,
      sessionId: x.session_id,
      sessionTitle: x.session_title,
      modelId: x.model_id,
      provider: x.provider,
      inputTokens: x.input_tokens,
      outputTokens: x.output_tokens,
      totalTokens: x.total_tokens,
      estCostUsd: x.est_cost_usd,
      createdAt: x.created_at,
    })),
    accountSessions: sessionCount ? sessionCount.c : 0,
  };
}
