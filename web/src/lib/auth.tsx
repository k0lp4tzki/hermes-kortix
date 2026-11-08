import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { get, post, setUnauthorizedHandler } from './api';

export interface User { id: string; username: string; display_name: string | null; role: 'admin' | 'operator' | 'viewer' }
interface AuthState { user: User | null; loading: boolean; login: (u: string, p: string) => Promise<void>; logout: () => Promise<void>; can: (role: User['role']) => boolean }

const Ctx = createContext<AuthState>(null as any);
const RANK = { viewer: 1, operator: 2, admin: 3 };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    get<{ user: User }>('/auth/me').then((r) => setUser(r.user ?? null)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);
  const login = async (username: string, password: string) => {
    const r = await post<{ user: User }>('/auth/login', { username, password });
    setUser(r.user);
  };
  const logout = async () => {
    await post('/auth/logout').catch(() => {});
    setUser(null);
  };
  const can = (role: User['role']) => !!user && RANK[user.role] >= RANK[role];
  return <Ctx.Provider value={{ user, loading, login, logout, can }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx);
