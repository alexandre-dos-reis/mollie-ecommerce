import { beforeEach, expect, test } from "bun:test";
import { createCommerce, type Commerce } from "../src/commerce.ts";
import { describeCommerceStorage } from "../src/conformance.ts";
import { FakePaymentGateway } from "../src/fake-gateway.ts";
import { money } from "../src/money.ts";
import type { Sku } from "../src/types.ts";
import { createMemoryStorage } from "../examples/memory-storage.ts";
import { storageFromDatabase } from "./storage/from-database.ts";
import { InMemoryDatabase } from "./storage/memory.ts";

/**
 * Proves the commerce layer needs nothing but the seven handlers: the storage
 * here is `examples/memory-storage.ts`, two maps with no adapter, no stores
 * and no transactions. Testing the published example also keeps it honest.
 */

/* The handler contract, for both ways of fulfilling it. */
describeCommerceStorage("memory-example", () => createMemoryStorage());
describeCommerceStorage("from-database", () => {
  const db = new InMemoryDatabase();
  return { storage: storageFromDatabase(db), saveSku: (sku) => db.skus.save(sku) };
});

/* And the whole lifecycle, driven through handlers only. */
let commerce: Commerce;
let gateway: FakePaymentGateway;
let skus: Map<string, Sku>;

beforeEach(() => {
  const memory = createMemoryStorage();
  skus = memory.skus;
  gateway = new FakePaymentGateway();
  commerce = createCommerce({ gateway, storage: memory.storage });

  skus.set("mug", {
    id: "mug",
    name: "Enamel mug",
    kind: "physical",
    price: money(1250, "EUR"),
    stock: 10,
  });
  skus.set("handbook", {
    id: "handbook",
    name: "The Handbook",
    kind: "digital",
    price: money(900, "EUR"),
  });
});

test("the full lifecycle runs on handlers alone", async () => {
  const { order, checkoutUrl } = await commerce.checkout({
    items: [{ skuId: "mug", quantity: 2 }, { skuId: "handbook" }],
    customer: { email: "ada@example.com" },
    idempotencyKey: "cart-1",
  });
  expect(order.total).toEqual(money(3400, "EUR"));
  expect(checkoutUrl).toStartWith("https://pay.example.test/");
  expect(skus.get("mug")?.stock).toBe(8);

  const replay = await commerce.checkout({
    items: [{ skuId: "mug", quantity: 2 }, { skuId: "handbook" }],
    idempotencyKey: "cart-1",
  });
  expect(replay.replayed).toBe(true);
  expect(skus.get("mug")?.stock).toBe(8);

  gateway.setState(order.payment.id!, "paid");
  const paid = await commerce.handleWebhook(order.payment.id!);
  expect(paid?.payment.state).toBe("paid");
  expect(paid?.delivery.state).toBe("ready");

  await commerce.markShipped({ orderId: order.id, carrier: "PostNL", trackingCode: "3S1" });
  await commerce.markDelivered(order.id);

  const { order: refunded } = await commerce.refund({
    orderId: order.id,
    lines: [{ skuId: "mug", quantity: 1 }],
  });
  expect(refunded.payment.state).toBe("partially_refunded");

  const returned = await commerce.markReturned({ orderId: order.id, restock: true });
  expect(returned.delivery.state).toBe("returned");
  expect(skus.get("mug")?.stock).toBe(10);
});

test("out of stock comes back from the handler, not a thrown store error", async () => {
  await expect(commerce.checkout({ items: [{ skuId: "mug", quantity: 99 }] })).rejects.toMatchObject(
    { code: "out_of_stock" },
  );
  expect(skus.get("mug")?.stock).toBe(10);
  expect(await commerce.findOrders()).toEqual([]);
});

test("a dead payment releases stock through the mutation handler", async () => {
  const { order } = await commerce.checkout({ items: [{ skuId: "mug", quantity: 3 }] });
  expect(skus.get("mug")?.stock).toBe(7);

  gateway.setState(order.payment.id!, "expired");
  const expired = await commerce.syncOrder(order.id);
  expect(expired.delivery.state).toBe("canceled");
  expect(expired.stockReserved).toBe(false);
  expect(skus.get("mug")?.stock).toBe(10);

  // Idempotent: a second sync must not hand stock back twice.
  await commerce.syncOrder(order.id);
  expect(skus.get("mug")?.stock).toBe(10);
});

test("storage is required", () => {
  // @ts-expect-error — `storage` has no default: persistence is never implicit.
  expect(() => createCommerce({ gateway })).toBeDefined();
});
