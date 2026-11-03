# mollie-ecommerce

[![CI](https://github.com/alexandre-dos-reis/mollie-ecommerce/actions/workflows/ci.yml/badge.svg)](https://github.com/alexandre-dos-reis/mollie-ecommerce/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Mollie has payments and refunds but no product model. This library adds the
minimum an ecommerce flow needs on top: products, orders, and a delivery
lifecycle — nothing else.

It is a library, not a server: no HTTP layer, no framework, no database
required. Call the methods from whatever you already run.

## Install

```bash
bun add mollie-ecommerce
```

Requires [Bun](https://bun.com) 1.2+. The package ships TypeScript sources and
Bun resolves them directly, so there is no build step — and no transpiled
output for Node to consume.

```bash
# Working on the library itself
bun install
bun run check     # typecheck + 112 tests
bun run example   # the full lifecycle, no Mollie account needed
```

## Scope

In scope: pricing a cart, creating and reconciling payments, refunds, stock
reservation, and delivery state.

Out of scope, by design: catalog concerns (images, SKUs, descriptions,
categories, VAT breakdowns, translations) belong in your own catalog keyed by
product `id`; HTTP routing and webhook transport belong in your application;
and Mollie features unrelated to this lifecycle — subscriptions, payment links,
settlements, Connect — are better reached through the Mollie SDK directly.

## Model

Deliberately small. Anything else your shop shows — images, SKUs,
descriptions, VAT breakdowns, translations — stays in your catalog, keyed by
product `id`.

```ts
type Product = {
  id: string;        // your identifier; order lines keep a copy forever
  name: string;      // shown to the customer, used in the payment description
  kind: "physical" | "digital" | "service";
  price: Money;      // all products in one order share a currency
  stock?: number;    // undefined = unlimited
  active?: boolean;  // false hides it from checkout; defaults true
};

type Order = {
  id: string;
  version: number;             // optimistic-lock counter
  idempotencyKey?: string;
  lines: OrderLine[];          // frozen copies of the products at purchase time
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
import { createCommerce, createMollieGateway, money } from "mollie-ecommerce";
import { SqliteDatabase } from "mollie-ecommerce/storage/sqlite";

const commerce = createCommerce({
  gateway: createMollieGateway({ apiKey: process.env.MOLLIE_API_KEY }),
  db: new SqliteDatabase({ filename: "./shop.sqlite" }),
  redirectUrl: "https://shop.example/thanks",
  webhookUrl: "https://shop.example/mollie-webhook",
});

await commerce.db.products.save({
  id: "mug", name: "Enamel mug", kind: "physical", price: money(1250, "EUR"), stock: 10,
});
```

### `createCommerce(options)`

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `gateway` | yes | — | Payment provider. `createMollieGateway({ apiKey })`, or `new FakePaymentGateway()` in tests. |
| `db` | yes | — | Storage. `InMemoryDatabase`, `SqliteDatabase`, or your own adapter. |
| `redirectUrl` | no | — | Where Mollie returns the customer after paying. Mollie requires it for most methods. |
| `cancelUrl` | no | — | Where Mollie returns a customer who abandons the payment. |
| `webhookUrl` | no | — | Public URL Mollie posts status changes to. Without it you must poll `syncOrder`. Cannot be `localhost`. |
| `autoDeliverDigital` | no | `true` | Jump an order with no physical lines straight to `delivered` when paid. |
| `reserveStock` | no | `true` | Decrement stock at checkout, give it back if the payment dies. |
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
| `input.items` | `[{ productId, quantity? }]`, at least one. Quantity defaults to 1; repeated products are merged into one line. |
| `input.customer` | `{ email?, locale? }`. `locale` (e.g. `nl_NL`) localizes Mollie's payment screen. |
| `input.description` | Payment description on the customer's statement. Defaults to a generated summary; Mollie truncates per method. |
| `input.redirectUrl` / `input.cancelUrl` / `input.webhookUrl` | Override the configured URLs for this order. |
| `input.idempotencyKey` | Replaying the same key returns the first order (`replayed: true`) instead of charging twice. Also sent to Mollie. |

Throws `empty_cart`, `product_not_found`, `product_inactive`, `out_of_stock`
(nothing is reserved), `currency_mismatch`.

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

### `refund(input) → { order, refund }`

Refunds a paid order: in full, by amount, or by line. Moves money only — see
`markReturned` for stock.

| Argument | Meaning |
| --- | --- |
| `input.orderId` | Order to refund. |
| `input.amount` | Exact `Money` to refund. Mutually exclusive with `lines`. |
| `input.lines` | `[{ productId, quantity? }]`; quantity defaults to the whole line. |
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

### `db`

The database you passed in. Use it for catalog writes (`db.products.save`,
`db.products.delete`), reads (`db.products.list`), and your own queries.

## A real-world shop

The five places a real shop touches this library: one module wiring it up, then
the checkout request, the webhook, the customer's return from Mollie, the
warehouse action, and a reconciliation job. Request handlers are written with
plain `Request`/`Response` so they drop into Bun.serve, Hono, Elysia, Next, or
anything else.

```ts
// shop.ts — wire it up once, import it everywhere.
import { Pool } from "pg";
import { createCommerce, createMollieGateway } from "mollie-ecommerce";
import { applyPostgresSchema, createPostgresDatabase } from "mollie-ecommerce/storage/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await applyPostgresSchema(pool);

export const db = createPostgresDatabase(pool);

export const commerce = createCommerce({
  gateway: createMollieGateway({ apiKey: process.env.MOLLIE_API_KEY! }),
  db,
  redirectUrl: "https://shop.example/order/complete",
  cancelUrl: "https://shop.example/cart",
  webhookUrl: "https://shop.example/webhooks/mollie",
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
  product_not_found: 404,
  product_inactive: 409,
  out_of_stock: 409,
  currency_mismatch: 422,
  empty_cart: 400,
};

export async function postCheckout(request: Request): Promise<Response> {
  const cart = await request.json(); // { id, items, email, locale }

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
    case "product_inactive":
    case "product_not_found":
      return "That item is no longer available.";
    default:
      return "We could not start your payment. Please try again.";
  }
}
```

### 2. The Mollie webhook

Mollie posts `id=tr_...` form-encoded and nothing else — no status, so the
state has to come from the API, which is exactly what `handleWebhook` does.
Two rules matter: **always answer 2xx** (any other status makes Mollie retry,
forever for a payment you will never recognize), and **answer fast** — do your
own slow work (emails, invoices, ERP calls) after responding.

```ts
import { commerce } from "./shop.ts";

export async function postMollieWebhook(request: Request): Promise<Response> {
  const form = await request.formData();
  const paymentId = String(form.get("id") ?? "");
  if (!paymentId) return new Response("missing id", { status: 400 });

  const order = await commerce.handleWebhook(paymentId);
  if (!order) return new Response("ok"); // not ours — still 200
  if (order.payment.state === "paid" && order.delivery.state === "ready") {
    queue.push({ type: "order.paid", orderId: order.id }); // email, invoice, picking slip
  }
  return new Response("ok");
}
```

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
export async function acceptReturn(orderId: string, productId: string) {
  await commerce.markReturned({ orderId, restock: true });
  const { refund } = await commerce.refund({
    orderId,
    lines: [{ productId }],
    reason: "customer return",
    idempotencyKey: `return-${orderId}-${productId}`,
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

## Storage

Storage is behind interfaces, so no database is required. Three adapters ship,
and a `Database` is just `{ products, orders, transaction() }` — implement it to
plug in your own.

| Adapter | Import | Use it for |
| --- | --- | --- |
| `InMemoryDatabase` | `mollie-ecommerce/storage/memory` | Tests and development. No dependency, nothing persisted. |
| `SqliteDatabase` | `mollie-ecommerce/storage/sqlite` | Single-node deployments. Uses Bun's built-in `bun:sqlite`. |
| Postgres stores | `mollie-ecommerce/storage/postgres` | Postgres. You bring the driver — the module imports none. |

See [Using Postgres](#using-postgres) below for the full setup.

Helpers: `SCHEMA_SQL` plus `orderToRow` / `rowToOrder` / `productToRow` /
`rowToProduct` in `mollie-ecommerce/storage/rows`; `aggregateStock` for the
repeated-product-id rule; the SQLite and Postgres adapters as worked examples;
and `describeDatabase` in `mollie-ecommerce/storage/conformance` — 18 contract
tests to point at your own adapter:

```ts
import { describeDatabase } from "mollie-ecommerce/storage/conformance";

describeDatabase("mysql", () => new MysqlDatabase({ url: process.env.DATABASE_URL }));
```

No gateway call happens inside a transaction. Checkout is three phases: price
the cart, reserve stock and insert the order (tx) → `createPayment` (no tx) →
store the payment id and reconcile (tx). If the gateway call fails, a
compensating transaction releases the stock and fails the order.

## Using Postgres

The Postgres adapter imports no driver — you pass in a connection, so there is
nothing to agree on about pooling, SSL, or connection management.

### 1. Install a driver

```bash
bun add pg
bun add -d @types/pg
```

Any driver works as long as it exposes `query(sql, params) → { rows }` and
`connect()`; node-postgres already does. The test suite proves this by running
the same adapter against [PGlite](https://pglite.dev) through a ~20-line pool
shim, and a compile-time guard (`test/pg-compat.test.ts`) keeps `pg`'s own
types assignable to the ports.

### 2. Create the schema

```ts
import { Pool } from "pg";
import { applyPostgresSchema } from "mollie-ecommerce/storage/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await applyPostgresSchema(pool);
```

`applyPostgresSchema` runs `SCHEMA_SQL` — two tables and six indexes, all
`IF NOT EXISTS`, so it is safe to call on every boot. It only ever adds; it
never alters or drops, so it is not a migration tool.

If you already run migrations (Atlas, Drizzle, dbmate, Flyway, …), skip it and
paste `SCHEMA_SQL` into your first migration instead:

```ts
import { SCHEMA_SQL } from "mollie-ecommerce/storage/rows";
console.log(SCHEMA_SQL); // → paste into 0001_mollie_ecommerce.sql
```

### 3. Wire it up

```ts
import { createCommerce, createMollieGateway } from "mollie-ecommerce";
import { createPostgresDatabase } from "mollie-ecommerce/storage/postgres";

const commerce = createCommerce({
  gateway: createMollieGateway({ apiKey: process.env.MOLLIE_API_KEY! }),
  db: createPostgresDatabase(pool),
  redirectUrl: "https://shop.example/order/complete",
  webhookUrl: "https://shop.example/webhooks/mollie",
});
```

That is the whole integration. For hosted Postgres, configure the driver as
that provider documents — the adapter never inspects your connection:

```ts
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },   // most managed providers
  max: 10,                             // see the note on pool sizing below
});
```

### How transactions use the pool

`createPostgresDatabase(pool).transaction(run)` checks out **one** connection
with `connect()`, issues `BEGIN`, runs your work against stores bound to that
connection, then `COMMIT` — or `ROLLBACK` if anything throws — and always
releases the connection in a `finally`.

Two consequences worth knowing:

- **A nested `transaction()` joins the outer one** rather than taking a second
  connection, which would block on the rows the first one holds.
- **Each in-flight checkout holds one connection** for the duration of its
  transactions — not for the Mollie API call, which deliberately happens
  outside any transaction. Size `max` for your concurrency, and remember that
  serverless functions each get their own pool.

Transaction-mode poolers (PgBouncer, Supabase's pooler, RDS Proxy) are fine:
the adapter sets no session state — no `SET`, no `LISTEN`, no cursors, no
advisory locks — and every transaction is a plain `BEGIN`/`COMMIT` on one
connection.

### What the tables look like

Both SQL adapters share `SCHEMA_SQL`, so the column types are chosen for
portability rather than for Postgres' richest options:

| Concern | Column(s) | Why |
| --- | --- | --- |
| Money | `total_cents INTEGER`, `amount_refunded_cents`, `price_cents`, plus one `currency TEXT` per row | Integer minor units. No floats anywhere near money, and one currency per order is enforced at checkout. |
| Timestamps | `created_at`, `updated_at` as `TEXT` | ISO-8601 UTC strings, as produced by `toISOString()`. Lexicographic order matches chronological order, so the `created_at` index and the `createdAfter`/`createdBefore` filters work — but only because every writer uses that one format. |
| Booleans | `active`, `stock_reserved` as `INTEGER` 0/1 | Portable across engines. The mappers normalize them back to `boolean`. |
| Collections | `lines`, `refunds` as `TEXT` holding JSON | Mapped with `JSON.parse`/`JSON.stringify`. |
| Unlimited stock | `stock INTEGER NULL` | `NULL` means unlimited, and the reservation SQL skips those rows. |

If you want to query inside the JSON, switch those columns to `jsonb` — but
then adapt `rowToOrder`, because node-postgres hands back a parsed object and
`JSON.parse` would throw on it. Likewise, keep the integer columns `INTEGER`
rather than `BIGINT`: node-postgres returns `bigint` as a **string** to avoid
precision loss, which would break the money mapping.

The unique indexes on `payment_id` and `idempotency_key` are what make webhook
lookups and idempotent checkout correct. Postgres permits many `NULL`s in a
unique index, so orders without a payment id coexist happily.

### Verifying your setup

Point the conformance suite at your live database to confirm the schema, the
driver, and your pool behave as the library expects:

```ts
// postgres.conformance.test.ts
import { Pool } from "pg";
import { describeDatabase } from "mollie-ecommerce/storage/conformance";
import { applyPostgresSchema, createPostgresDatabase } from "mollie-ecommerce/storage/postgres";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
await applyPostgresSchema(pool);

describeDatabase("my-postgres", async () => {
  await pool.query("TRUNCATE products, orders");
  return createPostgresDatabase(pool);
});
```

Point it at a throwaway database — it truncates both tables between tests.

### Operating notes

- **`version_conflict` is normal under load.** Two writers touched one order and
  the slower one was rejected rather than allowed to overwrite. Re-read the
  order and retry; for webhooks, retrying is usually enough since Mollie will
  redeliver anyway.
- **`duplicate_order` on insert** means `payment_id` or `idempotency_key`
  collided. Two orders cannot share a Mollie payment, and a repeated
  idempotency key is handled by `checkout` before it reaches the database.
- **`relation "products" does not exist`** means the schema was never applied —
  call `applyPostgresSchema` or run your migration.
- **Abandoned carts hold stock** until their payment expires. Mollie expires
  them and calls your webhook, but a periodic `syncOrder` pass frees stock
  sooner — see [Reconciliation](#5-reconciliation-the-part-most-shops-forget).

## Versioning

[Semantic versioning](https://semver.org). The public API is everything
exported from `mollie-ecommerce` and its `storage/*` subpaths — the `Commerce`
methods, the model types, `Money` helpers, the storage ports, and
`CommerceError` codes. Internal helpers and the shape of `details` on errors
are not covered.

**Pre-1.0:** breaking changes go in the minor slot (`0.1.x` → `0.2.0`), so pin
the minor if you need stability. Every release is described in
[CHANGELOG.md](CHANGELOG.md).

Adding a storage port method is a breaking change for custom adapters, and will
say so in the changelog — `describeDatabase` is how you find out whether yours
still conforms.

## Behavior worth knowing

- **Stock is held from checkout until the payment dies** (`canceled`/`expired`/`failed`), and released exactly once via `order.stockReserved`. A paid order keeps its reservation — the goods left the warehouse. Disable with `reserveStock: false`.
- **Digital orders self-deliver.** No physical lines means `delivered` on payment. Disable with `autoDeliverDigital: false`.
- **Refund state is optimistic.** Mollie returns `pending`; `syncOrder` reconciles `amountRefunded` from the payment.
- **The webhook URL must be publicly reachable.** Mollie cannot call `localhost`; tunnel it in development.
- **No expiry sweeper.** Mollie expires unpaid payments and calls your webhook. To free stock sooner, run `findOrders({ paymentState: ["created", "open", "pending"] })` on a schedule and call `syncOrder`.

## Contributing

Bug reports, storage adapters, and documentation fixes are all welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through
[SECURITY.md](SECURITY.md), not the public tracker.

## License

[MIT](LICENSE)
