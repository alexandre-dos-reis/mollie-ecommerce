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
bun run check     # typecheck + 71 tests
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

## Typical flow

```ts
// 1. Checkout, then redirect the customer to checkoutUrl.
const { order, checkoutUrl } = await commerce.checkout({
  items: [{ productId: "mug", quantity: 2 }],
  customer: { email: "ada@example.com", locale: "nl_NL" },
  idempotencyKey: cartId,
});

// 2. Mollie's webhook posts the payment id; delivery becomes "ready".
await commerce.handleWebhook(paymentId);

// 3. Fulfil.
await commerce.markShipped({ orderId: order.id, carrier: "PostNL", trackingCode: "3S1" });
await commerce.markDelivered(order.id);

// 4. Refund a line if something goes wrong.
await commerce.refund({ orderId: order.id, lines: [{ productId: "mug", quantity: 1 }] });
```

## Storage

Storage is behind interfaces, so no database is required: `InMemoryDatabase`
runs everything in process. A `Database` is `{ products, orders, transaction() }`
— implement it to plug in your own.

| Port method | Why it looks like that |
| --- | --- |
| `products.getMany(ids)` | A cart of any size is one round trip, not N queries. |
| `products.reserveStock(items)` | All-or-nothing decrement, so concurrent checkouts can't oversell. Returns shortages rather than throwing. `stock: undefined` is unlimited. |
| `products.releaseStock(items)` | Called when a payment dies, or on `markReturned({ restock: true })`. |
| `orders.insert` / `orders.update` | `update` is an optimistic lock on `order.version`: zero rows affected must throw `version_conflict`, never silently overwrite. |
| `orders.findByPaymentId` | Webhooks carry only the payment id. Unique index. |
| `orders.findByIdempotencyKey` | Makes checkout replay-safe. Unique index. |
| `transaction(run)` | Must pass transaction-bound stores and roll back on throw. |

Helpers: `SCHEMA_SQL` plus `orderToRow` / `rowToOrder` / `productToRow` /
`rowToProduct` in `mollie-ecommerce/storage/rows`; `SqliteDatabase` as a worked
example; and `describeDatabase` in `mollie-ecommerce/storage/conformance` — 17
contract tests to point at your own adapter:

```ts
describeDatabase("postgres", () => new PostgresDatabase({ url: process.env.DATABASE_URL }));
```

No gateway call happens inside a transaction. Checkout is three phases: price
the cart, reserve stock and insert the order (tx) → `createPayment` (no tx) →
store the payment id and reconcile (tx). If the gateway call fails, a
compensating transaction releases the stock and fails the order.

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
