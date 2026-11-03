# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub's advisory form](https://github.com/alexandre-dos-reis/mollie-ecommerce/security/advisories/new)
rather than a public issue. Include a description, affected versions, and a
reproduction if you have one. Expect an initial response within a few days.

## Supported versions

Pre-1.0, only the latest minor version receives fixes.

## Notes for integrators

This library handles money and order state, so a few properties are worth
knowing about when you review your own integration:

- **Webhook payloads are never trusted.** `handleWebhook(paymentId)` uses the
  id only as a lookup key and re-reads the payment from Mollie, so a forged
  webhook body cannot mark an order paid. Verifying webhook authenticity at
  your HTTP edge is still worthwhile, but it is not what protects order state.
- **Refunds are bounded** by `total − amountRefunded`, server-side, so a
  tampered client cannot over-refund.
- **Stock reservation is atomic** (`reserveStock` is all-or-nothing) and order
  writes use optimistic concurrency, so concurrent checkouts cannot oversell
  and concurrent updates cannot silently overwrite each other. A custom storage
  adapter must preserve both — run `describeDatabase` against it.
- **Your Mollie API key** is read from `MOLLIE_API_KEY` or passed explicitly;
  it is never logged. `CommerceError` details can include order and product
  ids, so treat error payloads as internal rather than returning them verbatim
  to customers.
