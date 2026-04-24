import { readSseDataJson } from "./sseChat";

/** Production: set in Vercel to your API base, e.g. https://dev-claw-api.onrender.com (no trailing slash). Dev: use Vite proxy (empty). */
const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? "";
const base = raw.replace(/\/$/, "");

export async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: string }).error || res.statusText;
    throw new Error(err);
  }
  return data as T;
}

export type StreamHandlers = {
  onDelta: (text: string) => void;
  onDone: (message: { id: number; role: string; content: string }) => void;
};

/**
 * Stream assistant reply (SSE: delta → done / error). Inserts the user message on the server first, then streams.
 */
export function postMessageStream(
  sessionId: number,
  text: string,
  handlers: StreamHandlers
): Promise<void> {
  return new Promise((resolve, reject) => {
    void (async () => {
      try {
        const res = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, stream: true }),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          const err = d.error || res.statusText;
          reject(new Error(err));
          return;
        }
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("text/event-stream") || !res.body) {
          const d = (await res.json()) as { message: { id: number; role: string; content: string } };
          if (d.message) {
            handlers.onDone(d.message);
          }
          resolve();
          return;
        }
        let finished = false;
        await readSseDataJson(res.body, (ev) => {
          if (ev.type === "delta" && typeof (ev as { text?: string }).text === "string") {
            handlers.onDelta((ev as { text: string }).text);
            return;
          }
          if (ev.type === "done" && ev.message && typeof (ev.message as { content: string }).content === "string") {
            const m = ev.message as { id: number; role: string; content: string };
            if (m.id == null) {
              finished = true;
              reject(new Error("Missing message id in stream response."));
              return;
            }
            finished = true;
            handlers.onDone(m);
            resolve();
            return;
          }
          if (ev.type === "error" && typeof (ev as { error?: string }).error === "string") {
            const msg = (ev as { error: string }).error;
            finished = true;
            reject(new Error(msg));
            return;
          }
        });
        if (!finished) {
          resolve();
        }
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}

export type GuestStreamHandlers = StreamHandlers & {
  onUsage?: (usage: unknown) => void;
};

export function postGuestMessageStream(
  body: {
    modelId: string;
    apiKey: string;
    text: string;
    history: { role: "user" | "assistant"; content: string }[];
    customInstructions?: string;
  },
  handlers: GuestStreamHandlers
): Promise<void> {
  return new Promise((resolve, reject) => {
    void (async () => {
      try {
        const res = await fetch(`${base}/api/guest/chat`, {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, stream: true }),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          reject(new Error(d.error || res.statusText));
          return;
        }
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("text/event-stream") || !res.body) {
          const d = (await res.json()) as { message: { content: string }; usage?: unknown };
          if (d.message) {
            handlers.onDone({ id: 0, role: "assistant", content: d.message.content });
            if (d.usage && handlers.onUsage) {
              handlers.onUsage(d.usage);
            }
          }
          resolve();
          return;
        }
        let finished = false;
        await readSseDataJson(res.body, (ev) => {
          if (ev.type === "delta" && typeof (ev as { text?: string }).text === "string") {
            handlers.onDelta((ev as { text: string }).text);
            return;
          }
          if (ev.type === "done" && ev.message) {
            const m = ev.message as { id?: number; role: string; content: string };
            finished = true;
            handlers.onDone({ id: m.id ?? 0, role: m.role, content: m.content });
            if (ev.usage && handlers.onUsage) {
              handlers.onUsage(ev.usage);
            }
            resolve();
            return;
          }
          if (ev.type === "error" && typeof (ev as { error?: string }).error === "string") {
            const msg = (ev as { error: string }).error;
            finished = true;
            reject(new Error(msg));
            return;
          }
        });
        if (!finished) {
          resolve();
        }
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}

/** Public guest endpoints: no session cookie (avoids auth conflicts). */
export async function guestApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...options,
    credentials: "omit",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: string }).error || res.statusText;
    throw new Error(err);
  }
  return data as T;
}
