import { expect, test } from "bun:test";
import { describeDatabase } from "../src/storage/conformance.ts";
import { money } from "../src/money.ts";
import { applyPostgresSchema } from "../src/storage/postgres.ts";
import { createPglitePostgres } from "./pglite-pool.ts";

// Booting a WebAssembly Postgres takes ~1s, so one instance is shared and
// truncated between tests rather than recreated.
const postgres = await createPglitePostgres();

describeDatabase("postgres", async () => {
  await postgres.reset();
  return postgres.db;
});

/* Behavior documented in the README's "Using Postgres" section. */

test("applyPostgresSchema is safe to run on every boot", async () => {
  // The README says you can call it unconditionally at startup.
  await applyPostgresSchema(postgres.pool);
  await applyPostgresSchema(postgres.pool);

  await postgres.db.products.save({
    id: "mug",
    name: "Enamel mug",
    kind: "physical",
    price: money(1250, "EUR"),
    stock: 4,
  });
  expect((await postgres.db.products.get("mug"))?.stock).toBe(4);
});

test("a nested transaction joins the outer one instead of deadlocking", async () => {
  await postgres.reset();
  await postgres.db.products.save({
    id: "mug",
    name: "Enamel mug",
    kind: "physical",
    price: money(1250, "EUR"),
    stock: 5,
  });

  // A second checked-out connection would block on the rows the first holds,
  // so the inner call must reuse the outer transaction's stores.
  const reserved = await postgres.db.transaction(async (outer) => {
    await outer.products.reserveStock([{ productId: "mug", quantity: 1 }]);
    return postgres.db.transaction(async (inner) => {
      await inner.products.reserveStock([{ productId: "mug", quantity: 2 }]);
      return (await inner.products.get("mug"))?.stock;
    });
  });
  expect(reserved).toBe(2);
  expect((await postgres.db.products.get("mug"))?.stock).toBe(2);

  // Throwing from the inner call rolls back the outer one too — they are one
  // transaction, so there is nothing to commit separately.
  await expect(
    postgres.db.transaction(async (outer) => {
      await outer.products.reserveStock([{ productId: "mug", quantity: 1 }]);
      return postgres.db.transaction(async () => {
        throw new Error("inner failed");
      });
    }),
  ).rejects.toThrow("inner failed");
  expect((await postgres.db.products.get("mug"))?.stock).toBe(2);
});
