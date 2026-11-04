import { Pool, type PoolClient } from "pg";
import type { Database } from "./storage/ports.ts";
import {
  createPostgresDatabase,
  type PostgresClient,
  type PostgresPool,
  type Queryable,
} from "./storage/postgres.ts";

/**
 * Compile-time guard, not a test: node-postgres' `Pool` and `PoolClient` must
 * satisfy the Postgres fixture's ports without casts, so the shape the suite
 * exercises through PGlite stays the shape a real driver has.
 *
 * Nothing here runs — `tsc --noEmit` is the assertion. `pg` and `@types/pg`
 * are devDependencies for this file alone; the library imports no driver.
 */
export function assertPgSatisfiesPorts(pool: Pool, client: PoolClient): void {
  const asPool: PostgresPool = pool;
  const asQueryable: Queryable = pool;
  const asClient: PostgresClient = client;
  const asClientQueryable: Queryable = client;
  const db: Database = createPostgresDatabase(pool);

  void asPool, asQueryable, asClient, asClientQueryable, db;
}
