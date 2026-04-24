import { useEffect, useState, useCallback, useRef, FormEvent } from "react";
import { useAuth } from "../authContext";
import { api, postMessageStream } from "../lib/api";
import { ModelCombobox } from "../components/ModelCombobox";
import type { ModelOption } from "../lib/modelOptions";
import { mergeModelListFromApi } from "../lib/modelOptions";
import { useNavigate, Link, useSearchParams } from "react-router-dom";

type Instance = {
  id: number;
  name: string;
  modelId: string;
  hasApiKey: boolean;
  notes: string;
  updatedAt: string;
};

type SessionPrefs = { thinking: string; fast: string; verbose: string; reasoning: string };

type Session = {
  id: number;
  instanceId: number;
  title: string;
  updatedAt: string;
  createdAt?: string;
  prefs?: SessionPrefs;
};

type Msg = { id: number; role: string; content: string };

type UsageSnapshot = {
  dailyAssistantReplies: number;
  dailyAssistantRepliesLimit: number;
  chatCount: number;
  chatCountLimit: number;
  sessionMessageCount: number | null;
  sessionMessageLimit: number;
};

export function Home() {
  const { user, setUser } = useAuth();
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const openSessionFromUrl = useRef<number | null>(null);
  const activeIdRef = useRef<number | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  activeIdRef.current = activeId;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<number | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [keyFormErr, setKeyFormErr] = useState<string | null>(null);

  const [newName, setNewName] = useState("Work helper");
  const [newModelId, setNewModelId] = useState("gpt-4o-mini");
  const [newKey, setNewKey] = useState("");
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [updateKey, setUpdateKey] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const PLACEHOLDER_USER_ID = -1;
  const PLACEHOLDER_ASSISTANT_ID = -2;

  const loadInstances = useCallback(() => {
    return api<{ instances: Instance[] }>("/api/instances").then((d) => {
      setInstances(d.instances);
    });
  }, []);

  const loadModels = useCallback(() => {
    return api<{ models: ModelOption[] }>("/api/models").then((d) => setModels(mergeModelListFromApi(d.models)));
  }, []);

  useEffect(() => {
    loadModels().catch(() => setErr("Could not load model list."));
  }, [loadModels]);

  useEffect(() => {
    loadInstances().catch(() => setErr("Could not load your setups."));
  }, [loadInstances]);

  useEffect(() => {
    if (instances.length === 0) {
      setActiveId(null);
    } else if (activeId == null) {
      setActiveId(instances[0].id);
    } else if (!instances.some((i) => i.id === activeId)) {
      setActiveId(instances[0].id);
    }
  }, [instances, activeId]);

  useEffect(() => {
    const raw = searchParams.get("session");
    const sid = raw != null && raw !== "" ? Number(raw) : NaN;
    if (!Number.isInteger(sid) || sid <= 0 || instances.length === 0) {
      return;
    }
    let cancelled = false;
    api<{ sessions: Session[] }>("/api/sessions")
      .then((d) => {
        if (cancelled) {
          return;
        }
        const s = d.sessions.find((x) => x.id === sid);
        if (!s) {
          setErr("That chat is not in your account or was removed.");
          setSearchParams({}, { replace: true });
          return;
        }
        setSearchParams({}, { replace: true });
        if (activeIdRef.current === s.instanceId) {
          openSessionFromUrl.current = null;
          return api<{ sessions: Session[] }>("/api/sessions?instanceId=" + s.instanceId).then((d2) => {
            if (cancelled) {
              return;
            }
            setSessions(d2.sessions);
            if (d2.sessions.some((x) => x.id === sid)) {
              setActiveSession(sid);
            }
          });
        }
        openSessionFromUrl.current = sid;
        setActiveId(s.instanceId);
      })
      .catch(() => {
        if (!cancelled) {
          setErr("Could not open chat from link.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [searchParams, instances.length, setSearchParams]);

  useEffect(() => {
    if (!activeId) {
      setSessions([]);
      return;
    }
    api<{ sessions: Session[] }>("/api/sessions?instanceId=" + activeId)
      .then((d) => {
        setSessions(d.sessions);
        const pending = openSessionFromUrl.current;
        if (pending != null && d.sessions.some((s) => s.id === pending)) {
          openSessionFromUrl.current = null;
          setActiveSession(pending);
          return;
        }
        if (d.sessions.length) {
          setActiveSession((cur) => {
            if (cur && d.sessions.some((s) => s.id === cur)) {
              return cur;
            }
            return d.sessions[0].id;
          });
        } else {
          setActiveSession(null);
          setMessages([]);
        }
      })
      .catch(() => setErr("Could not load chats."));
  }, [activeId]);

  const loadMessages = useCallback((sid: number) => {
    return api<{
      messages: Msg[];
    }>("/api/sessions/" + sid + "/messages").then((d) => {
      setMessages(d.messages);
    });
  }, []);

  const loadUsage = useCallback((sessionId: number | null) => {
    const q = sessionId ? `?sessionId=${sessionId}` : "";
    return api<{ usage: UsageSnapshot }>("/api/usage" + q).then((d) => setUsage(d.usage));
  }, []);

  useEffect(() => {
    if (!activeSession) {
      setMessages([]);
      return;
    }
    setErr(null);
    loadMessages(activeSession).catch((e) => setErr((e as Error).message));
  }, [activeSession, loadMessages]);

  useEffect(() => {
    loadUsage(activeSession).catch(() => setUsage(null));
  }, [loadUsage, activeSession, sessions.length]);

  useEffect(() => {
    const el = messageListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    setUser(null);
    nav("/login");
  }

  async function addInstance(e: FormEvent) {
    e.preventDefault();
    setFormErr(null);
    if (!newModelId.trim() && !newKey.trim()) {
      setFormErr("Enter a model name and paste your API key.");
      return;
    }
    if (!newModelId.trim()) {
      setFormErr("Enter a model name (or pick one from the list).");
      return;
    }
    if (!newKey.trim()) {
      setFormErr("Paste the API key from your provider. It is required to save a setup.");
      return;
    }
    setAdding(true);
    try {
      const d = await api<{ instance: Instance }>("/api/instances", {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim(),
          modelId: newModelId.trim(),
          apiKey: newKey,
        }),
      });
      setInstances((prev) => [d.instance, ...prev]);
      setActiveId(d.instance.id);
      setNewKey("");
      setUpdateKey("");
      setShowAdd(false);
    } catch (e2) {
      setFormErr((e2 as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function updateInstanceKey(e: FormEvent) {
    e.preventDefault();
    if (!activeId || !updateKey.trim()) {
      return;
    }
    setKeyFormErr(null);
    setUpdateBusy(true);
    try {
      const d = await api<{ instance: Instance }>("/api/instances/" + activeId, {
        method: "PATCH",
        body: JSON.stringify({ apiKey: updateKey }),
      });
      setInstances((prev) => prev.map((i) => (i.id === d.instance.id ? d.instance : i)));
      setUpdateKey("");
    } catch (e2) {
      setKeyFormErr((e2 as Error).message);
    } finally {
      setUpdateBusy(false);
    }
  }

  async function newChat() {
    if (!activeId) {
      return;
    }
    setErr(null);
    try {
      const d = await api<{ session: Session }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ instanceId: activeId, title: "New chat" }),
      });
      setSessions((s) => [d.session, ...s]);
      setActiveSession(d.session.id);
      void loadUsage(d.session.id);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  async function renameSession(s: Session) {
    const t = window.prompt("Rename this chat", s.title);
    if (t == null) {
      return;
    }
    const title = t.trim();
    if (!title || title === s.title) {
      return;
    }
    setErr(null);
    try {
      const d = await api<{ session: Session }>("/api/sessions/" + s.id, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      setSessions((list) => list.map((x) => (x.id === d.session.id ? d.session : x)));
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  async function deleteSession(s: Session) {
    if (!window.confirm("Delete this chat and all messages in it? This cannot be undone.")) {
      return;
    }
    setErr(null);
    try {
      await api("/api/sessions/" + s.id, { method: "DELETE" });
      const remaining = sessions.filter((x) => x.id !== s.id);
      setSessions(remaining);
      const wasActive = activeSession === s.id;
      if (wasActive) {
        if (remaining.length) {
          setActiveSession(remaining[0].id);
        } else {
          setActiveSession(null);
          setMessages([]);
        }
      }
      const nextUsageSession = wasActive ? (remaining[0]?.id ?? null) : activeSession;
      void loadUsage(nextUsageSession);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  async function sendMessage(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || !activeSession) {
      return;
    }
    setSendBusy(true);
    setErr(null);
    const t = text.trim();
    setText("");
    setMessages((m) => [
      ...m,
      { id: PLACEHOLDER_USER_ID, role: "user", content: t },
      { id: PLACEHOLDER_ASSISTANT_ID, role: "assistant", content: "" },
    ]);
    try {
      await postMessageStream(activeSession, t, {
        onDelta: (piece) => {
          setMessages((m) =>
            m.map((x) =>
              x.id === PLACEHOLDER_ASSISTANT_ID ? { ...x, content: x.content + piece } : x
            )
          );
        },
        onDone: (msg) => {
          setMessages((m) =>
            m.map((x) =>
              x.id === PLACEHOLDER_ASSISTANT_ID
                ? { id: msg.id, role: msg.role, content: msg.content }
                : x
            )
          );
        },
      });
      await loadMessages(activeSession);
      if (activeId) {
        const list = await api<{ sessions: Session[] }>("/api/sessions?instanceId=" + activeId);
        setSessions(list.sessions);
      }
      void loadUsage(activeSession);
    } catch (e2) {
      setErr((e2 as Error).message);
      setMessages((m) => m.filter((x) => x.id !== PLACEHOLDER_USER_ID && x.id !== PLACEHOLDER_ASSISTANT_ID));
    } finally {
      setSendBusy(false);
    }
  }

  const active = instances.find((i) => i.id === activeId);
  const needsSetup = instances.length === 0;
  const showAddForm = needsSetup || showAdd;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          DevClaw
          <span className="badge" title="Replaces a technical control panel with one simple screen.">
            simple mode
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span className="muted" style={{ display: "none" }} />
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            {user?.name} · assistant <strong style={{ color: "var(--text)" }}>{user?.agent_name}</strong>
          </span>
          <Link to="/usage" className="btn btn-ghost" style={{ fontSize: "0.85rem" }}>
            Usage
          </Link>
          <Link to="/sessions" className="btn btn-ghost" style={{ fontSize: "0.85rem" }}>
            Sessions
          </Link>
          <Link to="/guest" className="btn btn-ghost" style={{ fontSize: "0.85rem" }}>
            Quick try
          </Link>
          <button type="button" className="btn btn-ghost" onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </header>

      <aside className="app-sidebar">
        <div className="side-scroll">
          <div className="section-pad" style={{ borderBottom: "1px solid var(--border)" }}>
            <p className="block-title" style={{ marginTop: 0 }}>
              1. Assistant setup
            </p>
            <p className="hint" style={{ margin: "0 0 0.5rem" }}>
              Each setup uses one model and one API key. You can have several (for work, home, and so on).
            </p>
            {instances.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "100%" }}
                onClick={() => setShowAdd((s) => !s)}
              >
                {showAdd ? "Hide form" : "+ Add a setup"}
              </button>
            )}
            {showAddForm && (
              <form className="panel-form" onSubmit={addInstance} style={{ marginTop: "0.65rem" }}>
                <h3 style={{ margin: "0 0 0.4rem" }}>New setup</h3>
                {formErr && <div className="error-banner" style={{ marginBottom: "0.5rem" }}>{formErr}</div>}
                <div className="form-field">
                  <label>Setup name</label>
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} required />
                  <p className="hint">A label only you will see, for example &quot;Work&quot; or &quot;Home&quot;.</p>
                </div>
                <ModelCombobox models={models} modelId={newModelId} onModelIdChange={setNewModelId} />
                <div className="form-field" style={{ marginTop: "0.65rem" }}>
                  <label>API key (paste from your provider)</label>
                  <input
                    type="password"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    autoComplete="off"
                    placeholder="sk-…, sk-ant-…, or Google AI (Gemini) key"
                  />
                  <p className="hint">
                    We encrypt it on this device’s server. OpenAI key for GPT, Anthropic for Claude, or a Google AI Studio
                    key for Gemini models (including <code>google/…</code> names).
                  </p>
                </div>
                <button className="btn btn-primary btn-block" type="submit" disabled={adding}>
                  {adding ? "Saving…" : "Save this setup"}
                </button>
              </form>
            )}
          </div>
          <div className="section-pad" style={{ borderBottom: "none" }}>
            <p className="block-title" style={{ marginTop: 0 }}>
              Your setups
            </p>
            {needsSetup && <p className="hint">Add a setup to start. No command line or config files required.</p>}
            {instances.map((i) => (
              <button
                type="button"
                key={i.id}
                className={"instance-card" + (i.id === activeId ? " active" : "")}
                onClick={() => setActiveId(i.id)}
              >
                <h3>{i.name}</h3>
                <p>
                  {i.modelId} · {i.hasApiKey ? "API key on file" : "add a key below"}
                </p>
              </button>
            ))}
            {activeId && !needsSetup && (
              <form className="panel-form" onSubmit={updateInstanceKey} style={{ marginTop: "0.5rem" }}>
                {keyFormErr && <div className="error-banner" style={{ marginBottom: "0.5rem" }}>{keyFormErr}</div>}
                <h3 style={{ margin: "0 0 0.4rem", fontSize: "0.9rem" }}>Replace API key (optional)</h3>
                <p className="hint" style={{ margin: "0 0 0.4rem" }}>
                  Paste a new key only if your provider sent you a replacement. The old one will be removed.
                </p>
                <div className="form-field" style={{ marginBottom: "0.5rem" }}>
                  <input
                    type="password"
                    value={updateKey}
                    onChange={(e) => setUpdateKey(e.target.value)}
                    placeholder="New key (leave empty to skip)"
                    autoComplete="off"
                  />
                </div>
                <button className="btn btn-ghost" type="submit" disabled={updateBusy || !updateKey.trim()} style={{ width: "100%" }}>
                  {updateBusy ? "Saving…" : "Update key for this setup"}
                </button>
              </form>
            )}

            {!needsSetup && (
              <div className="section-pad sidebar-chats" style={{ borderTop: "1px solid var(--border)" }}>
                <p className="block-title" style={{ marginTop: 0 }}>
                  2. Chats
                </p>
                {usage && (
                  <div className="usage-strip usage-sidebar" aria-label="Usage and limits">
                    <span>
                      Today (UTC): <strong>{usage.dailyAssistantReplies}</strong>
                      {usage.dailyAssistantRepliesLimit > 0
                        ? ` / ${usage.dailyAssistantRepliesLimit} (limit)`
                        : " replies"}
                    </span>
                    <span>
                      Chats: <strong>{usage.chatCount}</strong>
                      {usage.chatCountLimit > 0 ? ` / ${usage.chatCountLimit} (max)` : ""}
                    </span>
                    {activeSession && usage.sessionMessageCount != null && (
                      <span title="Total messages stored in this chat.">
                        This chat: {usage.sessionMessageCount}
                        {usage.sessionMessageLimit > 0 ? ` / ${usage.sessionMessageLimit} (max)` : " msg"}
                      </span>
                    )}
                  </div>
                )}
                <div className="session-bar session-bar--sidebar" role="tablist" aria-label="Conversations (sessions)">
                  {sessions.map((s) => (
                    <div key={s.id} className="session-pill-group session-pill-group--stack">
                      <button
                        type="button"
                        className={"session-pill" + (s.id === activeSession ? " on" : "")}
                        onClick={() => setActiveSession(s.id)}
                        title="Open this chat (session)"
                      >
                        <span>{s.title || "Chat"}</span>
                      </button>
                      <button
                        type="button"
                        className="session-pill-action"
                        title="Rename chat"
                        aria-label="Rename chat"
                        onClick={(e) => {
                          e.stopPropagation();
                          void renameSession(s);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="session-pill-action"
                        title="Delete chat"
                        aria-label="Delete chat"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteSession(s);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="session-add session-add--sidebar"
                    onClick={newChat}
                    disabled={!activeId}
                    title="Start a new chat with the current setup"
                  >
                    + New chat
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>

      <main className="app-main">
        {needsSetup ? (
          <div className="empty-chat" style={{ flex: 1 }}>
            <h2>Welcome to DevClaw</h2>
            <p style={{ maxWidth: 420 }}>
              In the left column, add your first <strong>assistant setup</strong>: give it a name, choose a model,
              and paste the API key from your provider. Then you can open a chat on the right.
            </p>
          </div>
        ) : (
          <>
            {err && (
              <div className="error-banner" style={{ margin: "0.5rem 1rem" }} role="alert">
                {err}
              </div>
            )}
            <div className="chat-area">
              {active && (
                <div className="chat-context" role="status">
                  <span className="chat-context-label">Setup</span>
                  <span className="chat-context-name">{active.name}</span>
                  <span className="chat-context-sep" aria-hidden>
                    ·
                  </span>
                  <span className="chat-context-label">Model</span>
                  <code className="chat-context-model">{active.modelId}</code>
                </div>
              )}
              {!activeSession && (
                <div className="empty-chat" style={{ flex: 1 }}>
                  <h2>Start a conversation</h2>
                  <p>
                    In the <strong>left sidebar</strong>, under &quot;2. Chats&quot;, use <strong>+ New chat</strong> to
                    start a <strong>session</strong> for the selected setup.
                  </p>
                </div>
              )}
              {activeSession && (
                <>
                  <div className="message-list" ref={messageListRef}>
                    {messages.map((m) => (
                      <div key={m.id} className={"msg " + (m.role === "user" ? "user" : "assistant")}>
                        <div className="role">{m.role === "user" ? "You" : user?.agent_name || "Assistant"}</div>
                        {m.content}
                      </div>
                    ))}
                  </div>
                  <div className="composer-surface">
                    <form className="composer" onSubmit={sendMessage} aria-label="Write a message">
                      <label className="visually-hidden" htmlFor="chat-composer-input">
                        Message
                      </label>
                      <textarea
                        id="chat-composer-input"
                        className="chat-composer-input"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder="Message…"
                        rows={4}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            const form = e.currentTarget.form;
                            if (form) {
                              form.requestSubmit();
                            }
                          }
                        }}
                        disabled={sendBusy}
                      />
                      <button
                        className="btn btn-primary btn-send"
                        type="submit"
                        disabled={sendBusy || !text.trim()}
                        title="Send message"
                      >
                        Send
                      </button>
                    </form>
                    <p className="composer-hint">
                      <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> new line
                    </p>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
