/** Same structured-line format the keeper uses, so both feed one log pipeline. */
export type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = {debug: 10, info: 20, warn: 30, error: 40};
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (LEVELS[level] < threshold) return;
  const rec: Record<string, unknown> = {ts: new Date().toISOString(), level, msg};
  for (const [k, v] of Object.entries(fields)) {
    rec[k] =
      v instanceof Error ? {name: v.name, message: v.message, stack: v.stack} : typeof v === "bigint" ? v.toString() : v;
  }
  const line = JSON.stringify(rec);
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
