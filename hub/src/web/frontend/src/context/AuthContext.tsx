import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

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
    fetch('/api/health')
      .then(r => r.json())
      .then((data: { authEnabled?: boolean; mode?: string }) => {
        setAuthEnabled(!!data.authEnabled);
        setIsHubMode(data.mode === 'hub');
      })
      .catch(() => {});
  }, []);

  const login = useCallback(async (password: string) => {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json() as { token?: string; error?: string };
    if (!res.ok || !data.token) throw new Error(data.error || 'Login failed');
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
