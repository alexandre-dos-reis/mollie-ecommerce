# mollie-ecommerce

[![CI](https://github.com/alexandre-dos-reis/mollie-ecommerce/actions/workflows/ci.yml/badge.svg)](https://github.com/alexandre-dos-reis/mollie-ecommerce/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Mollie has payments and refunds but no catalog. This library adds the minimum
an ecommerce flow needs on top: SKUs, orders, and a delivery lifecycle —
nothing else.

It is a library, not a framework: no HTTP layer, no ORM, no database adapters.
It calls seven storage handlers you fulfil, and leaves persistence entirely to
you. Call the methods from whatever you already run.

## Install

```bash
bun add mollie-ecommerce
```

Ships as ESM with type declarations, so Node 20+, Bun, Deno and bundlers all
work. Two runtime dependencies: the Mollie SDK and [zod](https://zod.dev).

Two more entry points, both optional: `mollie-ecommerce/http` for the Mollie
webhook handler, and `mollie-ecommerce/conformance` for the contract test suite
for your storage. The conformance entry builds on `bun:test`, so it needs
[Bun](https://bun.com); the main and `http` entries do not.

```bash
# Working on the library itself
bun install
bun run check     # typecheck + 172 tests
bun run build     # bundle dist/ with tsdown
bun run example   # the full lifecycle, no Mollie account needed
```

## Scope

In scope: pricing a cart, creating and reconciling payments, refunds, stock
reservation, and delivery state.

Out of scope, by design: catalog structure (products, options, variant
matrices, images, descriptions, categories, VAT breakdowns, translations)
belongs in your own tables, linked by `Sku.productId`; persistence is yours to
fulfil, so no database adapters, migrations or ORMs ship; HTTP routing and
webhook transport belong in your application; and Mollie features unrelated to
this lifecycle — subscriptions, payment links, settlements, Connect — are
better reached through the Mollie SDK directly.

## Model

Deliberately small. Two entities, and a hard boundary: your catalog keeps
products, options, images, descriptions and translations — this library keeps
what it needs to take money and ship goods.

```ts
type Sku = {
  id: string;        // "tshirt-red-m" — order lines keep a copy forever
  name: string;      // "T-shirt — Red / M", shown to the customer
  kind: "physical" | "digital" | "service";
  price: Money;      // every SKU in one order shares a currency
  stock?: number;    // undefined = unlimited, not tracked
  active?: boolean;  // false hides it from checkout; defaults true
  productId?: string; // optional grouping key, indexed, never interpreted
};

type Order = {
  id: string;
  version: number;             // optimistic-lock counter
  idempotencyKey?: string;
  lines: OrderLine[];          // frozen copies of the SKUs at purchase time
  total: Money;
  customer?: { email?: string; locale?: string };
  payment: {
    state: PaymentState;
    id?: string;               // Mollie payment id
    checkoutUrl?: string;      // send the customer here
    amountRefunded: Money;
  };
  stockReserved: boolean;
  delivery: { state: DeliveryState; carrier?: string; trackingCode?: string };
  refunds: Refund[];
  createdAt: string;
  updatedAt: string;
};
```

`Money` is integer minor units plus a currency (`money(1250, "EUR")`), never a
float. Mollie's `"12.50"` strings are converted at the API boundary only.

### Why SKUs, and where variants go

A product has no single price or stock count — a *purchasable combination*
does. "T-shirt" can't be reserved; "T-shirt / Red / M" can. So the sellable
unit here is the SKU, and **variants need no modeling at all**: register one
SKU per combination.

```ts
await db.skus.save({ id: "tshirt-red-m",  name: "T-shirt — Red / M", kind: "physical",
                     price: money(1999, "EUR"), stock: 10, productId: "tshirt" });
await db.skus.save({ id: "tshirt-blue-l", name: "T-shirt — Blue / L", kind: "physical",
                     price: money(2199, "EUR"), stock: 2,  productId: "tshirt" });

await db.skus.list({ productId: "tshirt" }); // both variants
```

Size and colour are your catalog's vocabulary; the library only ever sees
`tshirt-red-m, €19.99, 10 left`. Variants price and stock independently —
selling out Blue/L leaves Red/M alone. `kind` is per SKU too, so the same book
can ship as a hardback and download as an ebook. A product without variants is
simply one SKU.

Payment state mirrors Mollie — `created`, `open`, `pending`, `authorized`,
`paid`, `canceled`, `expired`, `failed` — plus `partially_refunded` and
`refunded`, derived from `amountRefunded`. Delivery is a separate state
machine, so money and fulfillment never get conflated:

```
not_started ──► ready ──► shipped ──► delivered ──► returned
     │            │          └──► returned
     └────────────┴──► canceled
```

Anything outside that graph throws `invalid_delivery_transition`.

## Setup

```ts
import { createCommerce, createMollieGateway } from "mollie-ecommerce";
import { myStorage } from "./storage.ts"; // your seven handlers — see Persistence

const commerce = createCommerce({
  gateway: createMollieGateway({ apiKey: process.env.MOLLIE_API_KEY }),
  storage: myStorage,
  redirectUrl: "https://shop.example/thanks",
  webhookUrl: "https://shop.example/mollie-webhook",
});
```

SKUs are written by your catalog, not by this library — it only reads them:

```ts
await myCatalog.saveSku({
  id: "mug", name: "Enamel mug", kind: "physical", price: money(1250, "EUR"), stock: 10,
});
```

### `createCommerce(options)`

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `gateway` | yes | — | Payment provider. `createMollieGateway({ apiKey })`, or `new FakePaymentGateway()` in tests. |
| `storage` | yes | — | The seven storage handlers you fulfil. See [Persistence](#persistence). |
| `onStorageError` | no | — | Called when a handler throws, to log or translate it. See [Handling errors from your storage](#handling-errors-from-your-storage). |
| `redirectUrl` | no | — | Where Mollie returns the customer after paying. Mollie requires it for most methods. |
| `cancelUrl` | no | — | Where Mollie returns a customer who abandons the payment. |
| `webhookUrl` | no | — | Public URL Mollie posts status changes to. Without it you must poll `syncOrder`. Cannot be `localhost`. |
| `autoDeliverDigital` | no | `true` | Jump an order with no physical lines straight to `delivered` when paid. |
| `reserveStock` | no | `true` | Decrement SKU stock at checkout, give it back if the payment dies. |
| `clock` | no | system | Override `now()`, e.g. to freeze timestamps in tests. |
| `generateId` | no | random | Override id generation; receives a prefix such as `"ord"`. |

## The commerce API

Every property of the returned object, and every argument. All methods are
`async` and throw `CommerceError` with a machine-readable `code`.

### `checkout(input) → { order, checkoutUrl, replayed }`

Prices the cart from the catalog, reserves stock, and creates a Mollie
payment. Send the customer to `checkoutUrl`.

| Argument | Meaning |
| --- | --- |
| `input.items` | `[{ skuId, quantity? }]`, at least one. Quantity defaults to 1; repeated SKUs are merged into one line. |
| `input.customer` | `{ email?, locale? }`. `locale` (e.g. `nl_NL`) localizes Mollie's payment screen. |
| `input.description` | Payment description on the customer's statement. Defaults to a generated summary; Mollie truncates per method. |
| `input.redirectUrl` / `input.cancelUrl` / `input.webhookUrl` | Override the configured URLs for this order. |
| `input.idempotencyKey` | Replaying the same key returns the first order (`replayed: true`) instead of charging twice. Also sent to Mollie. |

Throws `empty_cart`, `sku_not_found`, `sku_inactive`, `out_of_stock` (nothing
is reserved), `currency_mismatch`.

### `syncOrder(orderId) → Order`

Re-reads the payment from Mollie and folds it into the order: payment state,
refunded amount, and the delivery and stock consequences. Idempotent. Use it
when you cannot receive webhooks, when the customer hits your redirect URL, or
to reconcile on a schedule. Returns the order unchanged if no payment exists
yet. Throws `order_not_found`, `gateway_error`.

### `handleWebhook(paymentId) → Order | null`

For Mollie's webhook, which posts only `id=tr_...` and no status. Looks the
order up by payment id, then does the same work as `syncOrder`. Returns `null`
for a payment this shop doesn't know — respond 2xx anyway, or Mollie retries
forever. The state always comes from the API, never from the request body.

This is the commerce operation; `createWebhookHandler` from
`mollie-ecommerce/http` turns it into an HTTP handler with the status codes and
the duplicate-delivery retry already handled. See
[the webhook](#2-the-mollie-webhook).

### `refund(input) → { order, refund }`

Refunds a paid order: in full, by amount, or by line. Moves money only — see
`markReturned` for stock.

| Argument | Meaning |
| --- | --- |
| `input.orderId` | Order to refund. |
| `input.amount` | Exact `Money` to refund. Mutually exclusive with `lines`. |
| `input.lines` | `[{ skuId, quantity? }]`; quantity defaults to the whole line. |
| `input.reason` | Forwarded to Mollie as the refund description, and stored on the order. |
| `input.idempotencyKey` | Prevents a retried call from refunding twice. |

Omit `amount` and `lines` to refund everything still refundable. Throws
`order_not_found`, `not_refundable` (unpaid, or non-positive amount),
`refund_too_large`, `currency_mismatch`. Mollie reports refunds as `pending`;
`syncOrder` reconciles the final state.

### `markReady(orderId) → Order`

Marks the order ready to fulfil. Paying already does this, so you only need it
when the payment flow is bypassed. Throws `invalid_delivery_transition`.

### `markShipped(input) → Order`

| Argument | Meaning |
| --- | --- |
| `input.orderId` | Order being shipped. |
| `input.carrier` | Carrier name, e.g. `"PostNL"`. Keeps the existing value if omitted. |
| `input.trackingCode` | Tracking code. Keeps the existing value if omitted. |

Throws `invalid_delivery_transition` unless the order is `ready`.

### `markDelivered(orderId) → Order`

Marks the order delivered. Digital-only orders get here automatically when
paid, unless `autoDeliverDigital` is off. Throws
`invalid_delivery_transition` unless the order is `ready` or `shipped`.

### `markReturned(input) → Order`

| Argument | Meaning |
| --- | --- |
| `input.orderId` | Returned order. |
| `input.restock` | `true` puts the goods back into stock. |

Records the return and moves no money — call `refund` for that. Throws
`invalid_delivery_transition` unless the order was shipped or delivered.

### `cancelOrder(orderId) → Order`

Cancels an unpaid order: cancels the Mollie payment when it is still
cancelable, releases the stock reservation, cancels the delivery. Throws
`order_not_found`, or `not_payable` if the order is already paid — refund it
instead.

### `getOrder(orderId) → Order | null`

Reads one order with its lines, refunds, and both state machines.

### `findOrders(query?) → Order[]`

Lists orders, oldest-created first.

| Filter | Meaning |
| --- | --- |
| `paymentState` | One state or an array. |
| `deliveryState` | One state or an array. |
| `customerEmail` | Exact match. |
| `createdAfter` / `createdBefore` | ISO timestamps; inclusive lower, exclusive upper. |
| `limit` / `offset` | Paging. |

### `storage`

The handlers you passed in, exposed for wrapping and testing. Catalog writes do
not go through here — write SKUs with whatever owns your catalog.

## A real-world shop

The five places a real shop touches this library: one module wiring it up, then
the checkout request, the webhook, the customer's return from Mollie, the
warehouse action, and a reconciliation job. Request handlers are written with
plain `Request`/`Response` so they drop into Bun.serve, Hono, Elysia, Next, or
anything else.

```ts
// shop.ts — wire it up once, import it everywhere.
import { createCommerce, createMollieGateway } from "mollie-ecommerce";
import { log } from "./log.ts";
import { storage } from "./storage.ts"; // your seven handlers

export const commerce = createCommerce({
  gateway: createMollieGateway({ apiKey: process.env.MOLLIE_API_KEY! }),
  storage,
  redirectUrl: "https://shop.example/order/complete",
  cancelUrl: "https://shop.example/cart",
  webhookUrl: "https://shop.example/webhooks/mollie",

  // One place to see anything your storage throws.
  onStorageError: (error, { handler, orderId }) => {
    log.error({ err: error, handler, orderId }, "storage failed");
  },
});
```

### 1. The checkout request

The cart id doubles as the idempotency key, so a double-clicked Pay button or a
retried request returns the same order instead of charging twice. Error codes
map onto status codes — never leak `error.details` to the customer, it carries
internal ids.

```ts
import { CommerceError } from "mollie-ecommerce";
import { commerce } from "./shop.ts";

const STATUS: Record<string, number> = {
  sku_not_found: 404,
  sku_inactive: 409,
  out_of_stock: 409,
  currency_mismatch: 422,
  empty_cart: 400,
};

export async function postCheckout(request: Request): Promise<Response> {
  const cart = await request.json(); // { id, items: [{ skuId, quantity }], email, locale }

  try {
    const { order, checkoutUrl } = await commerce.checkout({
      items: cart.items,
      customer: { email: cart.email, locale: cart.locale },
      idempotencyKey: cart.id,
    });

    // 303 so the browser follows with GET.
    return Response.json({ orderId: order.id, checkoutUrl }, { status: 303 });
  } catch (error) {
    if (error instanceof CommerceError) {
      console.warn("checkout refused", error.code, error.details);
      return Response.json(
        { error: error.code, message: customerMessage(error) },
        { status: STATUS[error.code] ?? 500 },
      );
    }
    throw error;
  }
}

function customerMessage(error: CommerceError): string {
  switch (error.code) {
    case "out_of_stock":
      return "Sorry — one of those just sold out.";
    case "sku_inactive":
    case "sku_not_found":
      return "That item is no longer available.";
    default:
      return "We could not start your payment. Please try again.";
  }
}
```

### 2. The Mollie webhook

Mollie posts `id=tr_...` form-encoded and nothing else — no status, so the
state has to come from the API, which is exactly what `handleWebhook` does.
`mollie-ecommerce/http` wraps it in a `Request → Response` handler that carries
the parts every integration has to get right the same way:

```ts
import { createWebhookHandler } from "mollie-ecommerce/http";
import { commerce } from "./shop.ts";
import { queue } from "./queue.ts";

export const postMollieWebhook = createWebhookHandler({
  commerce,
  // Enqueue only — Mollie is waiting. Emails, invoices and ERP calls happen
  // after the response, in your worker.
  onOrder: (order) => {
    if (order.payment.state === "paid") {
      queue.push({ type: "order.paid", orderId: order.id });
    }
  },
  onError: (error, { paymentId, status }) =>
    log.error({ err: error, paymentId, willRetry: status >= 500 }, "mollie webhook"),
});
```

It is a plain `(Request) => Promise<Response>`, so routing stays yours:

```ts
Bun.serve({ routes: { "/mollie-webhook": { POST: postMollieWebhook } } });
app.post("/mollie-webhook", (c) => postMollieWebhook(c.req.raw));   // Hono
export { postMollieWebhook as POST };                              // Next.js route file
```

For a `req`/`res` framework like Express, skip the handler and call
`commerce.handleWebhook(paymentId)` directly — it stays the operation, and the
handler is only a convenience over it.

**What the handler decides for you.** To Mollie, 2xx means "absorbed, stop" and
anything else means "retry", so the status is not a formality — it is how a
payment either converges or gets silently dropped:

| Situation | Answer | Why |
| --- | --- | --- |
| no `id` in the body | 200 | not Mollie, or a probe; retrying conjures nothing |
| payment unknown here | 200 | a non-2xx retries forever for an order that will never exist |
| `order_not_found` | 200 | the order vanished mid-flight; no state left to converge on |
| `gateway_error`, `storage_error` | 503 | transient — the redelivery *is* the recovery |
| `version_conflict` | retried, then 503 | a duplicate delivery won the write race |
| `storage_contract`, anything else | 500 | a bug; Mollie's remaining retries recover it once fixed |

That last distinction is the one worth internalising even if you route the
webhook yourself: answering 2xx to a database blip tells Mollie the payment was
handled and you will never hear about it again.

Two more Mollie facts the handler folds in. **There is nothing to verify** —
Mollie does not sign webhooks, which is why the state is re-read from the API
instead; a forged body cannot move an order. And **refunds and chargebacks
arrive on this same route**, carrying the same payment id, so one route is all
you need.

Mollie cannot reach `localhost`, so tunnel the URL in development
(`bunx untun tunnel http://localhost:3000`, ngrok, or Cloudflare Tunnel) and
pass it as `webhookUrl`.

### 3. The customer comes back

The redirect fires whether or not the payment succeeded, and it often beats the
webhook. Sync before rendering so the page never says "pending" for an order
Mollie already settled.

```ts
export async function getOrderComplete(orderId: string): Promise<Response> {
  const order = await commerce.syncOrder(orderId);

  if (order.payment.state === "paid" || order.payment.state === "authorized") {
    return render("order/thanks", { order });
  }
  if (["canceled", "expired", "failed"].includes(order.payment.state)) {
    return render("order/failed", { order }); // their stock is already back
  }
  return render("order/pending", { order }); // bank transfer, still in flight
}
```

### 4. The warehouse ships it

```ts
export async function shipOrder(orderId: string, carrier: string, trackingCode: string) {
  const order = await commerce.markShipped({ orderId, carrier, trackingCode });
  await email(order.customer?.email, "Your order shipped", { trackingCode });
  return order;
}

// A customer sends it back: record the return, refund the goods, restock.
export async function acceptReturn(orderId: string, skuId: string) {
  await commerce.markReturned({ orderId, restock: true });
  const { refund } = await commerce.refund({
    orderId,
    lines: [{ skuId }],
    reason: "customer return",
    idempotencyKey: `return-${orderId}-${skuId}`,
  });
  return refund;
}
```

Picking the whole order instead? `findOrders({ deliveryState: "ready" })` is
your pick list, and `findOrders({ deliveryState: "shipped" })` is what is in
transit.

### 5. Reconciliation (the part most shops forget)

Webhooks get lost, and a bank transfer can sit open for days. One scheduled
pass closes both gaps: it settles anything Mollie has decided, which releases
the stock held by abandoned carts.

```ts
// Run every 15 minutes.
export async function reconcile() {
  const pending = await commerce.findOrders({
    paymentState: ["created", "open", "pending", "authorized"],
    createdBefore: new Date(Date.now() - 15 * 60_000).toISOString(),
    limit: 200,
  });

  for (const order of pending) {
    try {
      await commerce.syncOrder(order.id);
    } catch (error) {
      // A version_conflict just means a webhook won the race — fine, skip it.
      console.warn("reconcile failed", order.id, error);
    }
  }
}
```

That is the whole integration: five call sites, and the library owns pricing,
stock, payment state, and the delivery lifecycle in between.

## Persistence

`createCommerce` performs no storage work itself. It opens no transaction,
issues no query, and knows nothing about tables or locking: it calls **seven
handlers** you fulfil, and the boundary is the whole contract.

```ts
interface CommerceStorage {
  // reads
  loadSkus(ids: string[]): Promise<Sku[]>;
  findOrder(id: string): Promise<Order | null>;
  findOrderByPaymentId(paymentId: string): Promise<Order | null>;
  findOrderByIdempotencyKey(key: string): Promise<Order | null>;
  listOrders(query?: OrderQuery): Promise<Order[]>;

  // writes — each applies everything it is given, or nothing
  createOrder(input: { order: Order; reserveStock: StockChange[] }): Promise<CreateOrderResult>;
  mutateOrder(orderId: string, apply: OrderMutator): Promise<Order>;
}
```

Two of them write, and that is deliberate: they are the only places the
commerce layer relies on atomicity.

- **`createOrder`** stores a new order *and* takes its stock together. If the
  stock isn't there, change nothing and say so — either return
  `{ status: "out_of_stock", shortages }` or throw
  `storageError.outOfStock(shortages)`. Both reach the caller as
  `CommerceError("out_of_stock")`; see
  [Throwing from a handler](#throwing-from-a-handler).
- **`mutateOrder`** is how every later change is expressed: read the order,
  apply the callback, persist the result — plus any `releaseStock` the callback
  returns, in the same unit. This is where you decide concurrency: hold a lock,
  or re-read and retry using `order.version`, and throw
  `storageError.versionConflict()` on a lost race rather than overwriting. If
  the callback throws, nothing may persist.

Everything else — pricing, state machines, stock bookkeeping, payment
reconciliation, timestamps — stays on the library's side of the line. And
because the boundary *is* the contract, it is enforced: every value crossing it
is validated at runtime, so an implementation that drifts fails immediately
rather than quietly. See
[The contract is checked at runtime](#the-contract-is-checked-at-runtime).

### What goes in each handler

Handlers are persistence, and nothing else. The library decides *what* changed;
you decide *where it lands* — including in tables it has never heard of.

| Handler | Called when | What you do | Your tables it may touch |
| --- | --- | --- | --- |
| `loadSkus` | start of every `checkout` | Read the SKUs by id and return them in the library's shape. Return what you have; don't filter out inactive or out-of-stock ones — the library reports `sku_inactive` and `out_of_stock` itself. | your catalog: `skus`/`variants`, joined to `products`, price lists, per-currency prices |
| `createOrder` | `checkout`, after pricing | Insert the order, decrement stock, commit both together. Normalize however you like — a child `order_lines` table instead of JSON is fine, as long as the order reads back the same. | `orders`, `order_lines`, `inventory`, plus an outbox/audit row if you use one |
| `mutateOrder` | every later change: payment reconciliation, refunds, each delivery transition, cancellation | Read the order, run `apply`, persist it with any `releaseStock`. This is the one place order state changes, so it is the natural home for history and audit rows. | `orders`, `order_lines`, `refunds`, `order_events`/status history, `inventory`, outbox |
| `findOrder` | `getOrder`, `syncOrder`, `refund`, `cancelOrder` | Read one order by id. | `orders` (+ joins to rebuild it) |
| `findOrderByPaymentId` | `handleWebhook` | Read one order by `payment.id`. | `orders` |
| `findOrderByIdempotencyKey` | `checkout` with a key | Read one order by that key. | `orders` |
| `listOrders` | `findOrders` | Apply the filters you are given and sort oldest-created first. | `orders` |

Writing to your own tables inside a write handler is encouraged — that is the
point of owning persistence. A `mutateOrder` that also records history and
restocks your own inventory table:

```ts
async mutateOrder(orderId, apply) {
  return db.transaction(async (tx) => {
    const order = await tx.loadOrder(orderId);
    if (!order) throw new CommerceError("order_not_found", `no order ${orderId}`, { orderId });

    const before = { payment: order.payment.state, delivery: order.delivery.state };
    const { releaseStock = [] } = (await apply(order)) ?? {};

    // 1. your inventory table, in the same commit as the order
    for (const item of releaseStock) {
      await tx.inventory.increment(item.skuId, item.quantity);
    }

    // 2. your own history table — mutateOrder is the only place state moves
    if (order.payment.state !== before.payment || order.delivery.state !== before.delivery) {
      await tx.orderEvents.insert({
        orderId,
        from: before,
        to: { payment: order.payment.state, delivery: order.delivery.state },
        at: order.updatedAt,
      });
    }

    // 3. anything that must leave the process: an outbox row, not a send
    if (order.delivery.state === "shipped") {
      await tx.outbox.insert({ type: "order.shipped", orderId });
    }

    const written = await tx.writeOrder(order, { ifVersion: order.version });
    if (!written) throw new CommerceError("version_conflict", "lost the race", { orderId });
    return written;
  });
}
```

What **not** to put in a handler:

- **No emails, queue publishes, webhooks or HTTP calls.** A write handler can
  be rolled back or retried, so anything that leaves the process would fire for
  a change that never happened, or fire twice. Insert an outbox row inside the
  transaction and act on it after commit, or react to the order the library
  returns — `markShipped` hands you the saved order, which is a fine place to
  send the email.
- **Nothing that assumes `apply` runs once.** If you implement `mutateOrder` as
  a retry loop, `apply` runs again per attempt. Keep its effects confined to the
  order object and the `releaseStock` it returns.
- **No business rules.** Don't reject transitions, cap refunds, or recompute
  totals — the library already did, and disagreeing silently corrupts state.
  Validate shapes if you like, and throw if your own constraints are violated
  (see [Throwing from a handler](#throwing-from-a-handler)); make *decisions* in
  your application layer, before you call `commerce`.
- **No SKU writes.** There is no handler for them: your catalog owns SKUs and
  the library only reads them. The exception is the stock column, which
  `createOrder` and `mutateOrder` move for you.

Beyond that, the shape is yours. Extra columns the library never sees —
`customer_id`, `channel`, `warehouse`, your own `status` mirror — are fine;
just make sure what you return from the read handlers round-trips what you were
given.

### Where to open a transaction

Only the two write handlers need one. The reads are single lookups, and the
library snapshots what it reads onto the order, so wrapping them buys nothing.

| Handler | Transaction | What has to be inside it |
| --- | --- | --- |
| `loadSkus` | no | One batched read. |
| `findOrder`, `findOrderByPaymentId`, `findOrderByIdempotencyKey`, `listOrders` | no | One read each. |
| `createOrder` | **yes** | Every `reserveStock` decrement **and** the order insert. Roll back if any decrement falls short, so a partial reservation can't survive. |
| `mutateOrder` | **yes** | The order read, the `apply` callback, its `releaseStock`, and the versioned write. Roll back if `apply` throws. |

```ts
async createOrder({ order, reserveStock }) {
  return db.transaction(async (tx) => {               // ← both, or neither
    for (const item of reserveStock) {
      const changed = await tx.decrementStock(item);  // conditional on stock >= quantity
      if (!changed) throw new OutOfStock(item);       // rolls back earlier decrements
    }
    return { status: "created", order: await tx.insertOrder({ ...order, version: 1 }) };
  }).catch(toOutOfStockResult);
}

async mutateOrder(orderId, apply) {
  return db.transaction(async (tx) => {               // ← read, mutate and write together
    const order = await tx.loadOrder(orderId);        // or SELECT … FOR UPDATE
    if (!order) throw new CommerceError("order_not_found", `no order ${orderId}`, { orderId });

    const { releaseStock = [] } = (await apply(order)) ?? {};
    for (const item of releaseStock) await tx.incrementStock(item);

    const written = await tx.writeOrder(order, { ifVersion: order.version });
    if (!written) throw new CommerceError("version_conflict", "lost the race", { orderId });
    return written;
  });
}
```

Four things that make these transactions cheap to run:

- **They never nest.** The library never calls one handler from inside another,
  so you never need re-entrant transactions or savepoints.
- **They never span a network call.** Checkout is `createOrder` → *commit* →
  `createPayment` → `mutateOrder`, so no transaction is ever held open across a
  call to Mollie. Same for refunds and cancellations.
- **Default isolation is enough.** `READ COMMITTED` suffices: correctness comes
  from each write's own predicate — `stock >= quantity` and
  `version = <what you read>` — not from the isolation level. You do not need
  `SERIALIZABLE`.
- **A transaction is not the only answer.** Anything all-or-nothing works: a
  single guarded SQL statement (see [Reference schema](#reserving-stock-in-one-statement)),
  a document update, or a compare-and-swap retry loop.

### The contract is checked at runtime

`createCommerce` validates every argument and return value crossing the
boundary — always, with nothing to switch on. A handler that drifts from the
contract fails at the call that broke it, naming the handler and the field:

```
mutateOrder return value does not match the storage contract —
  total.cents: Invalid input: expected int, received number
```

The alternative is a float reaching a `total`, or a lost write quietly
returning the version it was handed, and surfacing three steps later as a wrong
order. Validating one order costs about **2µs** — noise beside the database
round trip that produced it.

It uses [zod](https://zod.dev) for shapes, plus the things a schema cannot
express:

| Handler | Also checked |
| --- | --- |
| `loadSkus` | returns only SKUs that were asked for, and none twice |
| `createOrder` | returns the order it was given, with a version of at least 1; an `out_of_stock` result names at least one shortage |
| `mutateOrder` | calls the mutator, is handed the order it was asked for, and returns a *higher* version than it started with — a silent lost write is otherwise invisible |

Two things it deliberately does not do: values pass through **unchanged** (the
original object, never zod's parsed copy, so nothing is stripped or coerced),
and errors your handlers throw pass through untouched — only a thrown
`out_of_stock` is inspected, since its shortages are part of the contract.

There is nothing to import or configure: the checks are part of
`createCommerce`, and `describeCommerceStorage` runs the same ones, so what
conformance verifies is exactly what production enforces.

The schemas are exported too — `OrderSchema`, `SkuSchema`, `MoneySchema` and
the rest — which is handy on your side of the line for validating rows you
rebuilt from JSON columns:

```ts
import { OrderSchema } from "mollie-ecommerce";

const order = OrderSchema.parse({ ...row, lines: JSON.parse(row.lines) });
```

### Throwing from a handler

Throwing is a normal way for a handler to fail — it is usually also how you
abort a transaction. Whatever you throw travels out through the `commerce.*`
method that was running.

`storageError` builds the errors handlers are expected to raise, so your
application's error mapping only ever has to know `CommerceError.code`:

```ts
import { storageError } from "mollie-ecommerce";

async mutateOrder(orderId, apply) {
  return db.transaction(async (tx) => {
    const order = await tx.loadOrder(orderId);
    if (!order) throw storageError.orderNotFound(orderId);

    const { releaseStock = [] } = (await apply(order)) ?? {};
    // …

    const written = await tx.writeOrder(order, { ifVersion: order.version });
    if (!written) throw storageError.versionConflict(orderId, order.version);
    return written;
  });
}
```

| Helper | Code | Raise it from |
| --- | --- | --- |
| `storageError.outOfStock(shortages)` | `out_of_stock` | `createOrder`, instead of returning the result — see below |
| `storageError.orderNotFound(orderId)` | `order_not_found` | `mutateOrder`, when the order is gone. The read handlers return `null` instead |
| `storageError.versionConflict(orderId, expected?, actual?)` | `version_conflict` | `mutateOrder`, when you lost the race. Callers re-read and retry |
| `storageError.duplicateOrder(orderId, cause?)` | `duplicate_order` | `createOrder`, on a unique-index violation |
| `storageError.failed(message, cause?)` | `storage_error` | anywhere storage broke for a reason the library has no opinion about |

The last two take the driver error as `cause`, which is where loggers look for
it. `CommerceError` accepts `{ cause }` generally, so you can wrap your own
errors without losing them.

**`createOrder` may throw `outOfStock` rather than returning it.** Both reach
the caller as `CommerceError("out_of_stock")`, and throwing is usually simpler,
since a transaction aborts by throwing anyway:

```ts
createOrder({ order, reserveStock }) {
  return db.transaction(async (tx) => {
    const shortages = await tx.reserveStock(reserveStock);
    if (shortages.length > 0) throw storageError.outOfStock(shortages); // rolls back
    return { status: "created", order: await tx.insertOrder({ ...order, version: 1 }) };
  });
}
```

Anything that is *not* a `CommerceError` propagates untouched — a driver error,
a `TypeError`, your own class. Use `onStorageError` below if you would rather
translate them in one place than at every throw site.

One case where the library keeps its own error instead of yours: if
`createPayment` fails **and** the compensating write that releases the stock
fails too, you get a `storage_error` saying the reservation is still held, with
the gateway error as its `cause` and both errors in `details`. Losing the
reason the payment failed would be the worse outcome.

### Handling errors from your storage

When a handler throws — a lost connection, a deadlock, a constraint you added
— the error travels out through whichever `commerce.*` method was running.
`onStorageError` gives you a single place to see it first:

```ts
const commerce = createCommerce({
  gateway,
  storage: myStorage,
  onStorageError: (error, { handler, orderId }) => {
    log.error({ err: error, handler, orderId }, "storage failed");

    // Translate what your driver reports into the library's vocabulary.
    if (isSerializationFailure(error)) {
      return new CommerceError("version_conflict", "write raced; retry", { orderId });
    }
    if (isUniqueViolation(error, "orders_payment_id")) {
      return new CommerceError("duplicate_order", "payment already has an order", { orderId });
    }
    // Returning nothing lets the original error through untouched.
  },
});
```

| You return | What callers see |
| --- | --- |
| a `CommerceError` | that error, with its `code` — so your API error mapping already knows what to do with it |
| nothing | the original error, unchanged; you have only observed it |
| (you throw) | whatever you threw |

Contract violations (`storage_contract`) come through here as well, since the
hook sits outside the checks.

The context tells you which handler failed and what it was working on:
`orderId` for order-scoped calls, `skuIds` for `loadSkus`, `key` for the
lookups. Translating is worth doing for the two codes the library acts on:
`version_conflict` means "re-read and retry", and `out_of_stock` is the one
case you should **not** signal by throwing — return it from `createOrder`
instead.

The hook cannot swallow an error. There is no way to make a failed write look
like a success, because the commerce layer would then carry on having persisted
nothing.

### Why no adapters ship

There is no `SqliteDatabase` or `PostgresDatabase` to import. Your orders table
lives next to your products, customers and carts; it wants your migrations,
your connection pool, your naming. An adapter that owned it would either fight
all three or grow configuration until it lost.

So the package ships the contract and one worked implementation you can copy —
`examples/memory-storage.ts`, two maps in ~140 lines — and this repo's own
suites run against in-memory, SQLite and Postgres back-ends under `test/` to
keep the contract honest on real engines.

### Writing yours

Hand the handlers to your ORM, your query builder, or your data service:

```ts
import { createCommerce, CommerceError } from "mollie-ecommerce";

const commerce = createCommerce({
  gateway,
  storage: {
    loadSkus: (ids) => prisma.sku.findMany({ where: { id: { in: ids } } }),

    async createOrder({ order, reserveStock }) {
      return prisma.$transaction(async (tx) => {
        for (const item of reserveStock) {
          const { count } = await tx.sku.updateMany({
            where: { id: item.skuId, stock: { gte: item.quantity } },
            data: { stock: { decrement: item.quantity } },
          });
          if (count === 0) {
            // Abort: the transaction rolls back the earlier decrements.
            throw new OutOfStock(item);
          }
        }
        return { status: "created", order: await tx.order.create({ data: { ...order, version: 1 } }) };
      }).catch((error) => {
        if (error instanceof OutOfStock) return { status: "out_of_stock", shortages: error.shortages };
        throw error;
      });
    },

    async mutateOrder(orderId, apply) {
      return prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order) throw new CommerceError("order_not_found", `no order ${orderId}`, { orderId });

        const { releaseStock = [] } = (await apply(order)) ?? {};
        for (const item of releaseStock) {
          await tx.sku.update({
            where: { id: item.skuId },
            data: { stock: { increment: item.quantity } },
          });
        }
        const { count } = await tx.order.updateMany({
          where: { id: orderId, version: order.version },     // optimistic lock
          data: { ...order, version: order.version + 1 },
        });
        if (count === 0) throw new CommerceError("version_conflict", "lost the race", { orderId });
        return { ...order, version: order.version + 1 };
      });
    },

    findOrder: (id) => prisma.order.findUnique({ where: { id } }),
    findOrderByPaymentId: (paymentId) => prisma.order.findFirst({ where: { paymentId } }),
    findOrderByIdempotencyKey: (key) => prisma.order.findFirst({ where: { idempotencyKey: key } }),
    listOrders: (query) => prisma.order.findMany(toPrismaWhere(query)),
  },
});
```

Then hold your implementation to the contract — the suite checks shapes
alongside behavior, the same way `createCommerce` does:

```ts
import { describeCommerceStorage } from "mollie-ecommerce/conformance";

describeCommerceStorage("prisma", async () => {
  await reset();
  return { storage: myStorage, saveSku: (sku) => prisma.sku.create({ data: sku }) };
});
```

Eleven tests cover the ones that are easy to get subtly wrong: shortages that
must not persist the order, `releaseStock` landing in the same write as the
mutation, a throwing mutator leaving nothing behind, version bumps, and every
`listOrders` filter.

The quickest start is to copy
[`examples/memory-storage.ts`](https://github.com/alexandre-dos-reis/mollie-ecommerce/blob/main/examples/memory-storage.ts)
from the repository and replace the maps — it is a complete implementation, and
this repo's tests run the full lifecycle against it, so it cannot drift. It is
deliberately not part of the published package: storage is yours, and an
in-memory one is a starting point to own rather than a dependency to carry.

## How these tables sit next to yours

The library needs exactly two tables' worth of data — it never creates or
touches them itself. Everything else in your shop stays yours, and the two
halves meet at two deliberately loose joins.

```
  YOUR CATALOG                             WHAT THE HANDLERS PERSIST
  ─────────────────────────                ────────────────────────────────

  products                                 skus
  ├ id            PK ◄──────────────────┐  ├ id            PK  "tshirt-red-m"
  ├ title            "T-shirt"           │ ├ name              "T-shirt — Red / M"
  ├ description                          └─┤ product_id    FK? "tshirt"   (nullable)
  ├ images                                 ├ kind             physical|digital|service
  └ …                                      ├ price_cents      1999
                                           ├ currency         "EUR"
  product_options                          ├ stock            10    (NULL = unlimited)
  ├ product_id    FK                       └ active           1
  ├ name             "Size"
  └ values           ["S","M","L"]         orders
                                           ├ id            PK  "ord_…"
  option_values_per_sku                    ├ version           optimistic lock
  ├ sku_id        FK ────────────────────► ├ lines          JSON [{ skuId, name, kind,
  ├ option           "Size"                │                      quantity, unitPrice,
  └ value            "M"                   │                      total, productId }]
                                           ├ total_cents       3998
  customers                                ├ currency          "EUR"
  ├ id            PK                       ├ payment_state     paid|open|…
  ├ email         ◄──────────────────────► ├ customer_email    "ada@example.com"
  └ …                                      ├ customer_locale   "nl_NL"
                                           ├ payment_id     UQ  "tr_…"
  carts, promotions, reviews,               ├ idempotency_key UQ  your cart id
  addresses, invoices, …                   ├ delivery_state    ready|shipped|…
  (none of the library's business)          ├ stock_reserved    1
                                           ├ refunds        JSON [{ id, amount, state }]
                                           └ created_at / updated_at
```

**`skus.product_id` → your `products.id`** is the variant join. It is nullable
and never interpreted by the library — `loadSkus` returns it, `listOrders`
never filters on it, and your own catalog queries do the grouping. Add a real
foreign key if you want the database to enforce it:

```sql
ALTER TABLE skus
  ADD CONSTRAINT skus_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL;
```

Nothing in the library knows your table's name, so nothing could have created
that constraint for you — which is the same reason no storage adapters ship.

**`orders.customer_email` → your `customers.email`** is a soft link, by value.
Orders deliberately do not reference a customer row: an order must stay
readable after the customer is deleted, and guest checkout has no row to point
at. Join on email when you need the customer, or add your own
`orders.customer_id` column — the library ignores columns it does not know.

**`orders.lines` holds snapshots, not references.** Each line copies the SKU's
id, name, kind, unit price and `productId` at purchase time, so repricing or
deleting a SKU never rewrites history and an invoice from last year still shows
what was actually bought. That is also why there is no foreign key from lines
to `skus`.

### Who writes what

| Data | Written by | Read by |
| --- | --- | --- |
| your `products`, options, images | you | you |
| `skus` | you — the library has no write handler for them | the library, via `loadSkus` |
| `skus.stock` | both: you for restocks, the library through `createOrder` / `mutateOrder`'s `releaseStock` | both |
| `orders` | the library, through your two write handlers | you, via `getOrder` / `findOrders` |

Write `skus` from whatever already owns your catalog — a save hook, a nightly
sync, an admin action. One row per purchasable variant, prices in minor units.
Everything the library does follows from those rows.

Orders belong to the library's flow. Reading them directly is fine — they are
your rows, in your schema. Writing them outside `mutateOrder` breaks the
optimistic lock, the stock accounting and the payment reconciliation.

## Reference schema

No part of this is shipped, and the library never sees your tables — what it
enforces is the shape of the data your handlers return, not where you keep it.
This is the schema its own test suites use, in portable SQL, as a starting
point you own from the first migration onwards.

```sql
CREATE TABLE IF NOT EXISTS skus (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  currency    TEXT NOT NULL,
  stock       INTEGER,
  active      INTEGER NOT NULL DEFAULT 1,
  product_id  TEXT
);

CREATE INDEX IF NOT EXISTS skus_product_id ON skus (product_id);

CREATE TABLE IF NOT EXISTS orders (
  id                    TEXT PRIMARY KEY,
  version               INTEGER NOT NULL,
  idempotency_key       TEXT,
  currency              TEXT NOT NULL,
  total_cents           INTEGER NOT NULL,
  amount_refunded_cents INTEGER NOT NULL DEFAULT 0,
  payment_state         TEXT NOT NULL,
  payment_id            TEXT,
  checkout_url          TEXT,
  delivery_state        TEXT NOT NULL,
  carrier               TEXT,
  tracking_code         TEXT,
  stock_reserved        INTEGER NOT NULL DEFAULT 0,
  customer_email        TEXT,
  customer_locale       TEXT,
  lines                 TEXT NOT NULL,
  refunds               TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_id ON orders (payment_id);
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key ON orders (idempotency_key);
CREATE INDEX IF NOT EXISTS orders_payment_state ON orders (payment_state);
CREATE INDEX IF NOT EXISTS orders_delivery_state ON orders (delivery_state);
CREATE INDEX IF NOT EXISTS orders_customer_email ON orders (customer_email);
CREATE INDEX IF NOT EXISTS orders_created_at ON orders (created_at);
```

Adjust types for your engine (`TEXT` → `VARCHAR`/`JSONB`, `INTEGER` →
`BIGINT`). The choices that matter:

| Concern | Column(s) | Why |
| --- | --- | --- |
| Money | `*_cents INTEGER` plus one `currency TEXT` per row | Integer minor units. No floats near money; one currency per order is enforced at checkout. |
| Timestamps | `created_at`, `updated_at` as `TEXT` | ISO-8601 UTC, as `toISOString()` produces. Lexicographic order matches chronological, so the index and the `createdAfter`/`createdBefore` filters work — as long as every writer uses that one format. |
| Booleans | `active`, `stock_reserved` as `INTEGER` 0/1 | Portable; map them back to `boolean` when you read. |
| Collections | `lines`, `refunds` as JSON in `TEXT` | Snapshots, never queried by the library. Use `jsonb` if you want to query inside them — then skip `JSON.parse`, since most drivers hand back a parsed object. |
| Unlimited stock | `stock INTEGER NULL` | `NULL` means untracked, and the reservation skips those rows. |
| Variant grouping | `skus.product_id TEXT NULL`, indexed | Your product id, stored and filtered but never interpreted. |

The two unique indexes are load-bearing: `orders_payment_id` is what makes
webhook lookups unambiguous, and `orders_idempotency_key` is what makes
checkout replay-safe. Postgres and SQLite both allow many `NULL`s there, so
orders without a payment id coexist happily.

Keep the integer columns `INTEGER` rather than `BIGINT` if you use
node-postgres: it returns `bigint` as a **string** to avoid precision loss,
which would quietly break the money mapping.

### Reserving stock in one statement

`createOrder` has to take stock and store the order together, or neither —
normally a transaction. In Postgres the stock half needs no explicit
transaction at all: a data-modifying CTE guarded on the shortage set is
all-or-nothing in a single statement.

```sql
WITH wanted AS (
  SELECT sku_id, quantity FROM unnest($1::text[], $2::int[]) AS t(sku_id, quantity)
),
shortage AS (
  SELECT w.sku_id, w.quantity, s.stock, s.id IS NULL AS missing
  FROM wanted w LEFT JOIN skus s ON s.id = w.sku_id
  WHERE s.id IS NULL OR (s.stock IS NOT NULL AND s.stock < w.quantity)
),
reserved AS (
  UPDATE skus s SET stock = s.stock - w.quantity
  FROM wanted w
  WHERE s.id = w.sku_id
    AND s.stock IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM shortage)   -- all or nothing
  RETURNING s.id
)
SELECT sku_id, quantity, stock, missing FROM shortage ORDER BY sku_id;
```

Rows returned are your shortages; none means the reservation took. Aggregate
repeated SKU ids first (`aggregateStock`, exported) or two lines of the same
SKU will each pass the check and together oversell.

You still want a transaction around *this statement plus the order insert*, so
the two commit together — see
[Where to open a transaction](#where-to-open-a-transaction).

### Operating notes

- **`version_conflict` is normal under load.** Two writers touched one order and
  the slower one was rejected rather than allowed to overwrite. Re-read and
  retry; for webhooks, retrying is usually enough since Mollie redelivers.
- **Abandoned carts hold stock** until their payment expires. Mollie expires it
  and calls your webhook, but a periodic `syncOrder` pass frees stock sooner —
  see [Reconciliation](#5-reconciliation-the-part-most-shops-forget).
- **No gateway call belongs inside a write handler.** Checkout is three phases:
  price the cart from `loadSkus`, then `createOrder` (order + stock, atomic) →
  `createPayment` (nothing held open) → `mutateOrder` to store the payment id
  and reconcile. If the gateway call fails, a compensating `mutateOrder`
  releases the stock and fails the order.

## Versioning

[Semantic versioning](https://semver.org). The public API is everything
exported from `mollie-ecommerce` and `mollie-ecommerce/conformance` — the
`Commerce` methods, the model types, `Money` helpers, the `CommerceStorage`
handler contract, and `CommerceError` codes. Internal helpers and the shape of `details` on errors
are not covered.

**Pre-1.0:** breaking changes go in the minor slot (`0.1.x` → `0.2.0`), so pin
the minor if you need stability. Every release is described in
[CHANGELOG.md](CHANGELOG.md).

Adding a handler, or tightening one's contract, is a breaking change for every
implementation and will say so in the changelog — `describeCommerceStorage` is
how you find out whether yours still conforms.

## Behavior worth knowing

- **Stock is held from checkout until the payment dies** (`canceled`/`expired`/`failed`), and released exactly once via `order.stockReserved`. A paid order keeps its reservation — the goods left the warehouse. Disable with `reserveStock: false`.
- **Digital orders self-deliver.** No physical lines means `delivered` on payment. Disable with `autoDeliverDigital: false`.
- **Refund state is optimistic.** Mollie returns `pending`; `syncOrder` reconciles `amountRefunded` from the payment.
- **The webhook URL must be publicly reachable.** Mollie cannot call `localhost`; tunnel it in development.
- **Webhook status codes are load-bearing.** 2xx means "absorbed", anything else means "retry", so a transient failure answered 2xx drops the payment. `createWebhookHandler` maps them for you.
- **No expiry sweeper.** Mollie expires unpaid payments and calls your webhook. To free stock sooner, run `findOrders({ paymentState: ["created", "open", "pending"] })` on a schedule and call `syncOrder`.

## Contributing

Bug reports, storage implementations, and documentation fixes are all welcome —
see [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through
[SECURITY.md](SECURITY.md), not the public tracker.

Releases are automated: every change carries a
[changeset](https://github.com/changesets/changesets), those collect into a
`release: version packages` PR, and merging it publishes to npm — but only once
CI is green on `main`.

## License

[MIT](LICENSE)
