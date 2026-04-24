import { Routes, Route, Navigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { api } from "./lib/api";
import { Login } from "./pages/Login";
import { Signup } from "./pages/Signup";
import { Home } from "./pages/Home";
import { Usage } from "./pages/Usage";
import { Sessions } from "./pages/Sessions";
import { GuestChat } from "./pages/GuestChat";
import { AuthContext, type User } from "./authContext";

function useSession() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ user: User }>("/api/auth/me")
      .then((d) => setUser(d.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  return { user, loading, setUser };
}

export default function App() {
  const { user, loading, setUser } = useSession();

  if (loading) {
    return (
      <div className="app-loading">
        <div className="claw-loader" aria-hidden>
          <span className="claw-dot" />
        </div>
        <p>Loading DevClaw…</p>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ user: user ?? null, setUser }}>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
        <Route path="/signup" element={user ? <Navigate to="/" replace /> : <Signup />} />
        <Route path="/guest" element={<GuestChat />} />
        <Route
          path="/usage"
          element={user ? <Usage /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/sessions"
          element={user ? <Sessions /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/*"
          element={user ? <Home /> : <Navigate to="/login" replace />}
        />
      </Routes>
    </AuthContext.Provider>
  );
}
