import { beforeEach, expect, test } from "bun:test";
import { money } from "./money.ts";
import type { CommerceStorage } from "./storage-handlers.ts";
import type { Order, Sku } from "./types.ts";

/**
 * Contract tests for {@link CommerceStorage} — the seven handlers
 * `createCommerce` calls. Use it when you fulfil the handlers yourself rather
 * than through a lower-level store adapter:
 *
 * ```ts
 * import { describeCommerceStorage } from "mollie-ecommerce/storage/conformance";
 * describeCommerceStorage("my-orm", async () => {
 *   await truncate();
 *   return { storage: myStorage, saveSku: (sku) => myCatalog.put(sku) };
 * });
 * ```
 *
 * @param name Label for the test names.
 * @param factory Returns a clean storage plus a way to seed SKUs, which is
 * your catalog's job rather than the library's.
 */
export function describeCommerceStorage(
  name: string,
  factory: () => Promise<StorageUnderTest> | StorageUnderTest,
): void {
  let storage: CommerceStorage;
  let saveSku: (sku: Sku) => Promise<unknown>;

  const mug: Sku = {
    id: "mug",
    name: "Enamel mug",
    kind: "physical",
    price: money(1250, "EUR"),
    stock: 10,
  };

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

  const reserve = [{ skuId: "mug", quantity: 2 }];

  beforeEach(async () => {
    ({ storage, saveSku } = await factory());
    await saveSku(mug);
  });

  test(`${name}: loadSkus batches and skips unknown ids`, async () => {
    await saveSku({ ...mug, id: "second" });
    const found = await storage.loadSkus(["mug", "second", "ghost"]);
    expect(found.map((sku) => sku.id).sort()).toEqual(["mug", "second"]);
    expect(await storage.loadSkus([])).toEqual([]);
  });

  test(`${name}: createOrder stores the order, takes the stock, assigns a version`, async () => {
    const result = await storage.createOrder({ order: order(), reserveStock: reserve });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;

    expect(result.order.version).toBeGreaterThan(0);
    expect((await storage.loadSkus(["mug"]))[0]!.stock).toBe(8);
    expect(await storage.findOrder("ord_1")).toEqual(result.order);
  });

  test(`${name}: createOrder reports shortages and stores nothing`, async () => {
    const result = await storage.createOrder({
      order: order(),
      reserveStock: [{ skuId: "mug", quantity: 99 }],
    });

    expect(result.status).toBe("out_of_stock");
    if (result.status !== "out_of_stock") return;
    expect(result.shortages).toEqual([{ skuId: "mug", requested: 99, available: 10 }]);
    // Neither the order nor the stock may have moved.
    expect(await storage.findOrder("ord_1")).toBeNull();
    expect((await storage.loadSkus(["mug"]))[0]!.stock).toBe(10);
  });

  test(`${name}: createOrder with no reservation leaves stock alone`, async () => {
    const result = await storage.createOrder({ order: order(), reserveStock: [] });
    expect(result.status).toBe("created");
    expect((await storage.loadSkus(["mug"]))[0]!.stock).toBe(10);
  });

  test(`${name}: mutateOrder persists the mutation and bumps the version`, async () => {
    const created = await storage.createOrder({ order: order(), reserveStock: [] });
    if (created.status !== "created") throw new Error("setup failed");

    const updated = await storage.mutateOrder("ord_1", (current) => {
      current.payment.state = "paid";
      current.payment.id = "tr_1";
    });

    expect(updated.payment.state).toBe("paid");
    expect(updated.version).toBeGreaterThan(created.order.version);
    expect((await storage.findOrder("ord_1"))?.payment.id).toBe("tr_1");
  });

  test(`${name}: mutateOrder applies releaseStock in the same write`, async () => {
    await storage.createOrder({ order: order(), reserveStock: reserve });
    expect((await storage.loadSkus(["mug"]))[0]!.stock).toBe(8);

    await storage.mutateOrder("ord_1", (current) => {
      current.stockReserved = false;
      return { releaseStock: reserve };
    });

    expect((await storage.loadSkus(["mug"]))[0]!.stock).toBe(10);
    expect((await storage.findOrder("ord_1"))?.stockReserved).toBe(false);
  });

  test(`${name}: a throwing mutator changes nothing`, async () => {
    await storage.createOrder({ order: order(), reserveStock: reserve });

    await expect(
      storage.mutateOrder("ord_1", (current) => {
        current.payment.state = "paid";
        throw new Error("mutator failed");
      }),
    ).rejects.toThrow("mutator failed");

    expect((await storage.findOrder("ord_1"))?.payment.state).toBe("created");
    expect((await storage.loadSkus(["mug"]))[0]!.stock).toBe(8);
  });

  test(`${name}: mutateOrder on a missing order fails with order_not_found`, async () => {
    await expect(storage.mutateOrder("ord_ghost", () => {})).rejects.toMatchObject({
      code: "order_not_found",
    });
  });

  test(`${name}: lookups by payment id and idempotency key`, async () => {
    await storage.createOrder({
      reserveStock: [],
      order: order({
        payment: { state: "open", id: "tr_abc", amountRefunded: money(0, "EUR") },
        idempotencyKey: "key-1",
      }),
    });

    expect((await storage.findOrderByPaymentId("tr_abc"))?.id).toBe("ord_1");
    expect((await storage.findOrderByIdempotencyKey("key-1"))?.id).toBe("ord_1");
    expect(await storage.findOrderByPaymentId("tr_nope")).toBeNull();
    expect(await storage.findOrderByIdempotencyKey("nope")).toBeNull();
    expect(await storage.findOrder("ord_nope")).toBeNull();
  });

  test(`${name}: listOrders filters and pages, oldest first`, async () => {
    for (const [id, createdAt, state] of [
      ["a", "2026-01-01T00:00:00.000Z", "open"],
      ["b", "2026-02-01T00:00:00.000Z", "paid"],
      ["c", "2026-03-01T00:00:00.000Z", "refunded"],
    ] as const) {
      await storage.createOrder({
        reserveStock: [],
        order: order({
          id,
          createdAt,
          payment: { state, amountRefunded: money(0, "EUR") },
        }),
      });
    }

    expect((await storage.listOrders()).map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect((await storage.listOrders({ paymentState: "paid" })).map((row) => row.id)).toEqual(["b"]);
    expect(
      (await storage.listOrders({ paymentState: ["paid", "refunded"] })).map((row) => row.id),
    ).toEqual(["b", "c"]);
    expect(
      (await storage.listOrders({ createdAfter: "2026-02-01T00:00:00.000Z" })).map((row) => row.id),
    ).toEqual(["b", "c"]);
    expect((await storage.listOrders({ limit: 2 })).map((row) => row.id)).toEqual(["a", "b"]);
    expect((await storage.listOrders({ limit: 2, offset: 2 })).map((row) => row.id)).toEqual(["c"]);
  });
}

export type StorageUnderTest = {
  storage: CommerceStorage;
  /** Seeds a SKU. Writing the catalog is your job, not the library's. */
  saveSku: (sku: Sku) => Promise<unknown>;
};
