# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.3.0 — 2026-11-03

**Breaking.** The sellable unit is now a SKU rather than a product, because a
product has no single price or stock level and a purchasable variant does. This
removes the need to model variants at all: register one SKU per combination and
keep products, options and images in your own catalog.

### Changed

- `Product` → `Sku`, with a new optional `productId` grouping key (indexed,
  never interpreted by the library) and `ProductKind` → `SkuKind`. `kind` now
  lives per SKU, so one product can ship physically and download digitally.
- `CartItem.productId` → `skuId`; `refund({ lines })` takes `{ skuId }`;
  `OrderLine.productId` → `skuId`, plus an optional `productId` copied from the
  SKU at purchase time.
- `Database.products` → `Database.skus`; `ProductStore` → `SkuStore`;
  `ProductQuery` → `SkuQuery`, which gained a `productId` filter for listing a
  product's variants. Adapter classes follow: `InMemorySkuStore`,
  `SqliteSkuStore`, `PostgresSkuStore`.
- `StockChange.productId` → `skuId`; `StockShortage.productId` → `skuId`.
- Error codes `product_not_found` → `sku_not_found` and `product_inactive` →
  `sku_inactive`.
- Row mappers `productToRow` / `rowToProduct` → `skuToRow` / `rowToSku`;
  `ProductRow` → `SkuRow` with a `product_id` column.
- Database schema: table `products` → `skus`, with a nullable `product_id`
  column and a `skus_product_id` index.

### Migration

Rename the table and add the grouping column; existing rows need no other
change, since every other column keeps its name and meaning:

```sql
ALTER TABLE products RENAME TO skus;
ALTER TABLE skus ADD COLUMN product_id TEXT;
CREATE INDEX IF NOT EXISTS skus_product_id ON skus (product_id);
```

Stored orders need no migration: `OrderLine.productId` becomes `skuId`, and the
JSON already holds the id of the thing that was sold. If you want old orders to
read back with the new field name:

```sql
-- Postgres
UPDATE orders SET lines = replace(lines, '"productId"', '"skuId"');
```

In code, rename `productId` to `skuId` at your call sites — your existing
product ids are valid SKU ids, so nothing needs re-keying. To adopt variants,
add one SKU per combination and set `productId` on each.

## 0.2.0 — 2026-11-03

### Added

- **Postgres storage** (`mollie-ecommerce/storage/postgres`):
  `createPostgresDatabase(pool)`, `PostgresProductStore`,
  `PostgresOrderStore`, and `applyPostgresSchema`. The module imports no
  driver — you pass a connection, so anything with node-postgres' shape works
  (`query(sql, params) → { rows }` plus `connect()`). Transactions check out
  one connection and run `BEGIN`/`COMMIT` on it; a nested call joins the
  outer transaction instead of taking a second connection.
- `aggregateStock` helper, exported for storage adapters.
- README: a "Using Postgres" guide (driver install, schema and migrations,
  pool and pooler behavior, column-type rationale, conformance verification,
  operating notes) and an end-to-end "real-world shop" walkthrough covering
  checkout, webhook, redirect return, fulfillment, and reconciliation.

### Fixed

- **`reserveStock` could oversell when the same product appeared twice in one
  call.** The in-memory and SQLite adapters checked each entry against the
  full stock independently and then decremented both, so `[{mug, 2}, {mug, 2}]`
  against a stock of 3 succeeded and left −1. All adapters now aggregate
  repeated product ids via `aggregateStock`, and the conformance suite covers
  it. Checkout was never affected, since it merges cart lines first; direct
  callers of the port were.

### Changed

- `describeDatabase` now runs 18 contract tests (was 17), and the lifecycle
  suite runs against all three storage adapters. Postgres is exercised with
  [PGlite](https://pglite.dev) through a pool shim, plus a compile-time guard
  that node-postgres satisfies the adapter's ports — both devDependencies
  only.

## 0.1.0 — 2026-11-03

First release. Pre-1.0, so the public API may still change in minor versions
(see [Versioning](README.md#versioning)).

### Added

- `createCommerce({ gateway, db, ... })` — the commerce API: `checkout`,
  `syncOrder`, `handleWebhook`, `refund`, `markReady`, `markShipped`,
  `markDelivered`, `markReturned`, `cancelOrder`, `getOrder`, `findOrders`.
- Product and order model: `Product`, `Order`, `OrderLine`, `Refund`,
  `Customer`, with payment state mirroring Mollie's and a separate delivery
  state machine (`not_started → ready → shipped → delivered → returned`, plus
  `canceled`).
- `Money` as integer minor units plus currency, converted to and from Mollie's
  decimal strings at the API boundary (`money`, `add`, `subtract`, `multiply`,
  `sum`, `toMollieAmount`, `fromMollieAmount`, `formatMoney`).
- Idempotent checkout: replaying an `idempotencyKey` returns the original order
  instead of charging twice.
- Stock reservation at checkout, released exactly once when a payment is
  canceled, expires, or fails — or on `markReturned({ restock: true })`.
- `createMollieGateway({ apiKey })` over `mollie-api-typescript`, and
  `FakePaymentGateway` for tests and local development.
- Storage ports (`Database`, `ProductStore`, `OrderStore`) with optimistic
  concurrency, batched reads, atomic stock, and transactions.
- `InMemoryDatabase`, `SqliteDatabase` (`bun:sqlite`), row mappers plus
  `SCHEMA_SQL`, and `describeDatabase` — 17 contract tests to verify your own
  adapter.
