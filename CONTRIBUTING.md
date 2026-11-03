# Contributing

Thanks for taking a look. This is a small library on purpose, so the most
useful contributions are bug fixes, storage adapters, and documentation.

## Getting started

```bash
bun install
bun run check     # typecheck + tests
bun run example   # the quickstart, against the fake gateway
```

There is nothing to build: the package ships TypeScript sources and targets
Bun, which resolves them directly.

## Scope

The library covers products, orders, payments, refunds, and delivery state —
the minimum an ecommerce flow needs on top of Mollie. Deliberately out of
scope:

- **Catalog concerns** — images, SKUs, descriptions, categories, VAT
  breakdowns, translations. Keep them in your own catalog, keyed by product
  `id`.
- **HTTP, frameworks, and webhook transport.** `handleWebhook(paymentId)` is
  the commerce operation; routing, signature checks, and status codes belong in
  your application.
- **Mollie features with no bearing on this lifecycle** — subscriptions,
  payment links, settlements, Connect. Use the Mollie SDK directly for those.

A feature that is really "my shop needs X" rather than "this lifecycle is
wrong" probably belongs in your application layer. Open an issue before a large
PR so we can check the fit first.

## Tests

`bun test` must pass, and so must `bun run typecheck`.

- **Lifecycle tests run against every storage adapter.** `src/commerce.test.ts`
  loops over `InMemoryDatabase` and `SqliteDatabase`; a change that only works
  on one of them will fail.
- **Storage changes must satisfy the conformance suite.** `describeDatabase` in
  `src/storage/conformance.ts` is the contract. If you add a port method, add
  its contract test there — that is what keeps adapters interchangeable.
- Prefer `FakePaymentGateway` over mocks, and never hit the real Mollie API in
  tests.

## Writing a storage adapter

Implement `Database` from `src/ports.ts`, then point the conformance suite at
it:

```ts
import { describeDatabase } from "mollie-ecommerce/storage/conformance";
describeDatabase("postgres", () => new PostgresDatabase({ url: process.env.DATABASE_URL }));
```

`src/storage/sqlite.ts` is the worked example, and `SCHEMA_SQL` plus the row
mappers in `src/storage/rows.ts` do most of the mapping for SQL engines.
Adapters for other databases are welcome — in-repo if they need no extra
dependency, otherwise as your own package.

## Public API changes

Every property of the object returned by `createCommerce` is documented in both
JSDoc and the README, including its arguments and the error codes it throws.
Keep both in step, and add a `## Unreleased` entry to `CHANGELOG.md`.

## Releasing

Maintainers, from a green `main`:

1. Move the `## Unreleased` entries under a new `## x.y.z — YYYY-MM-DD` heading.
2. Bump `version` in `package.json` following [semver](https://semver.org) —
   while pre-1.0, breaking changes go in the **minor** slot.
3. Commit as `release: vx.y.z`, then `git tag -a vx.y.z -m "vx.y.z"`.
4. `git push origin main --follow-tags`, and publish the GitHub release with the
   changelog section as its notes.
