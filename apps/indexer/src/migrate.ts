import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {createDb, migrate} from "./db.js";

const url = process.env.DATABASE_URL ?? "postgres://pons:pons@127.0.0.1:55432/pons";
const db = createDb(url);
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const ran = await migrate(db, dir);
console.log(ran.length ? `applied: ${ran.join(", ")}` : "schema already up to date");
await db.end();
