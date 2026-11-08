import { createHash } from 'node:crypto';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be an integer`);
  return n;
}

export const config = {
  databaseUrl: env('DATABASE_URL', 'postgres://hermes:hermes@localhost:5432/hermes'),
  port: int('PORT', 8080),
  host: env('HOST', '0.0.0.0'),
  secretKey: env('HERMES_SECRET_KEY', ''),
  adminUser: env('HERMES_ADMIN_USER', 'admin'),
  adminPassword: env('HERMES_ADMIN_PASSWORD', ''),
  sessionTtlHours: int('HERMES_SESSION_TTL_HOURS', 24 * 7),
  cookieSecure: env('HERMES_COOKIE_SECURE', 'false') === 'true',
  webDir: env('HERMES_WEB_DIR', ''),
  // Host introspection paths (read-only bind mounts from the docker host)
  hostProc: env('HERMES_HOST_PROC', '/host/proc'),
  hostSys: env('HERMES_HOST_SYS', '/host/sys'),
  hostRoot: env('HERMES_HOST_ROOT', '/hostfs'),
  hostName: env('HERMES_HOST_NAME', ''),
  dockerSocket: env('HERMES_DOCKER_SOCKET', '/var/run/docker.sock'),
  composeProject: env('HERMES_COMPOSE_PROJECT', 'hermes'),
  workerConcurrency: int('HERMES_WORKER_CONCURRENCY', 16),
  retention: {
    rawMetricsDays: int('HERMES_RETENTION_RAW_DAYS', 14),
    checkResultsDays: int('HERMES_RETENTION_RESULTS_DAYS', 30),
    metrics5mDays: int('HERMES_RETENTION_5M_DAYS', 180),
    metrics1hDays: int('HERMES_RETENTION_1H_DAYS', 1095),
    eventsDays: int('HERMES_RETENTION_EVENTS_DAYS', 365),
  },
};

export function encryptionKey(): Buffer {
  if (!config.secretKey || config.secretKey.length < 16) {
    throw new Error('HERMES_SECRET_KEY must be set (at least 16 characters) to store or read secrets');
  }
  return createHash('sha256').update(config.secretKey).digest();
}
