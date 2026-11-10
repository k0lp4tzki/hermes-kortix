import { describe, expect, it } from 'vitest';
import { classifyEndpoint } from '../src/discovery/network.js';

describe('network scan classification', () => {
  it('uses only hard evidence', () => {
    expect(classifyEndpoint('10.1.1.10', [80, 443], '10.1.1.10')).toBe('router');
    expect(classifyEndpoint('10.1.1.61', [22, 443, 902], null)).toBe('hypervisor');
    expect(classifyEndpoint('10.1.1.30', [22, 5000, 5001], null)).toBe('nas');
    expect(classifyEndpoint('10.1.1.53', [53, 80], null)).toBe('dns');
    expect(classifyEndpoint('10.1.1.40', [22, 80, 443], null)).toBe('endpoint');
  });
});
