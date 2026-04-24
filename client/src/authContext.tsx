import { createContext, useContext } from "react";

export type User = {
  id: number;
  email: string;
  name: string;
  agent_name: string;
};

export const AuthContext = createContext<{
  user: User | null;
  setUser: (u: User | null) => void;
} | null>(null);

export function useAuth() {
  const v = useContext(AuthContext);
  if (!v) {
    throw new Error("useAuth: missing provider");
  }
  return v;
}
