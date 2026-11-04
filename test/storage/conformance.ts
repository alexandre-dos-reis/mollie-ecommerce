import { beforeEach, expect, test } from "bun:test";
import { CommerceError } from "../../src/errors.ts";
import { money } from "../../src/money.ts";
import type { Database } from "./ports.ts";
import type { Order, Sku } from "../../src/types.ts";

/**
 * Contract tests for a {@link Database} implementation. Call it from a test
 * file with a factory and your adapter is held to the same behavior the
 * library relies on:
 *
 * ```ts
 * import { describeDatabase } from "mollie-ecommerce/storage/conformance";
 * describeDatabase("postgres", () => new PostgresDatabase({ url }));
 * ```
 */
export function describeDatabase(name: string, factory: () => Database | Promise<Database>): void {
  let db: Database;

  const sku = (overrides: Partial<Sku> = {}): Sku => ({
    id: "mug",
    name: "Enamel mug",
    kind: "physical",
    price: money(1250, "EUR"),
    stock: 10,
    ...overrides,
  });

  const order = (overrides: Partial<Order> = {}): Order => ({
    id: "ord_1",
    version: 0,
    lines: [
      {
        skuId: "mug",
        name: "Enamel mug",
        kind: "physical",
        quantity: 2,
        unitPrice: money(1250, "EUR"),
        total: money(2500, "EUR"),
      },
    ],
    total: money(2500, "EUR"),
    customer: { email: "ada@example.com", locale: "nl_NL" },
    payment: { state: "created", amountRefunded: money(0, "EUR") },
    stockReserved: false,
    delivery: { state: "not_started" },
    refunds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  beforeEach(async () => {
    db = await factory();
    await db.skus.save(sku());
  });

  test(`${name}: skus round-trip without losing fields`, async () => {
    const full = sku({ id: "full", kind: "service", stock: 3, active: false });
    await db.skus.save(full);
    expect(await db.skus.get("full")).toEqual(full);
  });

  test(`${name}: unlimited stock survives the round trip as undefined`, async () => {
    await db.skus.save(sku({ id: "ebook", kind: "digital", stock: undefined }));
    const stored = await db.skus.get("ebook");
    expect(stored?.stock).toBeUndefined();
  });

  test(`${name}: getMany batches and tolerates missing ids`, async () => {
    await db.skus.save(sku({ id: "second" }));
    const found = await db.skus.getMany(["mug", "second", "ghost"]);
    expect(found.map((p) => p.id).sort()).toEqual(["mug", "second"]);
    expect(await db.skus.getMany([])).toEqual([]);
  });

  test(`${name}: list filters on kind and active`, async () => {
    await db.skus.save(sku({ id: "ebook", kind: "digital" }));
    await db.skus.save(sku({ id: "gone", active: false }));
    expect((await db.skus.list({ kind: "digital" })).map((p) => p.id)).toEqual(["ebook"]);
    expect((await db.skus.list({ active: false })).map((p) => p.id)).toEqual(["gone"]);
    expect(await db.skus.list({ limit: 1 })).toHaveLength(1);
  });

  test(`${name}: reserveStock decrements, and is all-or-nothing on shortage`, async () => {
    expect(await db.skus.reserveStock([{ skuId: "mug", quantity: 4 }])).toEqual([]);
    expect((await db.skus.get("mug"))?.stock).toBe(6);

    await db.skus.save(sku({ id: "scarce", stock: 1 }));
    const shortages = await db.skus.reserveStock([
      { skuId: "mug", quantity: 1 },
      { skuId: "scarce", quantity: 2 },
    ]);
    expect(shortages).toEqual([{ skuId: "scarce", requested: 2, available: 1 }]);
    // The mug must not have been touched by the failed batch.
    expect((await db.skus.get("mug"))?.stock).toBe(6);
    expect((await db.skus.get("scarce"))?.stock).toBe(1);
  });

  test(`${name}: reserveStock aggregates repeated product ids`, async () => {
    // Two lines for the same SKU must consume the sum, not be checked and
    // decremented independently — otherwise the second line oversells.
    await db.skus.save(sku({ id: "scarce", stock: 3 }));
    const shortages = await db.skus.reserveStock([
      { skuId: "scarce", quantity: 2 },
      { skuId: "scarce", quantity: 2 },
    ]);
    expect(shortages).toEqual([{ skuId: "scarce", requested: 4, available: 3 }]);
    expect((await db.skus.get("scarce"))?.stock).toBe(3);

    expect(
      await db.skus.reserveStock([
        { skuId: "scarce", quantity: 2 },
        { skuId: "scarce", quantity: 1 },
      ]),
    ).toEqual([]);
    expect((await db.skus.get("scarce"))?.stock).toBe(0);
  });

  test(`${name}: reserveStock reports missing skus and ignores unlimited ones`, async () => {
    expect(await db.skus.reserveStock([{ skuId: "ghost", quantity: 1 }])).toEqual([
      { skuId: "ghost", requested: 1, available: null },
    ]);
    await db.skus.save(sku({ id: "ebook", stock: undefined }));
    expect(await db.skus.reserveStock([{ skuId: "ebook", quantity: 99 }])).toEqual([]);
    expect((await db.skus.get("ebook"))?.stock).toBeUndefined();
  });

  test(`${name}: releaseStock gives stock back and skips unlimited skus`, async () => {
    await db.skus.reserveStock([{ skuId: "mug", quantity: 3 }]);
    await db.skus.releaseStock([{ skuId: "mug", quantity: 3 }]);
    expect((await db.skus.get("mug"))?.stock).toBe(10);

    await db.skus.save(sku({ id: "ebook", stock: undefined }));
    await db.skus.releaseStock([{ skuId: "ebook", quantity: 3 }]);
    expect((await db.skus.get("ebook"))?.stock).toBeUndefined();
  });

  test(`${name}: orders round-trip with their lines and refunds`, async () => {
    const rich = order({
      payment: {
        state: "partially_refunded",
        id: "tr_1",
        checkoutUrl: "https://pay.test/tr_1",
        amountRefunded: money(1250, "EUR"),
      },
      delivery: { state: "shipped", carrier: "PostNL", trackingCode: "3S1" },
      refunds: [
        {
          id: "re_1",
          amount: money(1250, "EUR"),
          state: "pending",
          reason: "chipped",
          createdAt: "2026-01-01T02:00:00.000Z",
        },
      ],
    });
    const inserted = await db.orders.insert(rich);
    expect(await db.orders.get(rich.id)).toEqual({ ...rich, version: inserted.version });
  });

  test(`${name}: insert assigns a version and rejects duplicates`, async () => {
    const inserted = await db.orders.insert(order());
    expect(inserted.version).toBeGreaterThan(0);

    const duplicate = db.orders.insert(order());
    await expect(duplicate).rejects.toThrow(CommerceError);
    await expect(duplicate).rejects.toMatchObject({ code: "duplicate_order" });
  });

  test(`${name}: update bumps the version and rejects a stale write`, async () => {
    const first = await db.orders.insert(order());
    const second = await db.orders.update({ ...first, payment: { ...first.payment, id: "tr_9" } });
    expect(second.version).toBe(first.version + 1);
    expect((await db.orders.get(first.id))?.payment.id).toBe("tr_9");

    // `first` is now stale: writing it must not clobber `second`.
    const stale = db.orders.update({ ...first, payment: { ...first.payment, id: "tr_clobber" } });
    await expect(stale).rejects.toMatchObject({ code: "version_conflict" });
    expect((await db.orders.get(first.id))?.payment.id).toBe("tr_9");
  });

  test(`${name}: update of a missing order fails`, async () => {
    await expect(db.orders.update(order({ id: "ghost", version: 1 }))).rejects.toMatchObject({
      code: "order_not_found",
    });
  });

  test(`${name}: lookups by payment id and idempotency key`, async () => {
    await db.orders.insert(
      order({
        payment: { state: "open", id: "tr_abc", amountRefunded: money(0, "EUR") },
        idempotencyKey: "key-1",
      }),
    );
    expect((await db.orders.findByPaymentId("tr_abc"))?.id).toBe("ord_1");
    expect((await db.orders.findByIdempotencyKey("key-1"))?.id).toBe("ord_1");
    expect(await db.orders.findByPaymentId("tr_nope")).toBeNull();
    expect(await db.orders.findByIdempotencyKey("nope")).toBeNull();
  });

  test(`${name}: find filters, sorts by creation and pages`, async () => {
    await db.orders.insert(order({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }));
    await db.orders.insert(
      order({
        id: "b",
        createdAt: "2026-02-01T00:00:00.000Z",
        payment: { state: "paid", amountRefunded: money(0, "EUR") },
        delivery: { state: "ready" },
        customer: { email: "grace@example.com" },
      }),
    );
    await db.orders.insert(
      order({
        id: "c",
        createdAt: "2026-03-01T00:00:00.000Z",
        payment: { state: "refunded", amountRefunded: money(2500, "EUR") },
      }),
    );

    expect((await db.orders.find()).map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect((await db.orders.find({ paymentState: "paid" })).map((o) => o.id)).toEqual(["b"]);
    expect(
      (await db.orders.find({ paymentState: ["paid", "refunded"] })).map((o) => o.id),
    ).toEqual(["b", "c"]);
    expect((await db.orders.find({ deliveryState: "ready" })).map((o) => o.id)).toEqual(["b"]);
    expect(
      (await db.orders.find({ customerEmail: "grace@example.com" })).map((o) => o.id),
    ).toEqual(["b"]);
    expect(
      (await db.orders.find({ createdAfter: "2026-02-01T00:00:00.000Z" })).map((o) => o.id),
    ).toEqual(["b", "c"]);
    expect(
      (await db.orders.find({ createdBefore: "2026-02-01T00:00:00.000Z" })).map((o) => o.id),
    ).toEqual(["a"]);
    expect((await db.orders.find({ limit: 2 })).map((o) => o.id)).toEqual(["a", "b"]);
    expect((await db.orders.find({ limit: 2, offset: 2 })).map((o) => o.id)).toEqual(["c"]);
  });

  test(`${name}: a transaction commits every write together`, async () => {
    await db.transaction(async (stores) => {
      await stores.orders.insert(order({ id: "committed" }));
      await stores.skus.reserveStock([{ skuId: "mug", quantity: 2 }]);
    });
    expect(await db.orders.get("committed")).not.toBeNull();
    expect((await db.skus.get("mug"))?.stock).toBe(8);
  });

  test(`${name}: a throwing transaction rolls every write back`, async () => {
    const boom = db.transaction(async (stores) => {
      await stores.orders.insert(order({ id: "rolled-back" }));
      await stores.skus.reserveStock([{ skuId: "mug", quantity: 2 }]);
      throw new Error("boom");
    });
    await expect(boom).rejects.toThrow("boom");
    expect(await db.orders.get("rolled-back")).toBeNull();
    expect((await db.skus.get("mug"))?.stock).toBe(10);
  });

  test(`${name}: a transaction's return value reaches the caller`, async () => {
    const result = await db.transaction(async (stores) => {
      const inserted = await stores.orders.insert(order({ id: "returned" }));
      return inserted.id;
    });
    expect(result).toBe("returned");
  });

  test(`${name}: the database survives a rolled-back transaction`, async () => {
    await expect(
      db.transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await db.orders.insert(order({ id: "after" }));
    expect(await db.orders.get("after")).not.toBeNull();
  });
}
