import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import pg from "pg";

const {Pool} = pg;

/**
 * Postgres access.
 *
 * `NUMERIC(78,0)` columns hold uint256 values, and node-postgres would otherwise hand
 * them back as JavaScript numbers and silently lose precision on anything above 2^53 —
 * which is every wei amount that matters. Forcing them to strings and converting to
 * BigInt at the edge keeps the read model exact.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v: string) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => v);

export type Db = pg.Pool;

export function createDb(connectionString: string): Db {
  return new Pool({connectionString, max: 10, idleTimeoutMillis: 30_000});
}

export async function migrate(db: Db, dir: string): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const applied = new Set((await db.query<{name: string}>("SELECT name FROM migrations")).rows.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    // Each migration runs in its own transaction so a failure leaves no half-applied schema.
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      ran.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed`, {cause: err});
    } finally {
      client.release();
    }
  }
  return ran;
}
