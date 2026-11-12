---
"mollie-ecommerce": minor
---

Settle refund states through `syncOrder` and `handleWebhook`.

A refund was written once, with the state Mollie answers at creation --
`pending` -- and never read again. Nothing could move it to `refunded` or
`failed`: `reconcile` only ever touched the payment, and a payment snapshot
carries the refunded *total*, never the individual states. Shops saw a refund
sit at "pending" forever while Mollie showed it paid out, which is exactly the
disagreement the library exists to prevent. The docs already claimed `syncOrder`
reconciled the final state; now it does.

`PaymentGateway` gains an optional `listRefunds(paymentId)`, implemented for
Mollie over `client.refunds.list` and read back only while the order still holds
a refund that is not final -- so the common sync costs no extra call. A gateway
that does not implement it keeps the old behaviour. A refund created outside the
library, from the Mollie dashboard, now appears on the order instead of being
invisible.

The same pass fixes an accounting hole it would otherwise have opened: Mollie
counts a refund in `amountRefunded` only once *executed*, so a sync landing in
the hours between acceptance and execution used to reset the order to `paid`
with zero refunded -- money owed to the customer, and no trace of it on the
order. The order now counts what its own refunds commit, and only a `failed` or
`canceled` refund gives that money back.

`FakePaymentGateway` grows `settleRefund(paymentId, refundId, state)` so the
window between acceptance and execution can be driven in tests.
