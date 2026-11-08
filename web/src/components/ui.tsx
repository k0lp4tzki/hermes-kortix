import { ReactNode, useEffect, useState, createContext, useContext, useCallback } from 'react';
import { STATUS_LABEL } from '../lib/format';

export function StatusBadge({ status, label }: { status?: string | null; label?: string }) {
  const s = status ?? 'unknown';
  return <span className={`badge ${s}`}><span className={`dot ${s}`} />{label ?? STATUS_LABEL[s] ?? s}</span>;
}

export function Badge({ kind, children }: { kind?: string; children: ReactNode }) {
  return <span className={`badge ${kind ?? ''}`}>{children}</span>;
}

export function Tags({ tags }: { tags?: string[] | null }) {
  if (!tags?.length) return null;
  return <>{tags.map((t) => <span key={t} className="tag">{t}</span>)}</>;
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="ghost sm" onClick={onClose} aria-label="Schließen"><Icon name="x" /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return <label className={`field ${className ?? ''}`}>{label}{children}{hint && <span className="hint">{hint}</span>}</label>;
}

export function Bar({ value, warn = 80, crit = 90 }: { value: number | null | undefined; warn?: number; crit?: number }) {
  if (value === null || value === undefined) return <span className="na">n/a</span>;
  const cls = value >= crit ? 'crit' : value >= warn ? 'warn' : 'ok';
  return <div className={`bar ${cls}`}><span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function NotAvailable({ reason }: { reason?: string }) {
  return <span className="na" title={reason}>nicht verfügbar{reason ? ` – ${reason}` : ''}</span>;
}

type Toast = { id: number; text: string; error?: boolean };
const ToastCtx = createContext<(text: string, error?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error?: boolean) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

const PATHS: Record<string, string> = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  radar: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0 -10 0M12 12l6-6',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  pulse: 'M22 12h-4l-3 9L9 3l-3 9H2',
  share: 'M18 5m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M6 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M18 19m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  bell: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  cpu: 'M4 4h16v16H4zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3',
  search: 'M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0M21 21l-4.35-4.35',
  x: 'M18 6 6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  check: 'M20 6 9 17l-5-5',
  trash: 'M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4h6v2',
  play: 'M5 3l14 9-14 9V3z',
  merge: 'M18 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M6 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M6 21V9a9 9 0 0 0 9 9',
  wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
};
export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

export function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" aria-hidden>
      <rect width="16" height="16" rx="3.5" fill="#0f1a24" stroke="#1f3142" />
      <path d="M2.5 10.5 L5.5 10.5 L7 5 L9 12 L10.5 8 L13.5 8" stroke="#34d399" strokeWidth="1.3" fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
