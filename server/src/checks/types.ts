import type { State } from '../core/types.js';
import type { Threshold } from '../core/state.js';

export interface MetricValue { value: number; unit?: string; label?: string }

export interface CheckOutcome {
  status: State;              // executor's own verdict (connection failed → critical, …)
  message: string;
  metrics?: Record<string, MetricValue>;
  /** data the executor wants back on the next run (counters for rates) */
  carry?: Record<string, unknown>;
  /** capabilities that could not be measured, with the reason (shown as "nicht verfügbar") */
  unavailable?: Record<string, string>;
}

export interface CheckContext {
  check: { id: string; type: string; name: string; config: Record<string, any>; timeout_ms: number; interval_s: number; last_run: Date | null; last_metrics: Record<string, any> };
  resource: { id: string; name: string; kind: string; connection: Record<string, any>; discovered: Record<string, any> };
  /** decrypted credential of the check, if one is attached */
  secret: { kind: string; value: string } | null;
  signal: AbortSignal;
}

export interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'textarea' | 'list';
  required?: boolean;
  placeholder?: string;
  hint?: string;
  options?: string[];
  default?: unknown;
  /** filled from resource.connection[key] when empty */
  fromConnection?: string;
}

/**
 * A check type. New check types (SNMP, WinRM, MQTT, …) are added by implementing this
 * interface and listing it in ./registry.ts; scheduler, state engine and UI are generic.
 */
export interface CheckExecutor {
  type: string;
  label: string;
  description: string;
  category: 'Erreichbarkeit' | 'Anwendung' | 'Ressourcen' | 'Container' | 'Datenbank' | 'Betrieb' | 'Plattform';
  fields: FieldSpec[];
  usesSecret?: 'optional' | 'required';
  defaultInterval: number;
  defaultThresholds: Threshold[];
  /** metric catalogue for the threshold editor */
  metrics: Array<{ name: string; unit: string; label: string }>;
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

export function m(value: number | null | undefined, unit: string, label?: string): MetricValue | undefined {
  if (value === null || value === undefined || Number.isNaN(value)) return undefined;
  return { value, unit, label };
}

export function compact(o: Record<string, MetricValue | undefined>): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = {};
  for (const [k, v] of Object.entries(o)) if (v) out[k] = v;
  return out;
}

export function target(ctx: CheckContext, key = 'host'): string {
  const v = ctx.check.config[key] || ctx.resource.connection[key];
  if (!v) throw new ConfigError(`kein ${key === 'host' ? 'Host/Adresse' : key} konfiguriert (Check oder Ressource → Verbindung)`);
  return String(v);
}

export class ConfigError extends Error {}
