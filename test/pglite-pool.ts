import { PGlite } from "@electric-sql/pglite";
import {
  applyPostgresSchema,
  createPostgresDatabase,
  type PostgresClient,
  type PostgresPool,
} from "../src/storage/postgres.ts";
import type { Database } from "../src/ports.ts";

/**
 * Test-only: runs the Postgres adapter against [PGlite](https://pglite.dev),
 * a real Postgres compiled to WebAssembly. It keeps the suite honest about
 * actual Postgres behavior — placeholders, array parameters, CTEs,
 * `unnest`, `ON CONFLICT`, error codes — with no server to install and no
 * dependency on the shipped library.
 *
 * PGlite is a devDependency only: the published adapter imports no driver.
 */
class PglitePool implements PostgresPool {
  constructor(private readonly client: PGlite) {}

  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const { rows } = await this.client.query<T>(sql, params as unknown[] | undefined);
    return { rows: rows as T[] };
  }

  /**
   * PGlite has exactly one connection, so a "checked out client" is the same
   * connection. `BEGIN`/`COMMIT`/`ROLLBACK` go through it as plain statements,
   * which is what `createPostgresDatabase` issues.
   */
  async connect(): Promise<PostgresClient> {
    return {
      query: this.query.bind(this),
      release: () => {},
    };
  }
}

export type PostgresTestDatabase = {
  db: Database;
  /** The pool the stores are bound to, for schema and truncate calls. */
  pool: PostgresPool;
  /** Empties both tables, so one WebAssembly boot can serve many tests. */
  reset(): Promise<void>;
  close(): Promise<void>;
};

export async function createPglitePostgres(): Promise<PostgresTestDatabase> {
  const client = new PGlite();
  await client.waitReady;

  const pool = new PglitePool(client);
  await applyPostgresSchema(pool);

  return {
    db: createPostgresDatabase(pool),
    pool,
    reset: async () => {
      await client.exec("TRUNCATE skus, orders");
    },
    close: () => client.close(),
  };
}
