/**
 * Runnable walkthrough of the whole lifecycle, against the fake gateway and an
 * in-memory database — no Mollie account, no database, no network.
 *
 *   bun run example
 *
 * Swap `FakePaymentGateway` for `createMollieGateway({ apiKey })` and
 * `InMemoryDatabase` for `SqliteDatabase` or the Postgres stores to make it
 * real.
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

// 1. Catalog. One SKU per purchasable variant: the T-shirt comes in two, and
//    `productId` groups them so you can still ask "which T-shirt SKUs exist?".
//    Size and colour are your catalog's vocabulary — the library never sees them.
await db.skus.save({
  id: "tshirt-red-m",
  name: "T-shirt — Red / M",
  kind: "physical",
  price: money(1999, "EUR"),
  stock: 10,
  productId: "tshirt",
});
await db.skus.save({
  id: "tshirt-blue-l",
  name: "T-shirt — Blue / L",
  kind: "physical",
  price: money(2199, "EUR"), // a bigger size can cost more
  stock: 2,
  productId: "tshirt",
});
await db.skus.save({
  id: "handbook",
  name: "The Mollie Handbook (ebook)",
  kind: "digital",
  price: money(900, "EUR"),
});

const variants = await db.skus.list({ productId: "tshirt" });
console.log(`tshirt variants: ${variants.map((sku) => sku.id).join(", ")}`);

// 2. Checkout. Send the customer to `checkoutUrl`.
const { order, checkoutUrl } = await commerce.checkout({
  items: [{ skuId: "tshirt-red-m", quantity: 2 }, { skuId: "handbook" }],
  customer: { email: "ada@example.com", locale: "nl_NL" },
  idempotencyKey: "cart-42",
});
console.log(`order ${order.id} · ${formatMoney(order.total)} · pay at ${checkoutUrl}`);
console.log(`red/M stock after reservation: ${(await db.skus.get("tshirt-red-m"))?.stock}`);

// Retrying the same cart returns the same order instead of charging twice.
const retry = await commerce.checkout({
  items: [{ skuId: "tshirt-red-m", quantity: 2 }, { skuId: "handbook" }],
  idempotencyKey: "cart-42",
});
console.log(`replayed=${retry.replayed} sameOrder=${retry.order.id === order.id}`);

// Overselling one variant never touches its siblings.
try {
  await commerce.checkout({ items: [{ skuId: "tshirt-blue-l", quantity: 3 }] });
} catch (error) {
  console.log(`blue/L refused: ${(error as Error).message}`);
  console.log(`blue/L stock untouched: ${(await db.skus.get("tshirt-blue-l"))?.stock}`);
}

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

// 5. Refund one of the two shirts.
const { order: refunded, refund } = await commerce.refund({
  orderId: order.id,
  lines: [{ skuId: "tshirt-red-m", quantity: 1 }],
  reason: "arrived with a mark",
});
console.log(
  `refunded ${formatMoney(refund.amount)} → ${refunded.payment.state} ` +
    `(${formatMoney(refunded.payment.amountRefunded)} of ${formatMoney(refunded.total)})`,
);

// 6. Take the goods back, and the stock with them.
const returned = await commerce.markReturned({ orderId: order.id, restock: true });
console.log(
  `delivery ${returned.delivery.state}, red/M stock ${(await db.skus.get("tshirt-red-m"))?.stock}`,
);
console.log(
  `paid orders: ${(await commerce.findOrders({ paymentState: ["paid", "partially_refunded"] })).length}`,
);
