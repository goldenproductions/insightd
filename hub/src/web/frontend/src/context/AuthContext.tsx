import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { api, apiAuth } from '@/lib/api';
import type { HealthData } from '@/types/api';

interface AuthState {
  token: string | null;
  isAuthenticated: boolean;
  authEnabled: boolean;
  isHubMode: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem('insightd-token'));
  const [authEnabled, setAuthEnabled] = useState(false);
  const [isHubMode, setIsHubMode] = useState(false);

  useEffect(() => {
    api<HealthData>('/health')
      .then(data => {
        setAuthEnabled(!!data.authEnabled);
        setIsHubMode(data.mode === 'hub');
      })
      .catch(() => {});
  }, []);

  const login = useCallback(async (password: string) => {
    const data = await apiAuth<{ token: string }>('POST', '/auth', { password });
    if (!data.token) throw new Error('Login failed');
    setToken(data.token);
    sessionStorage.setItem('insightd-token', data.token);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    sessionStorage.removeItem('insightd-token');
  }, []);

  return (
    <AuthContext.Provider value={{ token, isAuthenticated: !!token, authEnabled, isHubMode, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
