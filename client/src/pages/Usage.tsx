import { useEffect, useState, useCallback, FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

type DayRow = {
  day: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estCostUsd: number;
};

type ModelRow = { modelId: string; totalTokens: number; estCostUsd: number; completions: number };
type ProvRow = { provider: string; totalTokens: number; estCostUsd: number };
type RecentRow = {
  id: number;
  sessionId: number;
  sessionTitle: string;
  modelId: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estCostUsd: number;
  createdAt: string;
};

type Dashboard = {
  range: { days: number };
  messages: { user: number; assistant: number };
  fromEvents: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estCostUsd: number;
    completionEvents: number;
  };
  byDay: DayRow[];
  topModels: ModelRow[];
  topProviders: ProvRow[];
  recentSessions: RecentRow[];
  accountSessions: number;
};

function fmtK(n: number) {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(2) + "M";
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1) + "K";
  }
  return String(Math.round(n));
}

function fmtUsd(n: number) {
  if (!n) {
    return "$0.00";
  }
  if (n < 0.01) {
    return "< $0.01";
  }
  return "$" + n.toFixed(2);
}

export function Usage() {
  const [days, setDays] = useState(7);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setErr(null);
    return api<{ dashboard: Dashboard }>("/api/usage/dashboard?days=" + days)
      .then((d) => setDash(d.dashboard))
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  function onRange(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    void load();
  }

  const maxBarTokens = dash?.byDay.length
    ? Math.max(1, ...dash.byDay.map((d) => d.totalTokens))
    : 1;

  const barMaxPx = 112;

  return (
    <div className="app-shell-page">
      <header className="app-header" style={{ flexShrink: 0 }}>
        <div className="app-title" style={{ flex: 1 }}>
          Usage
          <span className="badge" style={{ fontWeight: 500 }}>
            your account
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <Link to="/sessions" className="btn btn-ghost" style={{ textDecoration: "none" }}>
            Sessions
          </Link>
          <Link to="/" className="btn btn-ghost" style={{ textDecoration: "none" }}>
            ← Back to chat
          </Link>
        </div>
      </header>

      <main className="usage-page">
        <div className="usage-toolbar">
          <p className="hint" style={{ margin: 0, maxWidth: "42rem", flex: "1 1 12rem" }}>
            See where tokens go and estimated cost from chats in simple mode. Based on your providers’ API usage fields when
            available; streaming replies use a character-based estimate. Not shown for quick try (guest) chats.
          </p>
          <form onSubmit={onRange} style={{ display: "flex", alignItems: "center", gap: "0.65rem", flexWrap: "wrap" }}>
            <label className="muted" htmlFor="usage-range">
              Range
            </label>
            <select
              id="usage-range"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="btn btn-ghost"
              style={{ padding: "0.4rem 0.6rem" }}
            >
              <option value={7}>Last 7 days (UTC)</option>
              <option value={30}>Last 30 days (UTC)</option>
              <option value={90}>Last 90 days (UTC)</option>
            </select>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? "…" : "Refresh"}
            </button>
          </form>
        </div>

        {err && <div className="error-banner">{err}</div>}

        {dash && !loading && (
          <>
            <div className="usage-stat-grid">
              <div className="usage-surface" style={{ padding: "0.95rem 1rem" }}>
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  Messages (in range)
                </div>
                <strong style={{ fontSize: "1.2rem", display: "block", marginTop: "0.15rem" }}>
                  {dash.messages.user} user / {dash.messages.assistant} assistant
                </strong>
              </div>
              <div className="usage-surface" style={{ padding: "0.95rem 1rem" }}>
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  Completions logged
                </div>
                <strong style={{ fontSize: "1.2rem", display: "block", marginTop: "0.15rem" }}>
                  {dash.fromEvents.completionEvents}
                </strong>
              </div>
              <div className="usage-surface" style={{ padding: "0.95rem 1rem" }}>
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  Tokens (in range)
                </div>
                <strong style={{ fontSize: "1.2rem", display: "block", marginTop: "0.15rem" }}>
                  {fmtK(dash.fromEvents.totalTokens)}
                </strong>
                <div className="hint" style={{ margin: "0.3rem 0 0", fontSize: "0.75rem" }}>
                  in {fmtK(dash.fromEvents.inputTokens)} · out {fmtK(dash.fromEvents.outputTokens)}
                </div>
              </div>
              <div className="usage-surface" style={{ padding: "0.95rem 1rem" }}>
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  Est. cost (in range)
                </div>
                <strong style={{ fontSize: "1.2rem", display: "block", marginTop: "0.15rem" }}>
                  {fmtUsd(dash.fromEvents.estCostUsd)}
                </strong>
                <div className="hint" style={{ margin: "0.3rem 0 0", fontSize: "0.75rem" }}>
                  Approximate from default $/1M rates
                </div>
              </div>
              <div className="usage-surface" style={{ padding: "0.95rem 1rem" }}>
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  Chat sessions (account)
                </div>
                <strong style={{ fontSize: "1.2rem", display: "block", marginTop: "0.15rem" }}>{dash.accountSessions}</strong>
              </div>
            </div>

            <div className="usage-surface" style={{ padding: "1rem 1.1rem", marginBottom: "1.25rem" }}>
              <h2 className="block-title" style={{ margin: "0 0 0.75rem", fontSize: "0.75rem" }}>
                Tokens by day (UTC)
              </h2>
              {dash.byDay.length === 0 ? (
                <p className="hint" style={{ margin: 0 }}>
                  No per-day token totals in this range yet. They appear after signed-in chat completions are logged.
                </p>
              ) : (
                <>
                  <div className="usage-bar-chart" aria-label="Token volume by day">
                    {dash.byDay.map((d) => {
                      const h = Math.max(5, (d.totalTokens / maxBarTokens) * barMaxPx);
                      return (
                        <div
                          key={d.day}
                          title={d.day + ": " + fmtK(d.totalTokens) + " tok · " + fmtUsd(d.estCostUsd) + " est."}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "flex-end",
                            alignItems: "stretch",
                          }}
                        >
                          <div
                            style={{
                              height: h,
                              minHeight: 5,
                              background: "linear-gradient(180deg, var(--accent) 0%, #c2410c 100%)",
                              borderRadius: "5px 5px 0 0",
                            }}
                          />
                          <div
                            className="muted"
                            style={{
                              fontSize: "0.65rem",
                              textAlign: "center",
                              marginTop: "0.35rem",
                              lineHeight: 1.2,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {d.day.slice(5)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="hint" style={{ margin: "0.6rem 0 0" }}>
                    Bar height is total tokens that day. Hover a bar for date and cost estimate.
                  </p>
                </>
              )}
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(17rem, 1fr))",
                gap: "1rem",
                marginBottom: "1.25rem",
              }}
            >
              <div className="usage-surface" style={{ padding: "1rem 1.1rem" }}>
                <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem" }}>Top models</h2>
                {dash.topModels.length === 0 ? (
                  <p className="hint">No logged completions in this range yet.</p>
                ) : (
                  <table className="usage-table" style={{ width: "100%", fontSize: "0.9rem" }}>
                    <tbody>
                      {dash.topModels.map((m) => (
                        <tr key={m.modelId}>
                          <td>
                            <code style={{ fontSize: "0.8rem" }}>{m.modelId}</code>
                          </td>
                          <td style={{ textAlign: "right" }}>{fmtK(m.totalTokens)}</td>
                          <td style={{ textAlign: "right" }} className="muted">
                            {fmtUsd(m.estCostUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="usage-surface" style={{ padding: "1rem 1.1rem" }}>
                <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem" }}>Top providers</h2>
                {dash.topProviders.length === 0 ? (
                  <p className="hint">—</p>
                ) : (
                  <table className="usage-table" style={{ width: "100%", fontSize: "0.9rem" }}>
                    <tbody>
                      {dash.topProviders.map((p) => (
                        <tr key={p.provider}>
                          <td style={{ textTransform: "capitalize" }}>{p.provider}</td>
                          <td style={{ textAlign: "right" }}>{fmtK(p.totalTokens)}</td>
                          <td style={{ textAlign: "right" }} className="muted">
                            {fmtUsd(p.estCostUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="usage-surface" style={{ padding: "1rem 1.1rem" }}>
              <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem" }}>Recent completion logs</h2>
              {dash.recentSessions.length === 0 ? (
                <p className="hint">Send a message from the chat to see rows here (signed-in only).</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="usage-table" style={{ width: "100%", fontSize: "0.85rem" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>When (UTC)</th>
                        <th style={{ textAlign: "left" }}>Session</th>
                        <th style={{ textAlign: "left" }}>Model</th>
                        <th style={{ textAlign: "left" }}>Provider</th>
                        <th style={{ textAlign: "right" }}>In / out</th>
                        <th style={{ textAlign: "right" }}>Est. $</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dash.recentSessions.map((r) => (
                        <tr key={r.id}>
                          <td className="muted">{r.createdAt.replace("T", " ").slice(0, 19)}</td>
                          <td>{r.sessionTitle || "Chat"}</td>
                          <td>
                            <code style={{ fontSize: "0.75rem" }}>{r.modelId}</code>
                          </td>
                          <td style={{ textTransform: "capitalize" }}>{r.provider}</td>
                          <td style={{ textAlign: "right" }}>
                            {fmtK(r.inputTokens)} / {fmtK(r.outputTokens)}
                          </td>
                          <td style={{ textAlign: "right" }} className="muted">
                            {fmtUsd(r.estCostUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {loading && <p className="muted">Loading…</p>}
      </main>
    </div>
  );
}
