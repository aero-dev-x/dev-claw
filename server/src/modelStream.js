/**
 * Provider streaming: yields UTF-8 text chunks for Express SSE relay.
 */
import { userFacingModelError } from "./userFacingModelError.js";

function makeThrow(message, status) {
  const e = new Error(String(message));
  e.statusCode = status;
  return e;
}

/**
 * @param {ReadableStream<Uint8Array>} body
 */
async function* openAIStreamIterator(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let carry = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    carry += dec.decode(value, { stream: true });
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") {
          return;
        }
        if (!dataStr) {
          continue;
        }
        let obj;
        try {
          obj = JSON.parse(dataStr);
        } catch {
          continue;
        }
        if (obj?.error?.message) {
          const err = new Error(String(obj.error.message));
          err.statusCode = 400;
          throw err;
        }
        const piece = obj?.choices?.[0]?.delta?.content;
        if (piece) {
          yield piece;
        }
      }
    }
  }
}

/**
 * @param {string} model
 * @param {string} apiKey
 * @param {{ role: string, content: string }[]} forProvider
 */
export async function* streamOpenAI(model, apiKey, forProvider) {
  const oStyle = String(model).startsWith("o1") || String(model).startsWith("o3");
  if (oStyle) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages: forProvider }),
    });
    const data = await r.json();
    if (!r.ok) {
      const err = data?.error?.message || r.statusText || "API error";
      throw makeThrow(err, r.status);
    }
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("Empty response from model.");
    }
    yield text;
    return;
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: forProvider,
      stream: true,
      temperature: 0.7,
    }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const err = data?.error?.message || r.statusText || "API error";
    throw makeThrow(err, r.status);
  }
  if (!r.body) {
    throw new Error("No response body from OpenAI.");
  }
  yield* openAIStreamIterator(r.body);
}

/**
 * @param {string} model
 * @param {string} apiKey
 * @param {{ role: string, content: string }[]} chatMessages
 */
export async function* streamAnthropic(model, apiKey, chatMessages) {
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
      stream: true,
      system: system || undefined,
      messages: payloadMessages,
    }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const err = data?.error?.message || r.statusText || "API error";
    throw makeThrow(err, r.status);
  }
  if (!r.body) {
    throw new Error("No response body from Anthropic.");
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let carry = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    carry += dec.decode(value, { stream: true });
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const dataStr = line.slice(6).trim();
        if (!dataStr) {
          continue;
        }
        let ev;
        try {
          ev = JSON.parse(dataStr);
        } catch {
          continue;
        }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          yield ev.delta.text;
        }
        if (ev.type === "message_delta" && ev.delta?.stop_reason) {
          /* end */
        }
        if (ev.type === "error" && ev.error) {
          throw new Error(String(ev.error?.message || ev.error));
        }
      }
    }
  }
}

/**
 * @param {string} apiKey
 * @param {string} modelName
 * @param {{ role: string, content: string }[]} chatMessages
 */
export async function* streamGoogleGemini(apiKey, modelName, chatMessages) {
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
    String(modelName).trim()
  )}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const errRaw = data?.error?.message || data?.error?.status || r.statusText || "API error";
    const err = userFacingModelError(String(errRaw), { provider: "google" });
    throw makeThrow(String(err), r.status);
  }
  if (!r.body) {
    throw new Error("No response body from Gemini.");
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let carry = "";
  let lastFull = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    carry += dec.decode(value, { stream: true });
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const dataStr = line.slice(6).trim();
        if (!dataStr) {
          continue;
        }
        let obj;
        try {
          obj = JSON.parse(dataStr);
        } catch {
          continue;
        }
        if (obj.error) {
          const msgRaw = String(obj.error.message || obj.error);
          const msg = userFacingModelError(msgRaw, { provider: "google" });
          const err = new Error(msg);
          err.statusCode = 400;
          throw err;
        }
        const parts = obj?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts) && parts[0] && parts[0].text != null) {
          const full = String(parts[0].text);
          if (full.length > lastFull.length) {
            yield full.slice(lastFull.length);
            lastFull = full;
          }
        }
      }
    }
  }
}
