import { useState, FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../authContext";
import type { User } from "../authContext";

export function Signup() {
  const { setUser } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agentName, setAgentName] = useState("DevClaw helper");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const d = await api<{ user: User }>("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({ name, email, password, agentName }),
      });
      setUser(d.user);
      nav("/");
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 430 }}>
        <div className="brand">
          <h1>DevClaw</h1>
          <p>One-time setup: your name and your assistant’s name</p>
        </div>
        {err && <div className="error-banner" role="alert">{err}</div>}
        <form onSubmit={onSubmit}>
          <div className="form-field">
            <label>Your name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
            <p className="hint">We use this in greetings so the AI knows who is asking.</p>
          </div>
          <div className="form-field">
            <label>Email</label>
            <input
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="form-field">
            <label>Password</label>
            <input
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
            <p className="hint">At least 8 characters.</p>
          </div>
          <div className="form-field">
            <label>Your assistant’s name</label>
            <input
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              required
            />
            <p className="hint">The AI will use this as its name (for example, “I’m {agentName || "…"}”).</p>
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? "Creating account…" : "Create account & continue"}
          </button>
        </form>
        <p className="auth-footer">
          Already have an account? <Link to="/login">Sign in</Link>
          <br />
          <Link to="/guest">Try with your own API key (no sign-in)</Link>
        </p>
      </div>
    </div>
  );
}
