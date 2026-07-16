/**
 * Structured JSON logging.
 *
 * One object per line, so an operator can grep a field rather than a phrase and a log
 * shipper can index it without a parser. Errors are flattened rather than stringified,
 * because "[object Object]" in an incident log is worse than no log.
 */
export type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {debug: 10, info: 20, warn: 30, error: 40};
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

function serialiseError(value: unknown): unknown {
  if (value instanceof Error) {
    return {name: value.name, message: value.message, stack: value.stack, cause: serialiseError(value.cause)};
  }
  return value;
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < threshold) return;
  const record: Record<string, unknown> = {ts: new Date().toISOString(), level, msg};
  for (const [k, v] of Object.entries(fields)) {
    record[k] = k === "err" || v instanceof Error ? serialiseError(v) : typeof v === "bigint" ? v.toString() : v;
  }
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
  child: (base: Record<string, unknown>) => ({
    debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, {...base, ...f}),
    info: (m: string, f?: Record<string, unknown>) => emit("info", m, {...base, ...f}),
    warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, {...base, ...f}),
    error: (m: string, f?: Record<string, unknown>) => emit("error", m, {...base, ...f}),
  }),
};
