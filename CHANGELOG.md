# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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
