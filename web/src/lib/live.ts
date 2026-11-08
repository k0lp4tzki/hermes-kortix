import { QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

// topic published by the server → query keys that become stale
const TOPIC_KEYS: Record<string, string[]> = {
  state: ['resources', 'resource', 'checks', 'overview', 'graph', 'metrics', 'incidents', 'platform'],
  events: ['events', 'overview', 'resource'],
  incidents: ['incidents', 'incident', 'overview', 'graph', 'resource', 'notifications'],
  discovery: ['discovery', 'resources', 'graph', 'overview'],
  inventory: ['resources', 'resource', 'graph', 'overview', 'dependencies', 'checks'],
  notifications: ['notifications'],
  platform: ['platform'],
};

let connected = false;
const listeners = new Set<(c: boolean) => void>();

export function startLive(qc: QueryClient) {
  let es: EventSource | null = null;
  const pending = new Set<string>();
  let timer: number | undefined;
  const flush = () => {
    timer = undefined;
    for (const k of pending) qc.invalidateQueries({ queryKey: [k] });
    pending.clear();
  };
  const open = () => {
    es = new EventSource('/api/live');
    es.addEventListener('hello', () => setConnected(true));
    es.addEventListener('update', (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data);
        for (const k of TOPIC_KEYS[msg.topic] ?? []) pending.add(k);
        if (!timer) timer = window.setTimeout(flush, 800);
      } catch { /* ignore */ }
    });
    es.onerror = () => {
      setConnected(false);
      es?.close();
      setTimeout(open, 4000);
    };
  };
  open();
  return () => es?.close();
}

function setConnected(c: boolean) {
  connected = c;
  for (const l of listeners) l(c);
}

export function useLiveConnected() {
  const [c, setC] = useState(connected);
  useEffect(() => {
    listeners.add(setC);
    return () => { listeners.delete(setC); };
  }, []);
  return c;
}
