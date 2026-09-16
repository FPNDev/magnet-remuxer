type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL as Level] ?? LEVELS.info;

type Fields = Record<string, unknown>;

function write(level: Level, message: string, fields?: Fields): void {
  if (LEVELS[level] < threshold) {
    return;
  }

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const output = fields ? `${line} ${JSON.stringify(fields)}` : line;
  if (level === 'warn' || level === 'error') {
    console.error(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  debug: (message: string, fields?: Fields) => write('debug', message, fields),
  info: (message: string, fields?: Fields) => write('info', message, fields),
  warn: (message: string, fields?: Fields) => write('warn', message, fields),
  error: (message: string, fields?: Fields) => write('error', message, fields),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
