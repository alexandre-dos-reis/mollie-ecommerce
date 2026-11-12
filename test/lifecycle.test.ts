import { beforeEach, describe, expect, test } from "bun:test";
import { createCommerce, type Commerce } from "../src/commerce.ts";
import { CommerceError } from "../src/errors.ts";
import { FakePaymentGateway } from "../src/fake-gateway.ts";
import { fromMollieAmount, money, toMollieAmount } from "../src/money.ts";
import type { Sku } from "../src/types.ts";
import { createPglitePostgres } from "./pglite-pool.ts";
import { storageFromDatabase } from "./storage/from-database.ts";
import { InMemoryDatabase } from "./storage/memory.ts";
import type { Database } from "./storage/ports.ts";
import { SqliteDatabase } from "./storage/sqlite.ts";

const mug: Sku = {
  id: "mug",
  name: "Enamel mug",
  kind: "physical",
  price: money(1250, "EUR"),
  stock: 10,
};

const ebook: Sku = {
  id: "ebook",
  name: "The Mollie Handbook",
  kind: "digital",
  price: money(900, "EUR"),
};

test("money round-trips through Mollie's decimal strings", () => {
  expect(toMollieAmount(money(1250, "EUR"))).toEqual({ currency: "EUR", value: "12.50" });
  expect(toMollieAmount(money(5, "EUR"))).toEqual({ currency: "EUR", value: "0.05" });
  expect(toMollieAmount(money(1250, "JPY"))).toEqual({ currency: "JPY", value: "1250" });
  expect(fromMollieAmount({ currency: "EUR", value: "12.50" })).toEqual(money(1250, "EUR"));
  expect(fromMollieAmount({ currency: "JPY", value: "1250" })).toEqual(money(1250, "JPY"));
});

/**
 * The whole lifecycle, run against every storage adapter in this repo — all of
 * them driven through `storageFromDatabase`, so what is exercised is the same
 * handler contract consumers fulfil.
 */
// The Postgres adapter is exercised through PGlite, a WebAssembly Postgres
// used only in tests. Booting it takes ~1s, so it is shared and truncated.
const postgres = await createPglitePostgres();

const databases: Record<string, () => Database | Promise<Database>> = {
  memory: () => new InMemoryDatabase(),
  sqlite: () => new SqliteDatabase({ filename: ":memory:" }),
  postgres: async () => {
    await postgres.reset();
    return postgres.db;
  },
};

for (const [name, makeDb] of Object.entries(databases)) {
  describe(`commerce on ${name}`, () => {
    let gateway: FakePaymentGateway;
    let db: Database;
    let commerce: Commerce;

    beforeEach(async () => {
      gateway = new FakePaymentGateway();
      db = await makeDb();
      await db.skus.save(mug);
      await db.skus.save(ebook);
      commerce = createCommerce({
        gateway,
        storage: storageFromDatabase(db),
        redirectUrl: "https://shop.test/thanks",
        webhookUrl: "https://shop.test/webhook",
      });
    });

    test("checkout prices the cart and returns a checkout url", async () => {
      const { order, checkoutUrl, replayed } = await commerce.checkout({
        items: [{ skuId: "mug", quantity: 2 }, { skuId: "ebook" }],
      });

      expect(order.total).toEqual(money(3400, "EUR"));
      expect(order.lines).toHaveLength(2);
      expect(order.payment.state).toBe("open");
      expect(order.version).toBeGreaterThan(1);
      expect(checkoutUrl).toStartWith("https://pay.example.test/");
      expect(replayed).toBe(false);
      expect(order.delivery.state).toBe("not_started");
    });

    test("checkout merges duplicate cart lines", async () => {
      const { order } = await commerce.checkout({
        items: [{ skuId: "mug" }, { skuId: "mug", quantity: 2 }],
      });
      expect(order.lines).toHaveLength(1);
      expect(order.lines[0]!.quantity).toBe(3);
      expect(order.total).toEqual(money(3750, "EUR"));
    });

    test("variants of one product are independent", async () => {
      // Two SKUs of the same product: overselling one must not touch its
      // sibling, and the order line keeps the grouping key.
      await db.skus.save({
        id: "tshirt-red-m",
        name: "T-shirt — Red / M",
        kind: "physical",
        price: money(1999, "EUR"),
        stock: 5,
        productId: "tshirt",
      });
      await db.skus.save({
        id: "tshirt-blue-l",
        name: "T-shirt — Blue / L",
        kind: "physical",
        price: money(2199, "EUR"),
        stock: 1,
        productId: "tshirt",
      });

      const { order } = await commerce.checkout({
        items: [{ skuId: "tshirt-red-m", quantity: 2 }],
      });
      expect(order.total).toEqual(money(3998, "EUR"));
      expect(order.lines[0]!.skuId).toBe("tshirt-red-m");
      expect(order.lines[0]!.productId).toBe("tshirt");
      expect((await db.skus.get("tshirt-red-m"))?.stock).toBe(3);
      expect((await db.skus.get("tshirt-blue-l"))?.stock).toBe(1);

      await expect(
        commerce.checkout({ items: [{ skuId: "tshirt-blue-l", quantity: 2 }] }),
      ).rejects.toThrow(/sku tshirt-blue-l is out of stock/);
      expect((await db.skus.get("tshirt-red-m"))?.stock).toBe(3);
      expect((await db.skus.get("tshirt-blue-l"))?.stock).toBe(1);

      // The same cart can mix variants, each priced on its own.
      const mixed = await commerce.checkout({
        items: [{ skuId: "tshirt-red-m" }, { skuId: "tshirt-blue-l" }],
      });
      expect(mixed.order.total).toEqual(money(4198, "EUR"));
      expect((await db.skus.list({ productId: "tshirt" })).map((row: Sku) => row.id)).toEqual([
        "tshirt-blue-l",
        "tshirt-red-m",
      ]);
    });

    test("checkout rejects unknown skus, empty carts and mixed currencies", async () => {
      await expect(commerce.checkout({ items: [] })).rejects.toThrow(CommerceError);
      await expect(commerce.checkout({ items: [{ skuId: "nope" }] })).rejects.toThrow(
        /no sku nope/,
      );
      await db.skus.save({ ...ebook, id: "usd", price: money(900, "USD") });
      await expect(
        commerce.checkout({ items: [{ skuId: "mug" }, { skuId: "usd" }] }),
      ).rejects.toThrow(/one currency/);
    });

    test("checkout reserves stock, and releases it when the payment dies", async () => {
      const { order } = await commerce.checkout({ items: [{ skuId: "mug", quantity: 3 }] });
      expect((await db.skus.get("mug"))?.stock).toBe(7);
      expect(order.stockReserved).toBe(true);

      gateway.setState(order.payment.id!, "expired");
      const expired = await commerce.syncOrder(order.id);
      expect(expired.payment.state).toBe("expired");
      expect(expired.delivery.state).toBe("canceled");
      expect(expired.stockReserved).toBe(false);
      expect((await db.skus.get("mug"))?.stock).toBe(10);

      // Syncing again must not hand stock back twice.
      await commerce.syncOrder(order.id);
      expect((await db.skus.get("mug"))?.stock).toBe(10);
    });

    test("checkout refuses to oversell and leaves no partial reservation", async () => {
      await db.skus.save({ ...mug, stock: 2 });
      await expect(
        commerce.checkout({ items: [{ skuId: "ebook" }, { skuId: "mug", quantity: 3 }] }),
      ).rejects.toThrow(/out of stock/);
      expect((await db.skus.get("mug"))?.stock).toBe(2);
      expect(await db.orders.find()).toEqual([]);
    });

    test("checkout honors the active flag", async () => {
      await db.skus.save({ ...ebook, active: false });
      await expect(commerce.checkout({ items: [{ skuId: "ebook" }] })).rejects.toThrow(
        /inactive/,
      );
    });

    test("a repeated idempotency key replays the first order", async () => {
      const first = await commerce.checkout({
        items: [{ skuId: "mug" }],
        idempotencyKey: "key-1",
      });
      const second = await commerce.checkout({
        items: [{ skuId: "mug" }],
        idempotencyKey: "key-1",
      });

      expect(second.replayed).toBe(true);
      expect(second.order.id).toBe(first.order.id);
      expect(second.checkoutUrl).toBe(first.checkoutUrl!);
      expect(await db.orders.find()).toHaveLength(1);
      // Stock was taken once, not twice.
      expect((await db.skus.get("mug"))?.stock).toBe(9);
      expect(gateway.payments.size).toBe(1);
    });

    test("a gateway failure rolls the reservation back", async () => {
      gateway.failNextCreate(new Error("mollie is down"));
      await expect(commerce.checkout({ items: [{ skuId: "mug", quantity: 2 }] })).rejects.toThrow(
        /mollie is down/,
      );

      expect((await db.skus.get("mug"))?.stock).toBe(10);
      const [order] = await db.orders.find();
      expect(order?.payment.state).toBe("failed");
      expect(order?.delivery.state).toBe("canceled");
      expect(order?.stockReserved).toBe(false);
    });

    test("a paid physical order becomes ready, then ships", async () => {
      const { order } = await commerce.checkout({ items: [{ skuId: "mug" }] });
      gateway.setState(order.payment.id!, "paid");

      const paid = await commerce.handleWebhook(order.payment.id!);
      expect(paid?.payment.state).toBe("paid");
      expect(paid?.delivery.state).toBe("ready");
      // Paid orders keep their stock: it has left the warehouse, not come back.
      expect(paid?.stockReserved).toBe(true);
      expect((await db.skus.get("mug"))?.stock).toBe(9);

      const shipped = await commerce.markShipped({
        orderId: order.id,
        carrier: "PostNL",
        trackingCode: "3S12345",
      });
      expect(shipped.delivery.state).toBe("shipped");
      expect(shipped.delivery.trackingCode).toBe("3S12345");

      const delivered = await commerce.markDelivered(order.id);
      expect(delivered.delivery.state).toBe("delivered");
      expect(delivered.delivery.carrier).toBe("PostNL");
    });

    test("a paid digital-only order is delivered automatically", async () => {
      const { order } = await commerce.checkout({ items: [{ skuId: "ebook" }] });
      gateway.setState(order.payment.id!, "paid");
      const synced = await commerce.syncOrder(order.id);
      expect(synced.delivery.state).toBe("delivered");
    });

    test("invalid delivery transitions are refused", async () => {
      const { order } = await commerce.checkout({ items: [{ skuId: "mug" }] });
      await expect(commerce.markDelivered(order.id)).rejects.toThrow(
        /cannot move delivery from "not_started" to "delivered"/,
      );
    });

    test("a return can restock without moving money", async () => {
      const { order } = await commerce.checkout({ items: [{ skuId: "mug", quantity: 2 }] });
      gateway.setState(order.payment.id!, "paid");
      await commerce.syncOrder(order.id);
      await commerce.markShipped({ orderId: order.id });
      expect((await db.skus.get("mug"))?.stock).toBe(8);

      const returned = await commerce.markReturned({ orderId: order.id, restock: true });
      expect(returned.delivery.state).toBe("returned");
      expect(returned.payment.state).toBe("paid");
      expect((await db.skus.get("mug"))?.stock).toBe(10);
    });

    test("partial line refund then full refund", async () => {
      const { order } = await commerce.checkout({
        items: [{ skuId: "mug", quantity: 2 }, { skuId: "ebook" }],
      });
      gateway.setState(order.payment.id!, "paid");
      await commerce.syncOrder(order.id);

      const first = await commerce.refund({
        orderId: order.id,
        lines: [{ skuId: "mug", quantity: 1 }],
        reason: "damaged in transit",
      });
      expect(first.refund.amount).toEqual(money(1250, "EUR"));
      expect(first.order.payment.state).toBe("partially_refunded");
      expect(first.order.payment.amountRefunded).toEqual(money(1250, "EUR"));

      const second = await commerce.refund({ orderId: order.id });
      expect(second.refund.amount).toEqual(money(2150, "EUR"));
      expect(second.order.payment.state).toBe("refunded");
      expect(second.order.refunds).toHaveLength(2);
    });

    test("a refund reaches its final state through a sync", async () => {
      const { order } = await commerce.checkout({ items: [{ skuId: "mug" }] });
      gateway.setState(order.payment.id!, "paid");
      await commerce.syncOrder(order.id);

      const { refund } = await commerce.refund({ orderId: order.id, amount: money(500, "EUR") });
      expect(refund.state).toBe("pending");

      // The provider executes it hours later, and says so by calling the
      // webhook of the *payment* -- a refund has no webhook of its own.
      gateway.settleRefund(order.payment.id!, refund.id, "refunded");
      const synced = await commerce.syncOrder(order.id);

      expect(synced.refunds).toHaveLength(1);
      expect(synced.refunds[0]!.state).toBe("refunded");
      expect(synced.payment.amountRefunded).toEqual(money(500, "EUR"));
      expect(synced.payment.state).toBe("partially_refunded");
    });

    test("a sync while a refund is pending does not un-refund the order", async () => {
      const { order } = await commerce.checkout({ items: [{ skuId: "mug" }] });
      gateway.setState(order.payment.id!, "paid");
      await commerce.syncOrder(order.id);
      await commerce.refund({ orderId: order.id });

      // The provider still reports `amountRefunded: 0` -- the refund is
      // accepted, not executed. The order must not fall back to `paid`.
      const synced = await commerce.syncOrder(order.id);
      expect(synced.payment.state).toBe("refunded");
      expect(synced.payment.amountRefunded).toEqual(money(1250, "EUR"));
      expect(synced.refunds[0]!.state).toBe("pending");
    });

    test("a failed refund gives the money back to the order", async () => {
      const { order } = await commerce.checkout({ items: [{ skuId: "mug" }] });
      gateway.setState(order.payment.id!, "paid");
      await commerce.syncOrder(order.id);

      const { refund } = await commerce.refund({ orderId: order.id, amount: money(500, "EUR") });
      gateway.settleRefund(order.payment.id!, refund.id, "failed");
      const synced = await commerce.syncOrder(order.id);

      expect(synced.refunds[0]!.state).toBe("failed");
      expect(synced.payment.amountRefunded).toEqual(money(0, "EUR"));
      expect(synced.payment.state).toBe("paid");
    });

    test("a refund created outside the library shows up on the order", async () => {
      const { order } = await commerce.checkout({ items: [{ skuId: "mug" }] });
      gateway.setState(order.payment.id!, "paid");
      await commerce.syncOrder(order.id);

      // One refund of ours, so the order has something to settle, and one
      // made straight at the provider -- from its dashboard, typically.
      await commerce.refund({ orderId: order.id, amount: money(200, "EUR") });
      await gateway.createRefund({ paymentId: order.payment.id!, amount: money(300, "EUR") });

      const synced = await commerce.syncOrder(order.id);
      expect(synced.refunds).toHaveLength(2);
      expect(synced.payment.amountRefunded).toEqual(money(500, "EUR"));
      expect(synced.payment.state).toBe("partially_refunded");
    });

    test("refunds are bounded by what is left", async () => {
      const { order } = await commerce.checkout({ items: [{ skuId: "mug" }] });
      await expect(commerce.refund({ orderId: order.id })).rejects.toThrow(/not paid/);

      gateway.setState(order.payment.id!, "paid");
      await commerce.syncOrder(order.id);
      await expect(
        commerce.refund({ orderId: order.id, amount: money(2000, "EUR") }),
      ).rejects.toThrow(/at most/);
      await expect(
        commerce.refund({ orderId: order.id, lines: [{ skuId: "mug", quantity: 5 }] }),
      ).rejects.toThrow(/cannot refund 5/);
    });

    test("cancelling an unpaid order cancels the payment and frees stock", async () => {
      const { order } = await commerce.checkout({ items: [{ skuId: "mug" }] });
      const canceled = await commerce.cancelOrder(order.id);
      expect(canceled.payment.state).toBe("canceled");
      expect(canceled.delivery.state).toBe("canceled");
      expect((await db.skus.get("mug"))?.stock).toBe(10);

      const paid = (await commerce.checkout({ items: [{ skuId: "mug" }] })).order;
      gateway.setState(paid.payment.id!, "paid");
      await commerce.syncOrder(paid.id);
      await expect(commerce.cancelOrder(paid.id)).rejects.toThrow(/refund it instead/);
    });

    test("a stale write loses to the one that got there first", async () => {
      const { order } = await commerce.checkout({ items: [{ skuId: "mug" }] });
      const stale = await db.orders.get(order.id);
      await commerce.cancelOrder(order.id);

      await expect(db.orders.update(stale!)).rejects.toMatchObject({ code: "version_conflict" });
    });

    test("orders are queryable by state", async () => {
      const paid = (await commerce.checkout({ items: [{ skuId: "mug" }] })).order;
      await commerce.checkout({ items: [{ skuId: "mug" }] });
      gateway.setState(paid.payment.id!, "paid");
      await commerce.syncOrder(paid.id);

      expect((await commerce.findOrders({ paymentState: "paid" })).map((o) => o.id)).toEqual([
        paid.id,
      ]);
      expect(await commerce.findOrders({ deliveryState: "ready" })).toHaveLength(1);
      expect(await commerce.findOrders()).toHaveLength(2);
    });

    test("webhooks for unknown payments are ignored", async () => {
      expect(await commerce.handleWebhook("tr_unknown")).toBeNull();
    });
  });
}
