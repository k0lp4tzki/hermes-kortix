import { FormEvent, useState } from 'react';
import { useAuth } from '../lib/auth';
import { Logo } from '../components/ui';

export default function Login() {
  const { login } = useAuth();
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await login(username, password); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <div className="brand"><Logo /><div>Hermes<small>homelab command center</small></div></div>
        <label className="field">Benutzername<input autoFocus autoComplete="username" value={username} onChange={(e) => setU(e.target.value)} /></label>
        <label className="field">Passwort<input type="password" autoComplete="current-password" value={password} onChange={(e) => setP(e.target.value)} /></label>
        {error && <div className="err" role="alert">{error}</div>}
        <button className="primary" disabled={busy || !username || !password} type="submit">{busy ? 'Anmelden…' : 'Anmelden'}</button>
      </form>
    </div>
  );
}
