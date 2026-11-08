type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function write(level: Level, component: string, msg: string, extra?: Record<string, unknown>) {
  if (order[level] < min) return;
  const line = { time: new Date().toISOString(), level, component, msg, ...extra };
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
}

export function logger(component: string) {
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => write('debug', component, msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => write('info', component, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => write('warn', component, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => write('error', component, msg, extra),
  };
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    return code && !e.message.includes(code) ? `${code}: ${e.message}` : e.message;
  }
  return String(e);
}
