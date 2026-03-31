import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { FormField, Input, Button } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const doLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      await login(password);
      navigate('/settings');
    } catch {
      setError('Invalid password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-sm">
        <h2 className="mb-4 text-lg font-bold" style={{ color: 'var(--text)' }}>Admin Login</h2>
        <div className="space-y-4">
          <FormField label="Password">
            <Input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Admin password"
              onKeyDown={e => e.key === 'Enter' && doLogin()}
              autoFocus
            />
          </FormField>
          {error && <AlertBanner message={error} color="red" />}
          <Button onClick={doLogin} disabled={loading}>
            {loading ? 'Logging in...' : 'Login'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
