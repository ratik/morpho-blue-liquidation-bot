import pino from "pino";

export interface AppLogger {
  debug: (obj: object, msg?: string) => void;
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
  child: (bindings: Record<string, unknown>) => AppLogger;
}

const useJsonLogs = process.env.LOG_FORMAT === "json";
const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(useJsonLogs
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: process.stdout.isTTY,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        },
      }),
}) as AppLogger;

export const logger = rootLogger;

export function createLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

export function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    };
  }

  return error;
}
