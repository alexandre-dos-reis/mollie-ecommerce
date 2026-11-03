import { expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import type { Database } from "../src/ports.ts";
import {
  createPostgresDatabase,
  type PostgresClient,
  type PostgresPool,
  type Queryable,
} from "../src/storage/postgres.ts";

/**
 * Compile-time guard for the setup documented in the README: node-postgres'
 * `Pool` and `PoolClient` must satisfy the adapter's ports without casts, so
 * the documented snippet keeps compiling as either side changes.
 *
 * No connection is opened — `new Pool()` is lazy, and `checkPoolClient` is
 * never called. Behavior is covered by `postgres.test.ts`, which runs the
 * adapter on PGlite. `pg` and `@types/pg` are devDependencies only; the
 * adapter itself imports no driver.
 */

// Never invoked: its body exists purely to be typechecked.
function checkPoolClient(client: PoolClient): void {
  const asClient: PostgresClient = client;
  const asQueryable: Queryable = client;
  void asClient;
  void asQueryable;
}

test("node-postgres satisfies the Postgres adapter's ports", () => {
  const pool = new Pool({ connectionString: "postgres://localhost/unused" });

  // These assignments are the test: they stop compiling on drift.
  const asPool: PostgresPool = pool;
  const asQueryable: Queryable = pool;
  const db: Database = createPostgresDatabase(pool);

  expect(typeof asPool.connect).toBe("function");
  expect(typeof asQueryable.query).toBe("function");
  expect(typeof db.transaction).toBe("function");
  expect(db.skus).toBeDefined();
  expect(db.orders).toBeDefined();
  expect(checkPoolClient).toBeInstanceOf(Function);
});
