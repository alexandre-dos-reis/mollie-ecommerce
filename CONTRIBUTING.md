# Contributing

Thanks for taking a look. This is a small library on purpose, so the most
useful contributions are bug fixes, storage adapters, and documentation.

## Getting started

```bash
bun install
bun run check     # typecheck + tests
bun run build     # bundle dist/ with tsdown, as published
bun run example   # the quickstart, against the fake gateway
```

Development runs straight off the TypeScript in `src/`; `dist/` only exists to
be published, and `prepublishOnly` rebuilds it, so there is no need to keep it
up to date while working.

## Scope

The library covers SKUs, orders, payments, refunds, and delivery state — the
minimum an ecommerce flow needs on top of Mollie. Deliberately out of scope:

- **Catalog structure** — products, option types, variant matrices, images,
  descriptions, categories, VAT breakdowns, translations. Keep them in your own
  tables and link them with `Sku.productId`; see "How these tables sit next to
  yours" in the README.
- **HTTP, frameworks, and webhook transport.** `handleWebhook(paymentId)` is
  the commerce operation; routing, signature checks, and status codes belong in
  your application.
- **Mollie features with no bearing on this lifecycle** — subscriptions,
  payment links, settlements, Connect. Use the Mollie SDK directly for those.

A feature that is really "my shop needs X" rather than "this lifecycle is
wrong" probably belongs in your application layer. Open an issue before a large
PR so we can check the fit first.

## Layout

| Path | What lives there |
| --- | --- |
| `src/commerce.ts` | the lifecycle: checkout, reconciliation, refunds, delivery |
| `src/storage-handlers.ts` | the `CommerceStorage` contract — the only way the library persists anything |
| `src/schemas.ts`, `src/storage-guards.ts` | the runtime enforcement of that contract |
| `src/conformance.ts` | `describeCommerceStorage`, published at `mollie-ecommerce/conformance` |
| `src/mollie.ts`, `src/fake-gateway.ts` | the `PaymentGateway` implementations |
| `examples/memory-storage.ts` | a complete handler implementation, published for copying |
| `test/storage/` | in-memory, SQLite and Postgres fixtures — **not shipped** |
| `tsdown.config.ts` | the two published entry points, and what stays external |

## Where the boundary is

`createCommerce` must not touch storage. It calls the `CommerceStorage`
handlers and nothing else — no transactions, no queries, no store objects. If a
change needs new persistence behavior, add or widen a handler and document its
atomicity contract, then cover it in `describeCommerceStorage`.

The adapters under `test/storage/` are fixtures, not shipped code: they exist
so the lifecycle suite can run against in-memory, SQLite and Postgres storage.
Nothing in `src/` may import them, and `bun pm pack --dry-run` should never
list them.

## Tests

`bun test` must pass, and so must `bun run typecheck`.

- **Lifecycle tests run against every storage back-end.** `test/lifecycle.test.ts`
  loops over the in-memory, SQLite and Postgres fixtures — all driven through
  the same handler contract consumers fulfil — and
  `test/handler-storage.test.ts` runs the lifecycle against
  `examples/memory-storage.ts`, with no adapter at all. Postgres runs on PGlite
  (`test/pglite-pool.ts`) — a devDependency, never a dependency of the
  library. The instance is shared and truncated per test, since booting a
  WebAssembly Postgres is slow; keep it that way.
- **The driver contract is checked by the compiler.** `test/pg-compat.test.ts`
  asserts node-postgres' `Pool` and `PoolClient` still satisfy the adapter's
  ports, so the setup documented in the README cannot silently stop compiling.
  `pg` and `@types/pg` are devDependencies for that guard alone — the adapter
  imports no driver.
- **Storage changes must satisfy the conformance suites.**
  `describeCommerceStorage` (`src/conformance.ts`) is the published contract;
  `describeDatabase` (`test/storage/conformance.ts`) covers the fixtures.
- **The contract is enforced at runtime, so it has to stay true.**
  `createCommerce` wraps storage in the internal `checkedStorage`
  unconditionally; a doc change that the schemas and guards don't match will
  fail real calls.
- **A contract change is three edits, not one.** Update the JSDoc in
  `src/storage-handlers.ts`, the zod schema in `src/schemas.ts` (the
  `satisfies` block there fails the build if a schema drifts from its type),
  and the checks in `src/storage-guards.ts` — then cover it in
  `describeCommerceStorage`. If you add a port method, add
  its contract test there — that is what keeps adapters interchangeable.
- Prefer `FakePaymentGateway` over mocks, and never hit the real Mollie API in
  tests.
- **A test must be able to fail.** `expect(typeof x).toBe("function")` and
  `expect(fn).toBeDefined()` pass whatever the code does; if what you mean is a
  type guarantee, write it as an assignment in a non-test file (see
  `test/pg-compat.ts`) and let `tsc` enforce it.

## Writing a storage implementation

Fulfil `CommerceStorage` from `src/storage-handlers.ts`, then point the
conformance suite at it:

```ts
import { describeCommerceStorage } from "mollie-ecommerce/conformance";

describeCommerceStorage("mysql", async () => {
  await reset();
  return { storage: mysqlStorage, saveSku: (sku) => catalog.save(sku) };
});
```

`examples/memory-storage.ts` is the readable reference, and
`test/storage/postgres.ts` shows the SQL shape — including the single-statement
reservation. Use `aggregateStock` wherever stock moves: repeated SKU ids must
consume their sum, or you oversell.
Adapters for other databases are welcome — in-repo if they need no extra
dependency, otherwise as your own package.

## Public API changes

Every property of the object returned by `createCommerce` is documented in both
JSDoc and the README, including its arguments and the error codes it throws.
Keep both in step, and add a `## Unreleased` entry to `CHANGELOG.md`.

## Changesets

Any change a user would notice needs a changeset — a short file recording how
the version should move and why:

```bash
bun run changeset   # pick patch/minor, write one or two sentences
```

Pre-1.0: **minor** for anything that changes the public API, **patch** for
fixes and docs. Nothing to edit in `CHANGELOG.md` or `package.json` by hand;
both are written at release time. For a change nobody needs to read about
(refactors, CI, internal tests), `bunx changeset add --empty` records that
choice explicitly.

The prompt needs a terminal. Writing the file yourself is equally valid:

```md
---
"mollie-ecommerce": patch
---

What changed, and why it matters to someone using the library.
```

## Releasing

Releases are automated, and the only manual step is merging a PR.

1. **Changesets accumulate** on `main` as PRs merge.
2. **CI runs.** If it fails, nothing else happens — the release workflow is
   triggered by CI's success on `main`, not by the push.
3. **A release PR appears** (or updates), titled `release: version packages`.
   It applies the pending changesets: one version bump, one changelog section.
4. **You merge it.** CI runs again on `main`, and this time there are no
   changesets left, so the workflow publishes to npm and pushes the `vX.Y.Z`
   tag.

Then write up the GitHub release from that version's changelog section:

```bash
gh release create "v$(node -p "require('./package.json').version")" --latest --generate-notes
```

The release PR itself shows no checks, because commits made with
`GITHUB_TOKEN` do not trigger workflows. That is fine: its contents are a
version bump and a changelog, and CI runs on `main` both before the PR is
created and after it is merged.

### npm credentials

The workflow needs one of these, or publishing fails with `ENEEDAUTH`:

- **Trusted publishing** (no secret): on npmjs.com, under the package's
  *Settings → Trusted publisher*, add this repository with workflow
  `release.yml`. GitHub's OIDC token then authenticates the publish, which is
  why the workflow requests `id-token: write`. The action picks this up on its
  own — it logs *"No NPM_TOKEN found, but OIDC is available"*.
- **Automation token**: create a *Granular access token* with the **Automation**
  setting — plain publish tokens are rejected by two-factor authentication —
  and store it as the `NPM_TOKEN` repository secret.

Either way the publish is signed with provenance, since `id-token: write` and
`NPM_CONFIG_PROVENANCE` are set.

**The first publish is the exception.** A trusted publisher is configured on an
existing package, so it cannot authenticate a package npm has never seen. Claim
the name once — by hand with your one-time password, or with an automation
token — and the workflow handles every release after that.

### Publishing by hand

Still possible, and the fallback if the workflow is wedged or the package name
has yet to be claimed. Two-factor authentication will prompt for a one-time
password:

```bash
bun run version                        # apply pending changesets
git commit -am "release: version packages"
bun run release                        # check, build, publish, tag
git push --follow-tags
```
