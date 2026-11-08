import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { config } from '../lib/config.js';
import { q1 } from '../db/pool.js';
import type { CheckExecutor } from './types.js';
import { compact, m, ConfigError } from './types.js';
import { globToRegExp } from '../core/rules.js';

export const systemdCheck: CheckExecutor = {
  type: 'systemd_unit', label: 'systemd-Dienst', category: 'Betrieb', defaultInterval: 60,
  description: 'Prüft agentenlos, ob eine systemd-Unit auf dem lokalen Host aktiv ist (über /run/systemd/units des Hosts).',
  fields: [{ key: 'unit', label: 'Unit', type: 'text', fromConnection: 'unit', required: true, placeholder: 'sshd.service' }],
  defaultThresholds: [],
  metrics: [{ name: 'active', unit: 'bool', label: 'Aktiv' }],
  async run(ctx) {
    const unit = ctx.check.config.unit || ctx.resource.connection.unit;
    if (!unit) throw new ConfigError('keine Unit konfiguriert');
    const dir = join(config.hostRoot, 'run/systemd/units');
    if (!existsSync(dir)) return { status: 'unknown', message: 'systemd-Status nicht verfügbar (/run des Hosts nicht sichtbar oder kein systemd)', unavailable: { systemd: '/run/systemd/units nicht gemountet' } };
    const active = existsSync(join(dir, `invocation:${unit}`));
    return { status: active ? 'ok' : 'critical', message: active ? `${unit} aktiv` : `${unit} nicht aktiv`, metrics: { active: { value: active ? 1 : 0, unit: 'bool' } } };
  },
};

export const fileAgeCheck: CheckExecutor = {
  type: 'file_age', label: 'Backup-/Datei-Aktualität', category: 'Betrieb', defaultInterval: 600,
  description: 'Alter und Größe der neuesten Datei in einem Verzeichnis des lokalen Hosts (read-only), z. B. Backup-Ziel. Nur nachweisbare Daten: fehlt der Pfad, ist der Wert „nicht verfügbar“.',
  fields: [
    { key: 'path', label: 'Verzeichnis auf dem Host', type: 'text', required: true, placeholder: '/srv/backups/nextcloud' },
    { key: 'pattern', label: 'Dateimuster', type: 'text', default: '*', placeholder: '*.tar.gz' },
    { key: 'min_size_bytes', label: 'Mindestgröße (Bytes, optional)', type: 'number' },
  ],
  defaultThresholds: [{ metric: 'age_hours', op: '>', warning: 26, critical: 50 }],
  metrics: [{ name: 'age_hours', unit: 'count', label: 'Alter (h)' }, { name: 'size_bytes', unit: 'bytes', label: 'Größe' }, { name: 'files', unit: 'count', label: 'Dateien' }],
  async run(ctx) {
    const rel = normalize(String(ctx.check.config.path ?? '')).replace(/^(\.\.(\/|$))+/, '');
    if (!rel || rel === '.') throw new ConfigError('kein Pfad konfiguriert');
    const dir = join(config.hostRoot, rel);
    if (!existsSync(dir)) return { status: 'unknown', message: `Pfad ${rel} auf dem Host nicht vorhanden oder nicht gemountet`, unavailable: { path: 'nicht lesbar' } };
    const re = globToRegExp(ctx.check.config.pattern || '*');
    let newest: { name: string; mtime: number; size: number } | null = null;
    let files = 0;
    for (const f of await readdir(dir)) {
      if (!re.test(f)) continue;
      const s = await stat(join(dir, f)).catch(() => null);
      if (!s?.isFile()) continue;
      files++;
      if (!newest || s.mtimeMs > newest.mtime) newest = { name: f, mtime: s.mtimeMs, size: s.size };
    }
    if (!newest) return { status: 'critical', message: `Keine Datei passend zu „${ctx.check.config.pattern || '*'}“ in ${rel}`, metrics: { files: { value: 0, unit: 'count' } } };
    const ageH = (Date.now() - newest.mtime) / 3600_000;
    const metrics = { age_hours: { value: Math.round(ageH * 100) / 100, unit: 'count' }, size_bytes: { value: newest.size, unit: 'bytes' }, files: { value: files, unit: 'count' } };
    const min = Number(ctx.check.config.min_size_bytes || 0);
    if (min && newest.size < min) return { status: 'critical', message: `Neueste Datei ${newest.name} ist nur ${newest.size} Bytes groß`, metrics };
    return { status: 'ok', message: `Neueste Datei ${newest.name}, ${ageH.toFixed(1)} h alt`, metrics };
  },
};

export const heartbeatCheck: CheckExecutor = {
  type: 'heartbeat', label: 'Job-Heartbeat (Push)', category: 'Betrieb', defaultInterval: 60,
  description: 'Ein Cron-/Backup-Job meldet sich per HTTP bei Hermes (curl …/api/push/<token>). Prüft das Alter des letzten erfolgreichen Laufs und gemeldete Fehler.',
  fields: [{ key: 'grace_s', label: 'Erwartet spätestens alle (Sekunden)', type: 'number', default: 90000, hint: 'z. B. 90000 für einen täglichen Job mit Puffer' }],
  defaultThresholds: [],
  metrics: [{ name: 'age_s', unit: 's', label: 'Alter letzte Meldung' }],
  async run(ctx) {
    const row = await q1(`SELECT push_last_at, push_last_status, push_last_message, created_at FROM checks WHERE id = $1`, [ctx.check.id]);
    const grace = Number(ctx.check.config.grace_s || 90000);
    if (!row?.push_last_at) {
      const waited = (Date.now() - new Date(row?.created_at ?? Date.now()).getTime()) / 1000;
      return waited > grace ? { status: 'critical', message: 'Noch nie gemeldet' } : { status: 'unknown', message: 'Wartet auf die erste Meldung des Jobs' };
    }
    const age = (Date.now() - new Date(row.push_last_at).getTime()) / 1000;
    const metrics = { age_s: { value: age, unit: 's' } };
    if (row.push_last_status === 'fail') return { status: 'critical', message: `Job meldet Fehler: ${row.push_last_message ?? ''}`.trim(), metrics };
    if (age > grace) return { status: 'critical', message: `Letzte Meldung vor ${Math.round(age / 3600)} h (erwartet alle ${Math.round(grace / 3600)} h)`, metrics };
    return { status: 'ok', message: `Letzte Meldung vor ${Math.round(age / 60)} min${row.push_last_message ? `: ${row.push_last_message}` : ''}`, metrics };
  },
};

export const secretExpiryCheck: CheckExecutor = {
  type: 'secret_expiry', label: 'Ablauf von Zugangsdaten', category: 'Betrieb', defaultInterval: 3600, usesSecret: 'required',
  description: 'Überwacht das hinterlegte Ablaufdatum einer gespeicherten Zugangsinformation (API-Token, Passwort-Rotation).',
  fields: [],
  defaultThresholds: [{ metric: 'days_remaining', op: '<', warning: 14, critical: 3 }],
  metrics: [{ name: 'days_remaining', unit: 'days', label: 'Tage bis Ablauf' }],
  async run(ctx) {
    const row = await q1(`SELECT s.name, s.expires_at FROM checks c JOIN secrets s ON s.id = c.secret_id WHERE c.id = $1`, [ctx.check.id]);
    if (!row) throw new ConfigError('keine Zugangsdaten gewählt');
    if (!row.expires_at) return { status: 'unknown', message: `Für „${row.name}“ ist kein Ablaufdatum hinterlegt`, unavailable: { expiry: 'kein Ablaufdatum' } };
    const days = (new Date(row.expires_at).getTime() - Date.now()) / 86400_000;
    return { status: days < 0 ? 'critical' : 'ok', message: `„${row.name}“ läuft ${days < 0 ? 'seit' : 'in'} ${Math.abs(days).toFixed(1)} Tagen ${days < 0 ? 'nicht mehr' : 'ab'}`, metrics: compact({ days_remaining: m(Math.round(days * 10) / 10, 'days') }) };
  },
};
