import { beforeEach, expect, test } from "bun:test";
import { createMemoryStorage, type MemoryStorage } from "../examples/memory-storage.ts";
import { createCommerce, type Commerce } from "../src/commerce.ts";
import { CommerceError, storageError } from "../src/errors.ts";
import { FakePaymentGateway } from "../src/fake-gateway.ts";
import { money } from "../src/money.ts";
import { checkedStorage } from "../src/storage-guards.ts";
import type { CommerceStorage } from "../src/storage-handlers.ts";
import type { Order, Sku } from "../src/types.ts";

const mug: Sku = {
  id: "mug",
  name: "Enamel mug",
  kind: "physical",
  price: money(1250, "EUR"),
  stock: 10,
};

let memory: MemoryStorage;
let gateway: FakePaymentGateway;

beforeEach(async () => {
  memory = createMemoryStorage();
  gateway = new FakePaymentGateway();
  await memory.saveSku(mug);
});

/** Commerce over storage with one handler replaced by a throwing one. */
function commerceWith(overrides: Partial<CommerceStorage>): Commerce {
  return createCommerce({
    gateway,
    storage: checkedStorage({ ...memory.storage, ...overrides }),
  });
}

/* ---------------------------------------------------------- throwing works */

test("createOrder may throw outOfStock instead of returning it", async () => {
  const commerce = commerceWith({
    async createOrder() {
      // How a transaction normally refuses: abort by throwing.
      throw storageError.outOfStock([{ skuId: "mug", requested: 2, available: 1 }]);
    },
  });

  const failure = commerce.checkout({ items: [{ skuId: "mug", quantity: 2 }] });
  await expect(failure).rejects.toMatchObject({ code: "out_of_stock" });
  await expect(failure).rejects.toThrow(/sku mug is out of stock/);
  expect(await commerce.findOrders()).toEqual([]);
});

test("a thrown CommerceError reaches the caller with its code intact", async () => {
  const commerce = commerceWith({
    async mutateOrder(orderId) {
      throw storageError.versionConflict(orderId, 3, 4);
    },
  });

  await expect(commerce.checkout({ items: [{ skuId: "mug" }] })).rejects.toMatchObject({
    code: "version_conflict",
    details: { expected: 3, actual: 4 },
  });
});

test("mutateOrder throwing orderNotFound surfaces as order_not_found", async () => {
  const commerce = commerceWith({
    async mutateOrder(orderId) {
      throw storageError.orderNotFound(orderId);
    },
  });
  await expect(commerce.checkout({ items: [{ skuId: "mug" }] })).rejects.toMatchObject({
    code: "order_not_found",
  });
});

test("an error that is not a CommerceError propagates untouched", async () => {
  const boom = new TypeError("column \"stock\" does not exist");
  const commerce = commerceWith({
    async loadSkus() {
      throw boom;
    },
  });
  await expect(commerce.checkout({ items: [{ skuId: "mug" }] })).rejects.toBe(boom);
});

test("checkedStorage holds a thrown outOfStock to the same shape", async () => {
  const storage = checkedStorage({
    ...memory.storage,
    async createOrder() {
      throw new CommerceError("out_of_stock", "nope", { shortages: [{ skuId: "mug" }] });
    },
  });

  // `shortages` is part of the contract even when thrown, so a malformed one
  // is a contract violation rather than a plausible out_of_stock.
  await expect(
    storage.createOrder({ order: emptyOrder(), reserveStock: [] }),
  ).rejects.toMatchObject({ code: "storage_contract" });
});

function emptyOrder(): Order {
  return {
    id: "ord_x",
    version: 0,
    lines: [],
    total: money(0, "EUR"),
    payment: { state: "created", amountRefunded: money(0, "EUR") },
    stockReserved: false,
    delivery: { state: "not_started" },
    refunds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/* -------------------------------------------------- the helpers themselves */

test("storageError builds the codes handlers are expected to raise", () => {
  const shortages = [{ skuId: "mug", requested: 4, available: 1 }];
  expect(storageError.outOfStock(shortages)).toMatchObject({
    code: "out_of_stock",
    details: { shortages },
  });
  expect(storageError.outOfStock([]).message).toBe("out of stock");

  expect(storageError.orderNotFound("ord_1")).toMatchObject({
    code: "order_not_found",
    details: { orderId: "ord_1" },
  });

  expect(storageError.versionConflict("ord_1").message).toBe(
    "order ord_1 was modified concurrently",
  );
  expect(storageError.versionConflict("ord_1", 2).message).toMatch(/expected version 2\)/);
  expect(storageError.versionConflict("ord_1", 2, 3).message).toMatch(
    /expected version 2, found 3\)/,
  );

  // The driver error survives on `cause`, where loggers look for it.
  const driver = new Error("duplicate key value violates unique constraint");
  expect(storageError.duplicateOrder("ord_1", driver)).toMatchObject({
    code: "duplicate_order",
    cause: driver,
  });
  expect(storageError.failed("connection reset", driver)).toMatchObject({
    code: "storage_error",
    message: "connection reset",
    cause: driver,
  });
});

/* ------------------------------------------- a failed rollback is not lost */

test("a gateway failure plus a failed compensation keeps both", async () => {
  // The order exists and holds stock; the payment fails; releasing the stock
  // fails too. The caller must still learn why the payment failed.
  const storageFailure = new Error("connection reset");
  let calls = 0;

  const commerce = createCommerce({
    gateway,
    storage: {
      ...memory.storage,
      async mutateOrder() {
        calls++;
        throw storageFailure;
      },
    },
  });

  gateway.failNextCreate(new CommerceError("gateway_error", "mollie is down"));

  const failure = commerce.checkout({ items: [{ skuId: "mug", quantity: 2 }] });
  await expect(failure).rejects.toMatchObject({ code: "storage_error" });
  await expect(failure).rejects.toThrow(/releasing its stock failed too/);

  const error = await failure.catch((thrown: CommerceError) => thrown);
  const raised = error as CommerceError;
  // The gateway error is the cause, and both are kept in details.
  expect((raised.cause as CommerceError).message).toBe("mollie is down");
  expect(raised.details?.storageError).toBe(storageFailure);
  expect(calls).toBe(1);

  // The reservation really is still held, as the message says.
  expect(memory.skus.get("mug")?.stock).toBe(8);
});

test("a gateway failure alone still releases the stock and reports the gateway", async () => {
  const commerce = createCommerce({ gateway, storage: checkedStorage(memory.storage) });
  gateway.failNextCreate(new CommerceError("gateway_error", "mollie is down"));

  await expect(
    commerce.checkout({ items: [{ skuId: "mug", quantity: 2 }] }),
  ).rejects.toMatchObject({ code: "gateway_error" });
  expect(memory.skus.get("mug")?.stock).toBe(10);
});
