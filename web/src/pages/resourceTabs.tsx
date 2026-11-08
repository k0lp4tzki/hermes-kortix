import { ReactNode } from 'react';
import { ResourceChecks } from '../components/ResourceChecks';
import { ResourceMetrics } from '../components/ResourceMetrics';

/** Additional tabs of the resource detail page (checks, metrics, dependencies, alerts). */
export function resourceTabs(d: any): Array<[string, string, ReactNode]> {
  return [
    ['checks', `Checks (${d.check_count})`, <ResourceChecks resource={d} />],
    ['metrics', 'Messwerte & Verlauf', <ResourceMetrics resource={d} />],
  ];
}
