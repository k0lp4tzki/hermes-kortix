import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../lib/api';
import { Field, Modal, useToast } from './ui';

export function useCheckTypes() {
  return useQuery({ queryKey: ['check-types'], queryFn: () => get<{ types: any[]; planned: any[] }>('/check-types'), staleTime: Infinity });
}

/** Create/edit a check: type-specific fields, credential, thresholds and state-engine settings. */
export function CheckEditor({ resource, check, onClose }: { resource: any; check?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const types = useCheckTypes();
  const secrets = useQuery({ queryKey: ['secrets'], queryFn: () => get<any[]>('/secrets').catch(() => []) });
  const [type, setType] = useState<string>(check?.type ?? '');
  const meta = types.data?.types.find((t) => t.type === type);
  const [d, setD] = useState<any>(() => check ? { ...check } : null);
  const init = (t: string) => {
    const m = types.data!.types.find((x) => x.type === t);
    const cfg: any = {};
    for (const f of m.fields) if (f.default !== undefined) cfg[f.key] = f.default;
    setType(t);
    setD({ name: m.label, config: cfg, interval_s: m.defaultInterval, timeout_ms: 10000, enabled: true, thresholds: m.defaultThresholds, fail_after: 2, recover_after: 2, hold_s: 0, secret_id: null });
  };
  const save = useMutation({
    mutationFn: () => {
      const b = { name: d.name, config: d.config, secret_id: d.secret_id || null, interval_s: Number(d.interval_s), timeout_ms: Number(d.timeout_ms), enabled: d.enabled,
        thresholds: d.thresholds.filter((t: any) => t.metric).map((t: any) => ({ metric: t.metric, op: t.op, warning: t.warning === '' || t.warning === null || t.warning === undefined ? null : Number(t.warning), critical: t.critical === '' || t.critical === null || t.critical === undefined ? null : Number(t.critical) })),
        fail_after: Number(d.fail_after), recover_after: Number(d.recover_after), hold_s: Number(d.hold_s) };
      return check ? put(`/checks/${check.id}`, b) : post('/checks', { ...b, resource_id: resource.id, type });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['checks'] }); qc.invalidateQueries({ queryKey: ['resource'] }); toast('Check gespeichert'); onClose(); },
    onError: (e: Error) => toast(e.message, true),
  });
  const grouped = useMemo(() => {
    const g: Record<string, any[]> = {};
    for (const t of types.data?.types ?? []) (g[t.category] ??= []).push(t);
    return g;
  }, [types.data]);

  if (!type || !d) {
    return (
      <Modal title={`Check hinzufügen: ${resource.label ?? resource.name}`} wide onClose={onClose}>
        {Object.entries(grouped).map(([cat, list]) => (
          <div key={cat}>
            <h3>{cat}</h3>
            <div className="grid3">{list.map((t) => (
              <button key={t.type} className="panel" style={{ height: 'auto', textAlign: 'left', display: 'block', padding: '10px 12px', cursor: 'pointer' }} onClick={() => init(t.type)}>
                <div style={{ fontWeight: 600 }}>{t.label}</div><div className="sub" style={{ whiteSpace: 'normal' }}>{t.description}</div>
              </button>))}</div>
          </div>
        ))}
        {types.data?.planned?.length ? <div className="sub">Nicht verfügbar in v1: {types.data.planned.map((p) => `${p.label} (${p.reason})`).join(' · ')}</div> : null}
      </Modal>
    );
  }
  const setCfg = (k: string, v: any) => setD({ ...d, config: { ...d.config, [k]: v } });
  const setThr = (i: number, k: string, v: any) => setD({ ...d, thresholds: d.thresholds.map((t: any, j: number) => (j === i ? { ...t, [k]: v } : t)) });
  return (
    <Modal title={`${check ? 'Check bearbeiten' : 'Neuer Check'}: ${meta?.label}`} wide onClose={onClose}
      footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!d.name || save.isPending} onClick={() => save.mutate()}>Speichern</button></>}>
      <div className="sub">{meta?.description}</div>
      <div className="form-grid">
        <Field label="Name"><input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <div className="row" style={{ gap: 12 }}>
          <Field label="Intervall (s)"><input type="number" min={5} value={d.interval_s} onChange={(e) => setD({ ...d, interval_s: e.target.value })} style={{ width: 110 }} /></Field>
          <Field label="Timeout (ms)"><input type="number" value={d.timeout_ms} onChange={(e) => setD({ ...d, timeout_ms: e.target.value })} style={{ width: 110 }} /></Field>
          <label className="check" style={{ marginTop: 18 }}><input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />aktiv</label>
        </div>
        {meta?.fields.map((f: any) => {
          const v = d.config[f.key];
          const ph = f.placeholder ?? (f.fromConnection && resource.connection?.[f.fromConnection] ? `Ressource: ${resource.connection[f.fromConnection]}` : undefined);
          if (f.type === 'boolean') return <label key={f.key} className="check"><input type="checkbox" checked={!!v} onChange={(e) => setCfg(f.key, e.target.checked)} />{f.label}</label>;
          if (f.type === 'select') return <Field key={f.key} label={f.label}><select value={v ?? ''} onChange={(e) => setCfg(f.key, e.target.value)}>{f.options.map((o: string) => <option key={o}>{o}</option>)}</select></Field>;
          if (f.type === 'textarea') return <Field key={f.key} className="span2" label={f.label} hint={f.hint}><textarea rows={3} value={v ?? ''} placeholder={ph} onChange={(e) => setCfg(f.key, e.target.value)} /></Field>;
          return <Field key={f.key} label={f.label + (f.required && !(f.fromConnection && resource.connection?.[f.fromConnection]) ? ' *' : '')} hint={f.hint}>
            <input type={f.type === 'number' ? 'number' : 'text'} value={v ?? ''} placeholder={ph} onChange={(e) => setCfg(f.key, f.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)} /></Field>;
        })}
        {meta?.usesSecret && <Field label={`Zugangsdaten${meta.usesSecret === 'required' ? ' *' : ' (optional)'}`} hint="Verschlüsselt gespeichert, unter Einstellungen → Zugangsdaten">
          <select value={d.secret_id ?? ''} onChange={(e) => setD({ ...d, secret_id: e.target.value || null })}><option value="">keine</option>{(secrets.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.kind})</option>)}</select></Field>}
      </div>
      {check?.type === 'heartbeat' && check.push_token && <div className="callout">Push-URL für den Job: <code>{location.origin}/api/push/{check.push_token}</code><br />Erfolg: <code>curl -fsS {location.origin}/api/push/{check.push_token}</code> · Fehler: <code>…?status=fail&amp;msg=…</code></div>}
      <h3 style={{ marginTop: 6 }}>Schwellwerte</h3>
      <div className="stack" style={{ gap: 6 }}>
        {d.thresholds.map((t: any, i: number) => (
          <div key={i} className="row">
            <input list={`metrics-${type}`} value={t.metric} onChange={(e) => setThr(i, 'metric', e.target.value)} style={{ flex: 1 }} placeholder="Metrik" aria-label="Metrik" />
            <select value={t.op} onChange={(e) => setThr(i, 'op', e.target.value)} style={{ width: 64 }} aria-label="Operator">{['>', '>=', '<', '<=', '==', '!='].map((o) => <option key={o}>{o}</option>)}</select>
            <input type="number" value={t.warning ?? ''} onChange={(e) => setThr(i, 'warning', e.target.value)} placeholder="Warning" style={{ width: 110 }} aria-label="Warning" />
            <input type="number" value={t.critical ?? ''} onChange={(e) => setThr(i, 'critical', e.target.value)} placeholder="Critical" style={{ width: 110 }} aria-label="Critical" />
            <button className="ghost sm" onClick={() => setD({ ...d, thresholds: d.thresholds.filter((_: any, j: number) => j !== i) })}>Entfernen</button>
          </div>
        ))}
        <datalist id={`metrics-${type}`}>{meta?.metrics.map((m: any) => <option key={m.name} value={m.name}>{m.label}</option>)}</datalist>
        <div><button className="sm" onClick={() => setD({ ...d, thresholds: [...d.thresholds, { metric: '', op: '>', warning: '', critical: '' }] })}>Schwellwert hinzufügen</button></div>
      </div>
      <h3 style={{ marginTop: 6 }}>Zustandsbewertung</h3>
      <div className="form-grid">
        <Field label="Fehler bestätigen nach" hint="aufeinanderfolgende schlechte Ergebnisse"><input type="number" min={1} value={d.fail_after} onChange={(e) => setD({ ...d, fail_after: e.target.value })} /></Field>
        <Field label="Recovery nach" hint="aufeinanderfolgende gute Ergebnisse"><input type="number" min={1} value={d.recover_after} onChange={(e) => setD({ ...d, recover_after: e.target.value })} /></Field>
        <Field label="Mindestdauer (s)" hint="Störung muss zusätzlich so lange anhalten"><input type="number" min={0} value={d.hold_s} onChange={(e) => setD({ ...d, hold_s: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
