// Structured logging: one JSON object per line on stdout.
// Never pass secrets, prompts, completions, session tokens, API keys,
// or request bodies as fields — callers are responsible for keeping
// LogFields to safe metadata (ids, counts, timings, feature flags).

export interface LogFields {
  [k: string]: string | number | boolean | null | undefined;
}

export type LogLevelName = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevelName, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function parseLevel(raw: string | undefined): LogLevelName {
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

// Worker envs have no process.env, so the app pushes its LOG_LEVEL in
// via setLogLevel (createApp does this from its env bindings; node.ts
// does it from process.env). An explicit set always wins over the
// process fallback.
let configuredLevel: LogLevelName | null = null;

export function setLogLevel(raw: string | undefined): void {
  configuredLevel = raw === undefined ? null : parseLevel(raw);
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

// A process-wide logger. LOG_LEVEL=debug enables debug lines;
// anything else keeps the default info threshold. The level is read
// lazily on every call so tests can flip process.env.LOG_LEVEL.
export const log: Logger = {
  debug(message, fields) {
    emit("debug", message, fields);
  },
  info(message, fields) {
    emit("info", message, fields);
  },
  warn(message, fields) {
    emit("warn", message, fields);
  },
  error(message, fields) {
    emit("error", message, fields);
  },
};

function emit(level: LogLevelName, message: string, fields?: LogFields): void {
  const threshold =
    configuredLevel ??
    parseLevel(typeof process !== "undefined" ? process.env.LOG_LEVEL : undefined);
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) {
    return;
  }
  const line: Record<string, string | number | boolean | null> = {
    ts: Date.now(),
    level,
    msg: message,
  };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        line[key] = value;
      }
    }
  }
  // Single sink: one JSON object per line.
  console.log(JSON.stringify(line));
}
