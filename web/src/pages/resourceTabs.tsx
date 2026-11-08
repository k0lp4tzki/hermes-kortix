import { ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { ResourceChecks } from '../components/ResourceChecks';
import { ResourceMetrics } from '../components/ResourceMetrics';
import { ResourceDeps } from '../components/ResourceDeps';
import { IncidentDetail, IncidentTable, MaintenanceDialog } from './Alerts';
import { useAuth } from '../lib/auth';

function ResourceAlerts({ resource }: { resource: any }) {
  const { can } = useAuth();
  const inc = useQuery({ queryKey: ['incidents', 'resource', resource.id], queryFn: () => get<any[]>(`/incidents?resource_id=${resource.id}`) });
  const [open, setOpen] = useState<string | null>(null);
  const [maint, setMaint] = useState(false);
  return (
    <div className="panel flush">
      <div className="panel-head" style={{ padding: '12px 14px 0' }}><h2>Störungen (Ursache oder betroffen)</h2>
        <div className="actions">{can('operator') && <button className="sm" onClick={() => setMaint(true)}>Wartungsfenster planen</button>}</div></div>
      <IncidentTable list={inc.data ?? []} loading={inc.isLoading} onOpen={setOpen} compact />
      {open && <IncidentDetail id={open} onClose={() => setOpen(null)} />}
      {maint && <MaintenanceDialog preset={[resource.id]} onClose={() => setMaint(false)} />}
    </div>
  );
}

/** Additional tabs of the resource detail page (checks, metrics, dependencies, alerts). */
export function resourceTabs(d: any): Array<[string, string, ReactNode]> {
  return [
    ['checks', `Checks (${d.check_count})`, <ResourceChecks resource={d} />],
    ['metrics', 'Messwerte & Verlauf', <ResourceMetrics resource={d} />],
    ['deps', 'Abhängigkeiten', <ResourceDeps resource={d} />],
    ['alerts', `Alarme${d.open_incidents ? ` (${d.open_incidents})` : ''}`, <ResourceAlerts resource={d} />],
  ];
}
