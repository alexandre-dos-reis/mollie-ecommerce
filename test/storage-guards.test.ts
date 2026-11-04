import { expect, test } from "bun:test";
import { createMemoryStorage } from "../examples/memory-storage.ts";
import { createCommerce } from "../src/commerce.ts";
import { CommerceError } from "../src/errors.ts";
import { FakePaymentGateway } from "../src/fake-gateway.ts";
import { money } from "../src/money.ts";
import {
  checkedStorage,
  withStorageErrorHandler,
  type StorageErrorContext,
} from "../src/storage-guards.ts";
import type { CommerceStorage } from "../src/storage-handlers.ts";
import type { Order, Sku } from "../src/types.ts";

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
      quantity: 1,
      unitPrice: money(1250, "EUR"),
      total: money(1250, "EUR"),
    },
  ],
  total: money(1250, "EUR"),
  payment: { state: "created", amountRefunded: money(0, "EUR") },
  stockReserved: false,
  delivery: { state: "not_started" },
  refunds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/** A storage whose handlers can be replaced one at a time. */
function brokenStorage(overrides: Partial<CommerceStorage>): CommerceStorage {
  const { storage, saveSku } = createMemoryStorage([mug]);
  void saveSku;
  return checkedStorage({ ...storage, ...overrides });
}

const contract = { code: "storage_contract" };

/* ------------------------------------------------------------ shape checks */

test("a malformed SKU is caught at loadSkus", async () => {
  const storage = brokenStorage({
    loadSkus: async () => [{ ...mug, price: { cents: 12.5, currency: "EUR" } }],
  });
  const failure = storage.loadSkus(["mug"]);
  await expect(failure).rejects.toMatchObject(contract);
  // The message points at the offending field, not just "invalid".
  await expect(failure).rejects.toThrow(/price\.cents/);
});

test("a malformed order is caught on the way out of a read", async () => {
  const storage = brokenStorage({
    findOrder: async () => ({ ...order(), stockReserved: "yes" }) as unknown as Order,
  });
  await expect(storage.findOrder("ord_1")).rejects.toMatchObject(contract);
});

test("an unknown payment state is caught", async () => {
  const storage = brokenStorage({
    findOrderByPaymentId: async () =>
      ({ ...order(), payment: { ...order().payment, state: "settled" } }) as unknown as Order,
  });
  await expect(storage.findOrderByPaymentId("tr_1")).rejects.toThrow(/payment\.state/);
});

test("null from a lookup is valid, and passes through", async () => {
  const storage = brokenStorage({ findOrder: async () => null });
  expect(await storage.findOrder("ord_ghost")).toBeNull();
});

test("validated values are passed through unchanged, not re-parsed", async () => {
  const skus = [{ ...mug }];
  const storage = brokenStorage({ loadSkus: async () => skus });
  // The same array and objects come back, so nothing is stripped or coerced.
  expect(await storage.loadSkus(["mug"])).toBe(skus);
});

/* --------------------------------------------------------- semantic checks */

test("loadSkus may not invent or repeat SKUs", async () => {
  await expect(
    brokenStorage({ loadSkus: async () => [{ ...mug, id: "other" }] }).loadSkus(["mug"]),
  ).rejects.toThrow(/not requested: other/);

  await expect(
    brokenStorage({ loadSkus: async () => [{ ...mug }, { ...mug }] }).loadSkus(["mug"]),
  ).rejects.toThrow(/same SKU more than once/);
});

test("createOrder must return the order it was given, with a version", async () => {
  await expect(
    brokenStorage({
      createOrder: async () => ({ status: "created", order: order({ id: "ord_other", version: 1 }) }),
    }).createOrder({ order: order(), reserveStock: [] }),
  ).rejects.toThrow(/returned order ord_other but was given ord_1/);

  await expect(
    brokenStorage({
      createOrder: async () => ({ status: "created", order: order({ version: 0 }) }),
    }).createOrder({ order: order(), reserveStock: [] }),
  ).rejects.toThrow(/version of at least 1/);
});

test("an out_of_stock result must say what fell short", async () => {
  await expect(
    brokenStorage({
      createOrder: async () => ({ status: "out_of_stock", shortages: [] }),
    }).createOrder({ order: order(), reserveStock: [{ skuId: "mug", quantity: 1 }] }),
  ).rejects.toMatchObject(contract);
});

test("mutateOrder must call the mutator and advance the version", async () => {
  const stale = brokenStorage({
    mutateOrder: async (_id, apply) => {
      const current = order({ version: 3 });
      await apply(current);
      return current; // same version: a lost write
    },
  });
  await expect(stale.mutateOrder("ord_1", () => {})).rejects.toThrow(/not newer than 3/);

  const skipped = brokenStorage({ mutateOrder: async () => order({ version: 9 }) });
  await expect(skipped.mutateOrder("ord_1", () => {})).rejects.toThrow(/never called the mutator/);

  const wrongOrder = brokenStorage({
    mutateOrder: async (_id, apply) => {
      const current = order({ id: "ord_other", version: 1 });
      await apply(current);
      return order({ version: 2 });
    },
  });
  await expect(wrongOrder.mutateOrder("ord_1", () => {})).rejects.toThrow(/passed order ord_other/);
});

test("a mutation returning junk is caught", async () => {
  const { storage } = createMemoryStorage([mug]);
  const checked = checkedStorage(storage);
  await checked.createOrder({ order: order(), reserveStock: [] });

  await expect(
    // @ts-expect-error — releaseStock must be StockChange[]
    checked.mutateOrder("ord_1", () => ({ releaseStock: [{ skuId: "mug" }] })),
  ).rejects.toThrow(/releaseStock/);
});

test("a conforming storage is unaffected", async () => {
  const { storage, saveSku } = createMemoryStorage();
  await saveSku(mug);
  const checked = checkedStorage(storage);

  const created = await checked.createOrder({
    order: order(),
    reserveStock: [{ skuId: "mug", quantity: 1 }],
  });
  expect(created.status).toBe("created");
  const updated = await checked.mutateOrder("ord_1", (current) => {
    current.payment.state = "paid";
  });
  expect(updated.payment.state).toBe("paid");
  expect(await checked.listOrders({ paymentState: "paid" })).toHaveLength(1);
});

/* ------------------------------------------------------------ error handler */

test("an error handler can translate, observe, or replace", async () => {
  const seen: StorageErrorContext[] = [];
  const boom = new Error("connection reset");

  const translating = withStorageErrorHandler(
    { ...createMemoryStorage([mug]).storage, findOrder: async () => { throw boom; } },
    (error, context) => {
      seen.push(context);
      expect(error).toBe(boom);
      return new CommerceError("storage_error", "database unavailable", { cause: error });
    },
  );
  await expect(translating.findOrder("ord_1")).rejects.toMatchObject({
    code: "storage_error",
    message: "database unavailable",
  });
  expect(seen).toEqual([{ handler: "findOrder", orderId: "ord_1" }]);

  // Returning nothing observes only: the original error survives.
  const observing = withStorageErrorHandler(
    { ...createMemoryStorage([mug]).storage, loadSkus: async () => { throw boom; } },
    (_error, context) => void seen.push(context),
  );
  await expect(observing.loadSkus(["mug"])).rejects.toBe(boom);
  expect(seen[1]).toEqual({ handler: "loadSkus", skuIds: ["mug"] });

  // Throwing from the handler replaces the error outright.
  const replacing = withStorageErrorHandler(
    { ...createMemoryStorage([mug]).storage, listOrders: async () => { throw boom; } },
    () => {
      throw new Error("replaced");
    },
  );
  await expect(replacing.listOrders()).rejects.toThrow("replaced");
});

test("createCommerce routes handler errors through onStorageError", async () => {
  const { storage, saveSku } = createMemoryStorage();
  await saveSku(mug);
  const contexts: StorageErrorContext[] = [];

  const commerce = createCommerce({
    gateway: new FakePaymentGateway(),
    storage: {
      ...storage,
      createOrder: async () => {
        throw new Error("deadlock detected");
      },
    },
    onStorageError: (error, context) => {
      contexts.push(context);
      if (String((error as Error).message).includes("deadlock")) {
        return new CommerceError("version_conflict", "retry the checkout", context);
      }
    },
  });

  await expect(commerce.checkout({ items: [{ skuId: "mug" }] })).rejects.toMatchObject({
    code: "version_conflict",
    message: "retry the checkout",
  });
  expect(contexts[0]?.handler).toBe("createOrder");
  expect(contexts[0]?.orderId).toStartWith("ord_");
});

test("the whole lifecycle passes its own arguments through the checks", async () => {
  // Wrapping the storage the library talks to validates every argument it
  // sends, not just what the storage returns.
  const { storage, saveSku, skus } = createMemoryStorage();
  await saveSku(mug);
  const gateway = new FakePaymentGateway();
  const commerce = createCommerce({ gateway, storage: checkedStorage(storage) });

  const { order: created } = await commerce.checkout({
    items: [{ skuId: "mug", quantity: 2 }],
    customer: { email: "ada@example.com" },
    idempotencyKey: "cart-1",
  });
  gateway.setState(created.payment.id!, "paid");
  await commerce.handleWebhook(created.payment.id!);
  await commerce.markShipped({ orderId: created.id, carrier: "PostNL" });
  await commerce.markDelivered(created.id);
  await commerce.refund({ orderId: created.id, lines: [{ skuId: "mug", quantity: 1 }] });
  const returned = await commerce.markReturned({ orderId: created.id, restock: true });

  expect(returned.delivery.state).toBe("returned");
  expect(skus.get("mug")?.stock).toBe(10);
});
