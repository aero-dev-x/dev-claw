import { useState, useEffect, useCallback, useRef, FormEvent } from "react";
import { Link } from "react-router-dom";
import { guestApi, postGuestMessageStream } from "../lib/api";
import { ModelCombobox } from "../components/ModelCombobox";
import type { ModelOption } from "../lib/modelOptions";
import { mergeModelListFromApi } from "../lib/modelOptions";

const STORAGE = {
  key: "devclaw_guest_model",
  system: "devclaw_guest_system",
  getModel: () => sessionStorage.getItem("devclaw_guest_model") || "gpt-4o-mini",
  getKey: () => sessionStorage.getItem("devclaw_guest_key") || "",
  getSystem: () => sessionStorage.getItem("devclaw_guest_system") || "",
  set: (modelId: string, apiKey: string) => {
    sessionStorage.setItem("devclaw_guest_model", modelId);
    sessionStorage.setItem("devclaw_guest_key", apiKey);
  },
  setSystem: (s: string) => {
    if (s.trim()) {
      sessionStorage.setItem("devclaw_guest_system", s);
    } else {
      sessionStorage.removeItem("devclaw_guest_system");
    }
  },
  clear: () => {
    sessionStorage.removeItem("devclaw_guest_model");
    sessionStorage.removeItem("devclaw_guest_key");
    sessionStorage.removeItem("devclaw_guest_system");
  },
};

type GuestUsage = {
  dailyAssistantReplies: number;
  dailyAssistantRepliesLimit: number;
  sessionMessageCount: number | null;
  sessionMessageLimit: number;
  customInstructionsMaxChars: number;
};

const defaultGuestUsage: GuestUsage = {
  dailyAssistantReplies: 0,
  dailyAssistantRepliesLimit: 0,
  sessionMessageCount: 0,
  sessionMessageLimit: 0,
  customInstructionsMaxChars: 2000,
};

/** Matches server `res.json({ error: "..." })` when `DEVCLAW_DISABLE_GUEST=1`. */
const GUEST_MODE_DISABLED = "Guest mode is disabled.";

type ChatMsg = { id: number; role: "user" | "assistant"; content: string };

type GuestGate = "checking" | "ok" | "disabled";

export function GuestChat() {
  const [guestGate, setGuestGate] = useState<GuestGate>("checking");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState(STORAGE.getModel);
  const [apiKey, setApiKey] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const [modelListOffline, setModelListOffline] = useState(false);
  const [setupErr, setSetupErr] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [guestUsage, setGuestUsage] = useState<GuestUsage | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (STORAGE.getKey()) {
      setApiKey(STORAGE.getKey());
    }
    setCustomInstructions(STORAGE.getSystem());
  }, []);

  const loadLimits = useCallback(() => {
    return guestApi<{ usage: GuestUsage }>("/api/guest/limits")
      .then((d) => setGuestUsage(d.usage))
      .catch((e) => {
        if (e instanceof Error && e.message === GUEST_MODE_DISABLED) {
          return;
        }
        setGuestUsage((u) => u ?? { ...defaultGuestUsage });
      });
  }, []);

  const loadModels = useCallback(() => {
    return guestApi<{ models: ModelOption[] }>("/api/guest/models")
      .then((d) => {
        setModelListOffline(false);
        return setModels(mergeModelListFromApi(d.models));
      })
      .catch((e) => {
        if (e instanceof Error && e.message === GUEST_MODE_DISABLED) {
          return;
        }
        setModelListOffline(true);
        setModels(mergeModelListFromApi([]));
      });
  }, []);

  useEffect(() => {
    void guestApi<{ usage: GuestUsage }>("/api/guest/limits")
      .then(() => {
        setGuestGate("ok");
      })
      .catch((e) => {
        if (e instanceof Error && e.message === GUEST_MODE_DISABLED) {
          setGuestGate("disabled");
          return;
        }
        setGuestGate("ok");
      });
  }, []);

  useEffect(() => {
    if (guestGate !== "ok") {
      return;
    }
    void loadModels();
  }, [guestGate, loadModels]);

  useEffect(() => {
    if (guestGate !== "ok") {
      return;
    }
    void loadLimits();
  }, [guestGate, loadLimits]);

  useEffect(() => {
    const el = messageListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const maxSystemLen = guestUsage?.customInstructionsMaxChars ?? defaultGuestUsage.customInstructionsMaxChars;

  function startChat(e: FormEvent) {
    e.preventDefault();
    if (guestGate !== "ok") {
      return;
    }
    setSetupErr(null);
    if (!modelId.trim() || !apiKey.trim()) {
      setSetupErr("Model name and API key are both required.");
      return;
    }
    if (customInstructions.length > maxSystemLen) {
      setSetupErr(`Custom instructions are too long (max ${maxSystemLen} characters).`);
      return;
    }
    STORAGE.set(modelId.trim(), apiKey.trim());
    STORAGE.setSystem(customInstructions);
    setStarted(true);
    setMessages([]);
    setErr(null);
    setGuestUsage((u) => (u ? { ...u, sessionMessageCount: 0 } : { ...defaultGuestUsage, sessionMessageCount: 0 }));
    void loadLimits();
  }

  function leaveGuest() {
    setStarted(false);
    setMessages([]);
  }

  function clearChat() {
    if (!window.confirm("Clear this conversation? Your key and model stay filled in.")) {
      return;
    }
    setMessages([]);
    setErr(null);
    setGuestUsage((u) => (u ? { ...u, sessionMessageCount: 0 } : u));
  }

  function resetGuest() {
    leaveGuest();
    STORAGE.clear();
    setApiKey("");
    setModelId("gpt-4o-mini");
    setCustomInstructions("");
  }

  async function sendMessage(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) {
      return;
    }
    if (customInstructions.length > maxSystemLen) {
      setErr(`Custom instructions are too long (max ${maxSystemLen} characters). Shorten them in Session options.`);
      return;
    }
    setSendBusy(true);
    setErr(null);
    setText("");
    const k = String(apiKey).trim();
    const m = String(modelId).trim();
    const userId = Date.now();
    const assistantId = userId + 1;
    const history: { role: "user" | "assistant"; content: string }[] = messages.map((x) => ({
      role: x.role,
      content: x.content,
    }));
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: t },
      { id: assistantId, role: "assistant", content: "" },
    ]);
    const sys = STORAGE.getSystem().trim();
    try {
      await postGuestMessageStream(
        {
          modelId: m,
          apiKey: k,
          text: t,
          history,
          customInstructions: sys || undefined,
        },
        {
          onDelta: (piece) => {
            setMessages((prev) =>
              prev.map((x) => (x.id === assistantId ? { ...x, content: x.content + piece } : x))
            );
          },
          onDone: (msg) => {
            setMessages((prev) =>
              prev.map((x) =>
                x.id === assistantId ? { id: assistantId, role: "assistant", content: msg.content } : x
              )
            );
          },
          onUsage: (u) => {
            setGuestUsage((prev) => ({ ...defaultGuestUsage, ...prev, ...(u as GuestUsage) }));
          },
        }
      );
    } catch (e2) {
      const msg = (e2 as Error).message;
      if (msg === GUEST_MODE_DISABLED) {
        setGuestGate("disabled");
        setStarted(false);
        setMessages([]);
        setErr(null);
      } else {
        setErr(msg);
        setMessages((prev) => prev.filter((x) => x.id !== userId && x.id !== assistantId));
      }
    } finally {
      setSendBusy(false);
    }
  }

  if (guestGate === "checking") {
    return (
      <div className="auth-page" style={{ paddingTop: "2.5rem" }}>
        <div className="auth-card" style={{ maxWidth: 480, textAlign: "center" }}>
          <p className="muted" style={{ margin: 0 }}>
            Checking quick chat…
          </p>
        </div>
      </div>
    );
  }

  if (guestGate === "disabled") {
    return (
      <div className="auth-page" style={{ alignItems: "flex-start", paddingTop: "2.5rem" }}>
        <div className="auth-card" style={{ maxWidth: 480 }}>
          <div className="brand">
            <h1>Quick try isn’t available here</h1>
            <p>
              This server has turned off unauthenticated quick chat. Create an account to use your own API keys, chats,
              and limits, or sign in.
            </p>
          </div>
          <p className="auth-footer" style={{ marginTop: "1.25rem" }}>
            <Link to="/signup" className="btn btn-primary" style={{ textDecoration: "none", marginRight: "0.5rem" }}>
              Sign up
            </Link>
            <Link to="/login" className="btn btn-ghost" style={{ textDecoration: "none" }}>
              Sign in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  if (!started) {
    return (
      <div className="auth-page" style={{ alignItems: "flex-start", paddingTop: "2.5rem" }}>
        <div className="auth-card" style={{ maxWidth: 480 }}>
          <div className="brand">
            <h1>Try without signing in</h1>
            <p>
              One quick chat. Your key is not saved on the server; this tab can keep it in session storage only. Usage
              limits (per IP, UTC) may apply; see the strip after you start.
            </p>
          </div>
          {setupErr && <div className="error-banner">{setupErr}</div>}
          {guestUsage && (guestUsage.dailyAssistantRepliesLimit > 0 || guestUsage.sessionMessageLimit > 0) && (
            <div className="usage-strip" style={{ marginBottom: "0.75rem" }} aria-label="Guest usage limits (preview)">
              <span>
                Today (UTC): <strong>{guestUsage.dailyAssistantReplies}</strong>
                {guestUsage.dailyAssistantRepliesLimit > 0
                  ? ` / ${guestUsage.dailyAssistantRepliesLimit} (guest limit)`
                  : " assistant replies"}
              </span>
              {guestUsage.sessionMessageLimit > 0 && (
                <span>
                  This thread: <strong>0</strong> / {guestUsage.sessionMessageLimit} messages max
                </span>
              )}
            </div>
          )}
          {modelListOffline && (
            <p className="hint" style={{ margin: "0 0 0.5rem" }}>
              Using the built-in model list; the server list was unavailable. You can still type any model id.
            </p>
          )}
          <form onSubmit={startChat} className="panel-form" style={{ border: "1px solid var(--border)" }}>
            <div className="form-field" style={{ marginTop: 0 }}>
              <label>Model (search, pick, or type the id)</label>
            </div>
            <ModelCombobox models={models} modelId={modelId} onModelIdChange={setModelId} />
            <div className="form-field" style={{ marginTop: "0.75rem" }}>
              <label htmlFor="guest-custom">Session — custom instructions (optional)</label>
              <textarea
                id="guest-custom"
                className="chat-composer-input"
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                maxLength={maxSystemLen}
                rows={3}
                placeholder="e.g. Answer briefly. Prefer bullet lists. This tab only; not sent until you start."
                style={{ minHeight: "4.5rem", resize: "vertical" as const }}
              />
              <p className="hint">
                Merged into the assistant&apos;s system prompt for this quick chat. Max {maxSystemLen} characters. Not
                stored on the server.
              </p>
            </div>
            <div className="form-field" style={{ marginTop: "0.75rem" }}>
              <label>API key (from your provider)</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                placeholder="sk-…, sk-ant-…, or Google AI (AIza…)"
                required
              />
              <p className="hint">OpenAI, Anthropic, or Google AI Studio. Nothing is sent until you start the chat.</p>
            </div>
            <button className="btn btn-primary btn-block" type="submit" style={{ marginTop: "0.5rem" }}>
              Start chat
            </button>
          </form>
          <p className="auth-footer" style={{ marginTop: "1.5rem" }}>
            <Link to="/signup">Create an account</Link> to save setups, multiple chats, and your own account limits.
            {" · "}
            <Link to="/login">Sign in</Link>
            {" · "}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="guest-app" style={{ display: "flex", flexDirection: "column", background: "var(--bg0)" }}>
      <header className="app-header">
        <div className="app-title" style={{ flex: 1 }}>
          DevClaw — <span className="muted" style={{ fontSize: "0.9rem" }}>quick chat (no account)</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" className="btn btn-ghost" onClick={clearChat} disabled={messages.length === 0}>
            Clear messages
          </button>
          <button type="button" className="btn btn-ghost" onClick={leaveGuest}>
            Change key / model
          </button>
          <Link to="/signup" className="btn btn-primary" style={{ textDecoration: "none" }}>
            Sign up
          </Link>
          <Link to="/login" className="btn btn-ghost" style={{ textDecoration: "none" }}>
            Sign in
          </Link>
        </div>
      </header>
      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          maxWidth: "var(--max-chat)",
          width: "100%",
          margin: "0 auto",
          padding: "0 0.5rem 1rem",
        }}
      >
        {guestUsage && (
          <div
            className="usage-strip"
            style={{ margin: "0.5rem 0" }}
            aria-label="Guest usage and session limits (UTC, per IP on this host)"
          >
            <span>
              Today (UTC): <strong>{guestUsage.dailyAssistantReplies}</strong>
              {guestUsage.dailyAssistantRepliesLimit > 0
                ? ` / ${guestUsage.dailyAssistantRepliesLimit} (limit)`
                : " assistant replies"}
            </span>
            {guestUsage.sessionMessageCount != null && (
              <span title="User + assistant messages in this quick chat.">
                This thread: {guestUsage.sessionMessageCount}
                {guestUsage.sessionMessageLimit > 0
                  ? ` / ${guestUsage.sessionMessageLimit} (max msg)`
                  : " messages"}
              </span>
            )}
          </div>
        )}
        <div className="chat-context" style={{ margin: "0.5rem 0" }} role="status">
          <span className="chat-context-label">Model</span>
          <code className="chat-context-model">{modelId}</code>
        </div>
        <details className="panel-form" style={{ border: "1px solid var(--border)", marginBottom: "0.5rem" }}>
          <summary style={{ cursor: "pointer", fontWeight: 600, padding: "0.35rem 0" }}>
            Session options — custom instructions
          </summary>
          <div className="form-field" style={{ marginTop: "0.5rem" }}>
            <label className="visually-hidden" htmlFor="guest-custom-active">
              Custom instructions
            </label>
            <textarea
              id="guest-custom-active"
              className="chat-composer-input"
              value={customInstructions}
              onChange={(e) => {
                setCustomInstructions(e.target.value);
                STORAGE.setSystem(e.target.value);
              }}
              maxLength={maxSystemLen}
              rows={3}
              placeholder="Optional: merged into the system prompt for the next message onward."
              style={{ minHeight: "4.5rem", resize: "vertical" as const }}
            />
            <p className="hint">
              Max {maxSystemLen} characters. Applies on send; this tab only. {customInstructions.length}/{maxSystemLen}
            </p>
          </div>
        </details>
        {err && (
          <div className="error-banner" style={{ margin: "0.5rem 0" }} role="alert">
            {err}
          </div>
        )}
        <div className="message-list" ref={messageListRef} style={{ minHeight: "40vh" }}>
          {messages.map((msg) => (
            <div key={msg.id} className={"msg " + (msg.role === "user" ? "user" : "assistant")}>
              <div className="role">{msg.role === "user" ? "You" : "Assistant"}</div>
              {msg.content}
            </div>
          ))}
        </div>
        <div className="composer-surface" style={{ marginTop: "auto" }}>
          <form className="composer" onSubmit={sendMessage} aria-label="Write a message">
            <label className="visually-hidden" htmlFor="guest-composer">
              Message
            </label>
            <textarea
              id="guest-composer"
              className="chat-composer-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Message…"
              rows={4}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              disabled={sendBusy}
            />
            <button className="btn btn-primary btn-send" type="submit" disabled={sendBusy || !text.trim()}>
              Send
            </button>
          </form>
          <p className="composer-hint">
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> new line
          </p>
        </div>
        <p className="hint" style={{ marginTop: "0.75rem", textAlign: "center" }}>
          One conversation in this view.{" "}
          <button type="button" className="btn btn-ghost" onClick={resetGuest} style={{ padding: "0.2rem 0.4rem" }}>
            Reset everything
          </button>
        </p>
      </main>
    </div>
  );
}
