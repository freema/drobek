/**
 * Logger interface stub (core stays vendor-free — §15 ARCHITECTURE.md).
 * drobek-web plugs Sentry/pino behind this; core + self-host default to
 * the console logger.
 */
export type LogMeta = Record<string, unknown>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

export function createConsoleLogger(name: string): Logger {
  const line = (level: string, message: string, meta?: LogMeta): string =>
    JSON.stringify({
      level,
      name,
      message,
      time: new Date().toISOString(),
      ...meta,
    });
  return {
    debug: (message, meta) => console.debug(line('debug', message, meta)),
    info: (message, meta) => console.info(line('info', message, meta)),
    warn: (message, meta) => console.warn(line('warn', message, meta)),
    error: (message, meta) => console.error(line('error', message, meta)),
  };
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
