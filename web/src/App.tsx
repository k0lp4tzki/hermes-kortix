import { useEffect } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './lib/auth';
import { startLive, useLiveConnected } from './lib/live';
import { get } from './lib/api';
import { Icon, Logo } from './components/ui';
import Login from './pages/Login';
import { NAV, ROUTES } from './routes';

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Login />;
  return <Shell />;
}

function Shell() {
  const qc = useQueryClient();
  const { user, logout } = useAuth();
  const live = useLiveConnected();
  const loc = useLocation();
  useEffect(() => startLive(qc), [qc]);
  const counts = useQuery({ queryKey: ['overview', 'nav'], queryFn: () => get('/nav-counts').catch(() => ({})), refetchInterval: 30000 });
  const c: Record<string, number> = counts.data ?? {};
  return (
    <div className="shell">
      <nav className="side" aria-label="Hauptnavigation">
        <div className="brand"><Logo /><div>Hermes<small>homelab command center</small></div></div>
        {NAV.map((n, i) =>
          n === '-' ? <div key={i} className="nav-sep" /> : (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} end={n.to === '/'}>
              <Icon name={n.icon} />{n.label}
              {n.count && c[n.count] ? <span className={`count ${n.count === 'incidents' ? 'alert' : ''}`}>{c[n.count]}</span> : null}
            </NavLink>
          ),
        )}
        <div className="side-foot">
          <span className="row" title="Live-Verbindung (Server-Sent Events)"><span className={`dot ${live ? 'ok' : 'critical'}`} />{live ? 'Live verbunden' : 'Live getrennt'}</span>
          <span className="row">{user?.username} <span className="badge">{user?.role}</span>
            <button className="ghost sm" style={{ marginLeft: 'auto' }} onClick={logout} title="Abmelden" aria-label="Abmelden"><Icon name="logout" /></button>
          </span>
        </div>
      </nav>
      <main className="main" style={loc.pathname === "/" ? { overflow: "hidden" } : undefined}>
        <Routes>
          {ROUTES.map((r) => <Route key={r.path} path={r.path} element={r.element} />)}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
