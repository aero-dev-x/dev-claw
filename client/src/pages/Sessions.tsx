import { useCallback, useEffect, useState, FormEvent, ChangeEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";

type PrefVal = "inherit" | "on" | "off";
type Prefs = { thinking: PrefVal; fast: PrefVal; verbose: PrefVal; reasoning: PrefVal };

type BrowserRow = {
  key: string;
  kind: string;
  sessionId: number;
  title: string;
  instanceId: number;
  instanceName: string;
  modelId: string;
  updatedAt: string;
  tokensUsed: number;
  tokenCap: number;
  compaction: string;
  prefs: Prefs;
};

type Instance = { id: number; name: string; modelId: string };

const PREF_KEYS = ["thinking", "fast", "verbose", "reasoning"] as const;

function timeAgo(iso: string) {
  const t = new Date(iso + (iso.includes("Z") || iso.includes("+") ? "" : "Z")).getTime();
  if (Number.isNaN(t)) {
    return "—";
  }
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) {
    return s + "s ago";
  }
  if (s < 3600) {
    return Math.floor(s / 60) + "m ago";
  }
  if (s < 86400) {
    return Math.floor(s / 3600) + "h ago";
  }
  return Math.floor(s / 86400) + "d ago";
}

function fmtInt(n: number) {
  return n.toLocaleString("en-US");
}

export function Sessions() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [globalAll, setGlobalAll] = useState(true);
  const [instanceId, setInstanceId] = useState<number | "">("");
  const [perPage, setPerPage] = useState(10);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<BrowserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [displayTokenCap, setDisplayTokenCap] = useState(200_000);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setQDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(() => {
    if (!globalAll && instanceId === "") {
      setErr("When Global is off, choose a setup to filter by.");
      setRows([]);
      setTotal(0);
      setLoading(false);
      return Promise.resolve();
    }
    setErr(null);
    setLoading(true);
    const off = (page - 1) * perPage;
    const iid = !globalAll && instanceId !== "" ? Number(instanceId) : undefined;
    const finalQs = new URLSearchParams();
    if (qDebounced) {
      finalQs.set("q", qDebounced);
    }
    finalQs.set("limit", String(perPage));
    finalQs.set("offset", String(off));
    if (iid) {
      finalQs.set("instanceId", String(iid));
    }

    return api<{ rows: BrowserRow[]; total: number; displayTokenCap: number }>(
      "/api/sessions/browser?" + finalQs.toString()
    )
      .then((d) => {
        setRows(d.rows);
        setTotal(d.total);
        setDisplayTokenCap(d.displayTokenCap);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [qDebounced, page, perPage, globalAll, instanceId]);

  useEffect(() => {
    void api<{ instances: Instance[] }>("/api/instances")
      .then((d) => setInstances(d.instances))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setPage(1);
  }, [qDebounced, globalAll, instanceId, perPage]);

  useEffect(() => {
    void load();
  }, [load]);

  function onSearch(e: FormEvent) {
    e.preventDefault();
    void load();
  }

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = total === 0 ? 0 : (page - 1) * perPage + 1;
  const end = Math.min(total, page * perPage);

  async function updatePref(
    sessionId: number,
    key: (typeof PREF_KEYS)[number],
    value: PrefVal
  ) {
    setSaving(sessionId);
    setErr(null);
    try {
      await api("/api/sessions/" + sessionId + "/prefs", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      await load();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setSaving(null);
    }
  }

  function goChat(sessionId: number) {
    nav("/?session=" + sessionId);
  }

  return (
    <div className="app-shell-page">
      <header className="app-header" style={{ flexShrink: 0 }}>
        <div className="app-title" style={{ flex: 1 }}>
          Sessions
          <span className="badge" style={{ fontWeight: 500 }}>
            (all setups)
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <Link to="/" className="btn btn-ghost" style={{ textDecoration: "none" }}>
            ← Back to chat
          </Link>
          <Link to="/usage" className="btn btn-ghost" style={{ textDecoration: "none" }}>
            Usage
          </Link>
        </div>
      </header>

      <main className="usage-page">
        <p className="hint" style={{ marginTop: 0 }}>
          All conversations for your account. Token totals come from the usage log (not guest quick try). The ratio
          uses your logged tokens vs. a display cap — configure with{" "}
          <code className="inline-code">DEVCLAW_SESSION_TOKEN_CAP_DISPLAY</code> on the server.
        </p>

        <form
          onSubmit={onSearch}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.6rem",
            alignItems: "center",
            marginBottom: "0.75rem",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            padding: "0.65rem 0.75rem",
            background: "#fafafa",
          }}
        >
          <label className="muted" style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
            <input
              type="checkbox"
              checked={globalAll}
              onChange={(e) => {
                setGlobalAll(e.target.checked);
                if (e.target.checked) {
                  setInstanceId("");
                }
              }}
            />
            Global
          </label>
          {!globalAll && (
            <label className="muted">
              Setup{" "}
              <select
                value={instanceId}
                onChange={(e) => setInstanceId(e.target.value === "" ? "" : Number(e.target.value))}
                style={{ minWidth: 120 }}
              >
                <option value="">Choose…</option>
                {instances.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by title, setup, model…"
            className="chat-composer-input"
            style={{ flex: 1, minWidth: 180, minHeight: 36 }}
            aria-label="Filter sessions"
          />
          <button type="button" className="btn btn-primary" onClick={() => void load()} disabled={loading}>
            {loading ? "…" : "Refresh"}
          </button>
        </form>

        {err && <div className="error-banner">{err}</div>}

        <div className="usage-surface" style={{ padding: 0, overflow: "hidden" }}>
          <div className="sessions-table-scroll">
            <table className="usage-table sessions-data-table" style={{ fontSize: "0.8rem" }}>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Kind</th>
                  <th>Updated</th>
                  <th>Tokens</th>
                  <th>Compaction</th>
                  <th>Thinking</th>
                  <th>Fast</th>
                  <th>Verbose</th>
                  <th>Reasoning</th>
                  <th> </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading && (
                  <tr>
                    <td colSpan={10} className="muted" style={{ padding: "1rem" }}>
                      No sessions match.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.sessionId}>
                    <td>
                      <code
                        style={{ fontSize: "0.75rem", color: "var(--accent)" }}
                        title={r.modelId + " · " + r.key}
                      >
                        {r.modelId.length > 56 ? r.modelId.slice(0, 54) + "…" : r.modelId}
                      </code>
                    </td>
                    <td>
                      <span
                        className="badge"
                        style={{ fontSize: "0.7rem", background: "rgba(0, 140, 130, 0.12)" }}
                      >
                        {r.kind}
                      </span>
                    </td>
                    <td className="muted">{timeAgo(r.updatedAt)}</td>
                    <td>
                      {fmtInt(r.tokensUsed)} / {fmtInt(r.tokenCap)}
                    </td>
                    <td>
                      <div>{r.compaction}</div>
                      <button type="button" className="btn btn-ghost" style={{ fontSize: "0.7rem", padding: "0.1rem" }} disabled>
                        Show checkpoints
                      </button>
                    </td>
                    {PREF_KEYS.map((k) => (
                      <td key={k}>
                        <select
                          className="sessions-pref-select"
                          value={r.prefs[k]}
                          disabled={saving === r.sessionId}
                          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                            void updatePref(r.sessionId, k, e.target.value as PrefVal)
                          }
                        >
                          <option value="inherit">inherit</option>
                          <option value="on">on</option>
                          <option value="off">off</option>
                        </select>
                      </td>
                    ))}
                    <td>
                      <button type="button" className="btn btn-primary" style={{ fontSize: "0.75rem" }} onClick={() => goChat(r.sessionId)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.5rem",
            marginTop: "0.6rem",
          }}
        >
          <span className="hint">
            {total === 0 ? "0" : start + "–" + end} of {total} row{total === 1 ? "" : "s"} · cap {fmtInt(displayTokenCap)}{" "}
            tok (display)
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span className="muted">per page</span>
            <select
              value={perPage}
              onChange={(e) => {
                setPerPage(Number(e.target.value));
                setPage(1);
              }}
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} per page
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
