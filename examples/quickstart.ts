/**
 * Runnable walkthrough of the whole lifecycle, against the fake gateway and an
 * in-memory database — no Mollie account, no database, no network.
 *
 *   bun run example
 *
 * Swap `FakePaymentGateway` for `createMollieGateway({ apiKey })` and
 * `InMemoryDatabase` for `SqliteDatabase` to make it real.
 */
import {
  createCommerce,
  FakePaymentGateway,
  formatMoney,
  InMemoryDatabase,
  money,
} from "../src/index.ts";

const gateway = new FakePaymentGateway();
const db = new InMemoryDatabase();

const commerce = createCommerce({
  gateway,
  db,
  redirectUrl: "https://shop.example/thanks",
  webhookUrl: "https://shop.example/mollie-webhook",
});

// 1. Catalog.
await db.products.save({
  id: "mug",
  name: "Enamel mug",
  kind: "physical",
  price: money(1250, "EUR"),
  stock: 10,
});
await db.products.save({
  id: "ebook",
  name: "The Mollie Handbook",
  kind: "digital",
  price: money(900, "EUR"),
});

// 2. Checkout. Send the customer to `checkoutUrl`.
const { order, checkoutUrl } = await commerce.checkout({
  items: [{ productId: "mug", quantity: 2 }, { productId: "ebook" }],
  customer: { email: "ada@example.com", locale: "nl_NL" },
  idempotencyKey: "cart-42",
});
console.log(`order ${order.id} · ${formatMoney(order.total)} · pay at ${checkoutUrl}`);
console.log(`mug stock after reservation: ${(await db.products.get("mug"))?.stock}`);

// Retrying the same cart returns the same order instead of charging twice.
const retry = await commerce.checkout({
  items: [{ productId: "mug", quantity: 2 }, { productId: "ebook" }],
  idempotencyKey: "cart-42",
});
console.log(`replayed=${retry.replayed} sameOrder=${retry.order.id === order.id}`);

// 3. The customer pays. Mollie would call your webhook; the fake needs a nudge.
gateway.setState(order.payment.id!, "paid");
const paid = await commerce.handleWebhook(order.payment.id!);
console.log(`webhook → payment ${paid!.payment.state}, delivery ${paid!.delivery.state}`);

// 4. Fulfil.
const shipped = await commerce.markShipped({
  orderId: order.id,
  carrier: "PostNL",
  trackingCode: "3S12345",
});
console.log(`shipped via ${shipped.delivery.carrier} (${shipped.delivery.trackingCode})`);
await commerce.markDelivered(order.id);

// 5. Refund one mug.
const { order: refunded, refund } = await commerce.refund({
  orderId: order.id,
  lines: [{ productId: "mug", quantity: 1 }],
  reason: "arrived chipped",
});
console.log(
  `refunded ${formatMoney(refund.amount)} → ${refunded.payment.state} ` +
    `(${formatMoney(refunded.payment.amountRefunded)} of ${formatMoney(refunded.total)})`,
);

// 6. Take the goods back, and the stock with them.
const returned = await commerce.markReturned({ orderId: order.id, restock: true });
console.log(`delivery ${returned.delivery.state}, mug stock ${(await db.products.get("mug"))?.stock}`);
console.log(`paid orders: ${(await commerce.findOrders({ paymentState: ["paid", "partially_refunded"] })).length}`);
