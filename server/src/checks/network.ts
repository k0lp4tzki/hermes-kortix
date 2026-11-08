import { Socket } from 'node:net';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { Agent, request } from 'undici';
import type { CheckExecutor, CheckContext } from './types.js';
import { compact, m, target, ConfigError } from './types.js';

function timed<T>(p: Promise<T>): Promise<{ v: T; ms: number }> {
  const t0 = performance.now();
  return p.then((v) => ({ v, ms: performance.now() - t0 }));
}

export function tcpConnect(host: string, port: number, timeoutMs: number, readBanner = false): Promise<{ ms: number; banner?: string }> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    const t0 = performance.now();
    let connectedMs = 0;
    const fail = (e: Error) => { s.destroy(); reject(e); };
    s.setTimeout(timeoutMs, () => fail(new Error(`Zeitüberschreitung nach ${timeoutMs} ms`)));
    s.once('error', fail);
    s.once('connect', () => {
      connectedMs = performance.now() - t0;
      if (!readBanner) { s.destroy(); resolve({ ms: connectedMs }); return; }
      let buf = '';
      s.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.includes('\n') || buf.length > 255) { s.destroy(); resolve({ ms: connectedMs, banner: buf.split(/\r?\n/)[0].slice(0, 255) }); }
      });
      s.once('end', () => resolve({ ms: connectedMs, banner: buf.trim() }));
    });
    s.connect(port, host);
  });
}

function port(ctx: CheckContext, fallback?: number): number {
  const p = Number(ctx.check.config.port || ctx.resource.connection.port || fallback);
  if (!p) throw new ConfigError('kein Port konfiguriert');
  return p;
}

export const pingCheck: CheckExecutor = {
  type: 'ping', label: 'ICMP Ping', category: 'Erreichbarkeit', defaultInterval: 30,
  description: 'Host-Erreichbarkeit per ICMP Echo (3 Pakete). Benötigt CAP_NET_RAW im Worker-Container.',
  fields: [{ key: 'host', label: 'Host/IP', type: 'text', fromConnection: 'host', placeholder: '192.168.1.1' }, { key: 'count', label: 'Pakete', type: 'number', default: 3 }],
  defaultThresholds: [{ metric: 'packet_loss_percent', op: '>=', warning: 34, critical: 100 }, { metric: 'rtt_avg_ms', op: '>', warning: 200, critical: 1000 }],
  metrics: [{ name: 'rtt_avg_ms', unit: 'ms', label: 'RTT Ø' }, { name: 'rtt_max_ms', unit: 'ms', label: 'RTT max' }, { name: 'packet_loss_percent', unit: 'percent', label: 'Paketverlust' }],
  async run(ctx) {
    const host = target(ctx);
    if (!/^[a-zA-Z0-9.:_-]+$/.test(host)) throw new ConfigError('ungültiger Hostname');
    const count = Math.min(Math.max(Number(ctx.check.config.count ?? 3), 1), 10);
    const wait = Math.max(1, Math.round(ctx.check.timeout_ms / 1000 / count));
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const p = spawn('ping', ['-n', '-c', String(count), '-i', '0.2', '-W', String(wait), host], { signal: ctx.signal });
      let text = '';
      p.stdout.on('data', (d) => (text += d));
      p.stderr.on('data', (d) => (text += d));
      p.on('error', (e) => resolve({ code: -1, text: e.message }));
      p.on('close', (code) => resolve({ code, text }));
    });
    if (out.code === -1 || /Operation not permitted|socket: Permission denied|ENOENT/.test(out.text)) {
      return { status: 'unknown', message: `ICMP nicht verfügbar: ${out.text.trim().split('\n')[0]}`, unavailable: { icmp: 'Ping ist im Worker nicht erlaubt (CAP_NET_RAW fehlt?)' } };
    }
    const loss = Number(out.text.match(/([\d.]+)% packet loss/)?.[1] ?? 100);
    const rtt = out.text.match(/= ([\d.]+)\/([\d.]+)\/([\d.]+)/);
    const metrics = compact({ packet_loss_percent: m(loss, 'percent', 'Paketverlust'), rtt_avg_ms: m(rtt ? Number(rtt[2]) : null, 'ms', 'RTT Ø'), rtt_max_ms: m(rtt ? Number(rtt[3]) : null, 'ms', 'RTT max') });
    if (loss >= 100) return { status: 'critical', message: `${host} antwortet nicht (100 % Paketverlust)`, metrics };
    return { status: 'ok', message: `${host}: ${rtt ? Number(rtt[2]).toFixed(1) + ' ms' : ''}, ${loss} % Verlust`, metrics };
  },
};

export const tcpCheck: CheckExecutor = {
  type: 'tcp', label: 'TCP-Port', category: 'Erreichbarkeit', defaultInterval: 60,
  description: 'Prüft, ob ein TCP-Port Verbindungen annimmt, und misst die Verbindungszeit.',
  fields: [{ key: 'host', label: 'Host/IP', type: 'text', fromConnection: 'host' }, { key: 'port', label: 'Port', type: 'number', fromConnection: 'port', required: true }],
  defaultThresholds: [{ metric: 'connect_ms', op: '>', warning: 500, critical: 3000 }],
  metrics: [{ name: 'connect_ms', unit: 'ms', label: 'Verbindungsaufbau' }],
  async run(ctx) {
    const host = target(ctx);
    const p = port(ctx);
    try {
      const r = await tcpConnect(host, p, ctx.check.timeout_ms);
      return { status: 'ok', message: `${host}:${p} erreichbar (${r.ms.toFixed(1)} ms)`, metrics: { connect_ms: { value: r.ms, unit: 'ms' } } };
    } catch (e) {
      return { status: 'critical', message: `${host}:${p} nicht erreichbar: ${(e as Error).message}` };
    }
  },
};

export const sshCheck: CheckExecutor = {
  type: 'ssh', label: 'SSH-Dienst', category: 'Erreichbarkeit', defaultInterval: 120,
  description: 'Liest nur das SSH-Banner (keine Anmeldung) und prüft die Protokollversion.',
  fields: [{ key: 'host', label: 'Host/IP', type: 'text', fromConnection: 'host' }, { key: 'port', label: 'Port', type: 'number', default: 22 }, { key: 'expect_banner', label: 'Banner enthält (optional)', type: 'text', placeholder: 'OpenSSH' }],
  defaultThresholds: [{ metric: 'connect_ms', op: '>', warning: 1000, critical: 5000 }],
  metrics: [{ name: 'connect_ms', unit: 'ms', label: 'Verbindungsaufbau' }],
  async run(ctx) {
    const host = target(ctx);
    const p = Number(ctx.check.config.port || 22);
    try {
      const r = await tcpConnect(host, p, ctx.check.timeout_ms, true);
      const metrics = { connect_ms: { value: r.ms, unit: 'ms' } };
      if (!r.banner?.startsWith('SSH-')) return { status: 'critical', message: `Kein SSH-Banner von ${host}:${p} (${r.banner?.slice(0, 60) || 'leer'})`, metrics };
      if (ctx.check.config.expect_banner && !r.banner.includes(ctx.check.config.expect_banner)) return { status: 'warning', message: `Banner „${r.banner}“ enthält nicht „${ctx.check.config.expect_banner}“`, metrics };
      return { status: 'ok', message: r.banner, metrics };
    } catch (e) {
      return { status: 'critical', message: `SSH ${host}:${p} nicht erreichbar: ${(e as Error).message}` };
    }
  },
};

export const dnsCheck: CheckExecutor = {
  type: 'dns', label: 'DNS-Auflösung', category: 'Erreichbarkeit', defaultInterval: 120,
  description: 'Löst einen Namen auf (optional über einen bestimmten DNS-Server) und prüft das Ergebnis.',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'nas.lab.local' },
    { key: 'record', label: 'Record-Typ', type: 'select', options: ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'], default: 'A' },
    { key: 'server', label: 'DNS-Server (optional)', type: 'text', fromConnection: 'host', placeholder: '192.168.1.1' },
    { key: 'expect', label: 'Antwort enthält (optional)', type: 'text', placeholder: '192.168.1.20' },
  ],
  defaultThresholds: [{ metric: 'resolve_ms', op: '>', warning: 300, critical: 2000 }],
  metrics: [{ name: 'resolve_ms', unit: 'ms', label: 'Auflösungszeit' }, { name: 'answers', unit: 'count', label: 'Antworten' }],
  async run(ctx) {
    const c = ctx.check.config;
    if (!c.name) throw new ConfigError('kein Name zum Auflösen konfiguriert');
    const r = new Resolver({ timeout: ctx.check.timeout_ms, tries: 1 });
    const server = c.server || (ctx.resource.kind === 'dns' ? ctx.resource.connection.host : null);
    if (server) r.setServers([String(server)]);
    const type = String(c.record || 'A').toUpperCase();
    try {
      const { v, ms } = await timed(r.resolve(String(c.name), type as any) as Promise<any[]>);
      const flat = v.map((x: any) => (typeof x === 'string' ? x : Array.isArray(x) ? x.join('') : x.exchange ?? x.value ?? JSON.stringify(x)));
      const metrics = { resolve_ms: { value: ms, unit: 'ms' }, answers: { value: flat.length, unit: 'count' } };
      if (c.expect && !flat.some((x: string) => x.includes(c.expect))) return { status: 'critical', message: `${c.name} ${type} → ${flat.join(', ')} (erwartet: ${c.expect})`, metrics };
      return { status: 'ok', message: `${c.name} ${type} → ${flat.slice(0, 5).join(', ')}${server ? ` via ${server}` : ''}`, metrics };
    } catch (e) {
      return { status: 'critical', message: `${c.name} ${type} nicht auflösbar${server ? ` via ${server}` : ''}: ${(e as any).code ?? (e as Error).message}` };
    }
  },
};

export const tlsCheck: CheckExecutor = {
  type: 'tls', label: 'TLS-Zertifikat', category: 'Erreichbarkeit', defaultInterval: 3600,
  description: 'TLS-Handshake, Zertifikatskette und verbleibende Gültigkeit.',
  fields: [
    { key: 'host', label: 'Host', type: 'text', fromConnection: 'host' }, { key: 'port', label: 'Port', type: 'number', default: 443 },
    { key: 'servername', label: 'SNI-Name (optional)', type: 'text' }, { key: 'allow_untrusted', label: 'Selbstsignierte Zertifikate akzeptieren', type: 'boolean', default: false },
  ],
  defaultThresholds: [{ metric: 'days_remaining', op: '<', warning: 21, critical: 7 }],
  metrics: [{ name: 'days_remaining', unit: 'days', label: 'Restlaufzeit' }, { name: 'handshake_ms', unit: 'ms', label: 'Handshake' }],
  async run(ctx) {
    const c = ctx.check.config;
    let host = c.host || ctx.resource.connection.host;
    let p = Number(c.port || 443);
    if (!host && ctx.resource.connection.url) { const u = new URL(ctx.resource.connection.url); host = u.hostname; p = Number(c.port || u.port || 443); }
    if (!host) throw new ConfigError('kein Host konfiguriert');
    const servername = c.servername || (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : host);
    return new Promise((resolve) => {
      const t0 = performance.now();
      const s = tls.connect({ host, port: p, servername, rejectUnauthorized: false, timeout: ctx.check.timeout_ms }, () => {
        const ms = performance.now() - t0;
        const cert = s.getPeerCertificate();
        s.end();
        if (!cert || !cert.valid_to) { resolve({ status: 'critical', message: 'Kein Zertifikat erhalten' }); return; }
        const days = (new Date(cert.valid_to).getTime() - Date.now()) / 86400_000;
        const metrics = { days_remaining: { value: Math.round(days * 10) / 10, unit: 'days' }, handshake_ms: { value: ms, unit: 'ms' } };
        const subject = (cert.subject as any)?.CN ?? '';
        const issuer = (cert.issuer as any)?.O ?? (cert.issuer as any)?.CN ?? '';
        const info = `${subject} (${issuer}), gültig bis ${new Date(cert.valid_to).toLocaleDateString('de-DE')}`;
        if (days < 0) resolve({ status: 'critical', message: `Zertifikat abgelaufen: ${info}`, metrics });
        else if (!s.authorized && !c.allow_untrusted) resolve({ status: 'critical', message: `Zertifikat nicht vertrauenswürdig (${s.authorizationError}): ${info}`, metrics });
        else resolve({ status: 'ok', message: info, metrics });
      });
      s.on('timeout', () => { s.destroy(); resolve({ status: 'critical', message: `TLS ${host}:${p}: Zeitüberschreitung` }); });
      s.on('error', (e) => resolve({ status: 'critical', message: `TLS ${host}:${p}: ${e.message}` }));
    });
  },
};

function getPath(obj: any, path: string): unknown {
  return path.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter((x) => x !== undefined && x !== '').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function statusAllowed(code: number, spec: string): boolean {
  return spec.split(',').map((s) => s.trim()).some((part) => {
    const [a, b] = part.split('-').map(Number);
    return b ? code >= a && code <= b : code === a;
  });
}

export const httpCheck: CheckExecutor = {
  type: 'http', label: 'HTTP(S)-Endpunkt', category: 'Anwendung', defaultInterval: 60, usesSecret: 'optional',
  description: 'Statuscode, Antwortzeit, erwarteter Inhalt und JSON-Felder. Zugangsdaten aus dem verschlüsselten Speicher (Basic/Bearer).',
  fields: [
    { key: 'url', label: 'URL', type: 'text', fromConnection: 'url', required: true, placeholder: 'https://grafana.lab.local/api/health' },
    { key: 'method', label: 'Methode', type: 'select', options: ['GET', 'HEAD', 'POST'], default: 'GET' },
    { key: 'expected_status', label: 'Erwartete Statuscodes', type: 'text', default: '200-399', hint: 'z. B. 200 oder 200-299,301' },
    { key: 'body_contains', label: 'Antwort enthält', type: 'text' },
    { key: 'body_regex', label: 'Antwort passt auf Regex', type: 'text' },
    { key: 'json_assertions', label: 'JSON-Prüfungen', type: 'textarea', hint: 'Eine pro Zeile: pfad == wert, z. B. status == "ok" oder database.connected == true', placeholder: 'status == "ok"' },
    { key: 'headers', label: 'Header', type: 'textarea', hint: 'Eine pro Zeile: Name: Wert' },
    { key: 'username', label: 'Benutzer (bei Passwort-Zugangsdaten)', type: 'text' },
    { key: 'tls_verify', label: 'TLS-Zertifikat prüfen', type: 'boolean', default: true },
    { key: 'follow_redirects', label: 'Weiterleitungen folgen', type: 'boolean', default: true },
    { key: 'error_patterns', label: 'Fehlermuster im Body (Regex)', type: 'text', hint: 'Treffer zählen als Fehler, z. B. "error|exception"' },
  ],
  defaultThresholds: [{ metric: 'response_ms', op: '>', warning: 1000, critical: 5000 }],
  metrics: [{ name: 'response_ms', unit: 'ms', label: 'Antwortzeit' }, { name: 'status_code', unit: 'count', label: 'Statuscode' }, { name: 'body_bytes', unit: 'bytes', label: 'Antwortgröße' }, { name: 'error_matches', unit: 'count', label: 'Fehlermuster-Treffer' }],
  async run(ctx) {
    const c = ctx.check.config;
    const url = c.url || ctx.resource.connection.url;
    if (!url) throw new ConfigError('keine URL konfiguriert');
    const headers: Record<string, string> = { 'user-agent': 'Hermes-Monitoring/1.0' };
    for (const line of String(c.headers ?? '').split('\n')) { const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
    if (ctx.secret) {
      if (ctx.secret.kind === 'basic_auth') headers.authorization = 'Basic ' + Buffer.from(ctx.secret.value).toString('base64');
      else if (ctx.secret.kind === 'password' && c.username) headers.authorization = 'Basic ' + Buffer.from(`${c.username}:${ctx.secret.value}`).toString('base64');
      else headers.authorization = `Bearer ${ctx.secret.value}`;
    }
    const dispatcher = new Agent({ connect: { rejectUnauthorized: c.tls_verify !== false, timeout: ctx.check.timeout_ms } });
    const t0 = performance.now();
    let res;
    try {
      res = await request(url, { method: (c.method || 'GET') as any, headers, dispatcher, signal: ctx.signal, maxRedirections: c.follow_redirects === false ? 0 : 5, headersTimeout: ctx.check.timeout_ms, bodyTimeout: ctx.check.timeout_ms });
    } catch (e) {
      dispatcher.close().catch(() => {});
      const err = e as any;
      return { status: 'critical', message: `${url}: ${err.cause?.code ?? err.code ?? ''} ${err.cause?.message ?? err.message}`.trim() };
    }
    const ttfb = performance.now() - t0;
    const text = c.method === 'HEAD' ? '' : (await res.body.text()).slice(0, 2_000_000);
    const ms = performance.now() - t0;
    dispatcher.close().catch(() => {});
    const problems: string[] = [];
    let status: 'ok' | 'critical' = 'ok';
    const expected = String(c.expected_status || '200-399');
    if (!statusAllowed(res.statusCode, expected)) { status = 'critical'; problems.push(`HTTP ${res.statusCode} (erwartet ${expected})`); }
    if (c.body_contains && !text.includes(c.body_contains)) { status = 'critical'; problems.push(`Antwort enthält „${c.body_contains}“ nicht`); }
    if (c.body_regex) {
      try { if (!new RegExp(c.body_regex).test(text)) { status = 'critical'; problems.push(`Antwort passt nicht auf /${c.body_regex}/`); } } catch { problems.push('ungültige Regex'); }
    }
    let errorMatches: number | undefined;
    if (c.error_patterns) {
      try { errorMatches = (text.match(new RegExp(c.error_patterns, 'gi')) ?? []).length; } catch { problems.push('ungültiges Fehlermuster'); }
    }
    if (c.json_assertions) {
      let json: any;
      try { json = JSON.parse(text); } catch { status = 'critical'; problems.push('Antwort ist kein JSON'); }
      if (json !== undefined) {
        for (const line of String(c.json_assertions).split('\n').map((l: string) => l.trim()).filter(Boolean)) {
          const mm = line.match(/^(.+?)\s*(==|!=|>=|<=|>|<|contains)\s*(.+)$/);
          if (!mm) { problems.push(`ungültige JSON-Prüfung: ${line}`); continue; }
          const actual = getPath(json, mm[1].trim());
          let expectedV: any = mm[3].trim();
          try { expectedV = JSON.parse(expectedV); } catch { /* keep string */ }
          const ok = mm[2] === '==' ? actual === expectedV : mm[2] === '!=' ? actual !== expectedV : mm[2] === 'contains' ? String(actual).includes(String(expectedV))
            : mm[2] === '>' ? Number(actual) > Number(expectedV) : mm[2] === '<' ? Number(actual) < Number(expectedV) : mm[2] === '>=' ? Number(actual) >= Number(expectedV) : Number(actual) <= Number(expectedV);
          if (!ok) { status = 'critical'; problems.push(`${mm[1].trim()} = ${JSON.stringify(actual)} (erwartet ${mm[2]} ${mm[3].trim()})`); }
        }
      }
    }
    const metrics = compact({ response_ms: m(ms, 'ms'), ttfb_ms: m(ttfb, 'ms', 'Time to first byte'), status_code: m(res.statusCode, 'count'), body_bytes: m(Buffer.byteLength(text), 'bytes'), error_matches: m(errorMatches, 'count') });
    return { status, message: problems.length ? `${url}: ${problems.join('; ')}` : `HTTP ${res.statusCode} in ${ms.toFixed(0)} ms`, metrics };
  },
};
