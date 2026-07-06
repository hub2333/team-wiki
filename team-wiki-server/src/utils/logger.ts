/**
 * Lightweight structured logger with timestamps and module context.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;
const currentLevel: Level = (process.env.LOG_LEVEL as Level) || 'info';

function fmt(level: Level, module: string, msg: string, extra?: unknown): string {
  const time = new Date().toISOString().slice(11, 23);
  const prefix = `${time} [${level.toUpperCase()}] [${module}]`;
  if (extra !== undefined) {
    const suffix = typeof extra === 'string' ? extra : JSON.stringify(extra, null, 0);
    return `${prefix} ${msg} ${suffix}`;
  }
  return `${prefix} ${msg}`;
}

export function createLogger(module: string) {
  const log = (level: Level, msg: string, extra?: unknown) => {
    if (LEVELS[level] >= LEVELS[currentLevel]) {
      if (level === 'error') console.error(fmt(level, module, msg, extra));
      else if (level === 'warn') console.warn(fmt(level, module, msg, extra));
      else console.log(fmt(level, module, msg, extra));
    }
  };

  return {
    debug: (msg: string, extra?: unknown) => log('debug', msg, extra),
    info: (msg: string, extra?: unknown) => log('info', msg, extra),
    warn: (msg: string, extra?: unknown) => log('warn', msg, extra),
    error: (msg: string, extra?: unknown) => log('error', msg, extra),
  };
}
