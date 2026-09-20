import path from "node:path";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema";

/** Works for both the top-level database and a transaction handle. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

const migrationsFolder = path.join(__dirname, "..", "..", "drizzle");

/**
 * - databaseUrl set -> PostgreSQL via node-postgres (production / docker compose)
 * - otherwise       -> embedded PGlite (real Postgres compiled to WASM): zero-setup dev and tests.
 *                      Same SQL, same migrations.
 */
export async function createDb(opts: {
  databaseUrl?: string | undefined;
  pgliteDir?: string | undefined;
  migrate?: boolean;
}): Promise<DbHandle> {
  const migrate = opts.migrate ?? true;
  if (opts.databaseUrl) {
    const pool = new Pool({ connectionString: opts.databaseUrl, max: 10 });
    const db = drizzlePg(pool, { schema });
    if (migrate) await migratePg(db, { migrationsFolder });
    return { db, close: () => pool.end() };
  }

  let PGlite: typeof import("@electric-sql/pglite").PGlite;
  let drizzleLite: typeof import("drizzle-orm/pglite").drizzle;
  let migrateLite: typeof import("drizzle-orm/pglite/migrator").migrate;
  try {
    ({ PGlite } = await import("@electric-sql/pglite"));
    ({ drizzle: drizzleLite } = await import("drizzle-orm/pglite"));
    ({ migrate: migrateLite } = await import("drizzle-orm/pglite/migrator"));
  } catch {
    throw new Error("DATABASE_URL is not set and the embedded database (@electric-sql/pglite) is not installed");
  }
  const client = new PGlite(opts.pgliteDir);
  const db = drizzleLite(client, { schema });
  if (migrate) await migrateLite(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close() };
}
