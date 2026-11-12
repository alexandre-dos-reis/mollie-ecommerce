---
"mollie-ecommerce": minor
---

Add `createWebhookHandler` on a new `mollie-ecommerce/http` entry point: a
`Request → Response` handler for the Mollie webhook, holding the logic every
consumer would otherwise write identically.

It parses Mollie's form body, maps failures to the status code Mollie acts on
(2xx for a payment that is not yours, 503 for a Mollie or storage outage so the
redelivery recovers it, 500 for a bug), and retries the `version_conflict` a
concurrent duplicate delivery causes. Your side plugs in through `onOrder` —
enqueue only, Mollie is waiting — and `onError`, which receives the chosen
status so alerting can tell "Mollie will retry" from "this is on the floor".

`commerce.handleWebhook(paymentId)` is unchanged and remains the operation; the
handler is a convenience over it, on its own entry so the main one stays free of
HTTP. `req`/`res` frameworks keep calling `handleWebhook` directly.
