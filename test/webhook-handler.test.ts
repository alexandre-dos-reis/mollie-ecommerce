import { beforeEach, expect, test } from "bun:test";
import { createCommerce, type Commerce } from "../src/commerce.ts";
import { CommerceError, storageError } from "../src/errors.ts";
import { FakePaymentGateway } from "../src/fake-gateway.ts";
import { createWebhookHandler, type WebhookErrorContext } from "../src/http.ts";
import { money } from "../src/money.ts";
import type { Order } from "../src/types.ts";
import { createMemoryStorage } from "../examples/memory-storage.ts";

/**
 * The handler owns four Mollie facts: the form body, the absence of a
 * signature, the status code Mollie should act on, and the concurrent
 * duplicate delivery. Each one is a test below.
 */

let commerce: Commerce;
let gateway: FakePaymentGateway;

beforeEach(() => {
  const memory = createMemoryStorage();
  gateway = new FakePaymentGateway();
  commerce = createCommerce({ gateway, storage: memory.storage });
  memory.skus.set("mug", {
    id: "mug",
    name: "Enamel mug",
    kind: "physical",
    price: money(1250, "EUR"),
    stock: 10,
  });
});

/** Mollie's actual request: form-encoded, one field. */
function webhook(paymentId: string): Request {
  return new Request("https://shop.example/mollie-webhook", {
    method: "POST",
    body: new URLSearchParams({ id: paymentId }),
  });
}

async function paidOrder(): Promise<Order> {
  const { order } = await commerce.checkout({ items: [{ skuId: "mug" }] });
  gateway.setState(order.payment.id!, "paid");
  return order;
}

test("reconciles the payment the form body names", async () => {
  const seen: Order[] = [];
  const handler = createWebhookHandler({ commerce, onOrder: (order) => void seen.push(order) });
  const order = await paidOrder();

  const response = await handler(webhook(order.payment.id!));

  expect(response.status).toBe(200);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.id).toBe(order.id);
  expect(seen[0]!.payment.state).toBe("paid");
  expect(seen[0]!.delivery.state).toBe("ready");
  // Persisted, not just handed to the callback.
  expect((await commerce.getOrder(order.id))?.payment.state).toBe("paid");
});

test("the body is never trusted: a forged state cannot move the order", async () => {
  const handler = createWebhookHandler({ commerce });
  const { order } = await commerce.checkout({ items: [{ skuId: "mug" }] });

  const forged = new Request("https://shop.example/mollie-webhook", {
    method: "POST",
    body: new URLSearchParams({ id: order.payment.id!, status: "paid" }),
  });
  expect((await handler(forged)).status).toBe(200);

  // The gateway still says `open`, so that is what the order says.
  expect((await commerce.getOrder(order.id))?.payment.state).toBe("open");
});

test("an unknown payment is absorbed, not retried forever", async () => {
  const calls: Order[] = [];
  const handler = createWebhookHandler({ commerce, onOrder: (order) => void calls.push(order) });

  const response = await handler(webhook("tr_not_ours"));

  expect(response.status).toBe(200);
  expect(calls).toEqual([]);
});

test("a body with no usable id is ignored rather than failed", async () => {
  const handler = createWebhookHandler({ commerce });

  const empty = new Request("https://shop.example/mollie-webhook", {
    method: "POST",
    body: new URLSearchParams({ id: "  " }),
  });
  expect((await handler(empty)).status).toBe(200);

  // Not a form at all — a probe, or a GET with no body.
  const probe = new Request("https://shop.example/mollie-webhook", { method: "POST" });
  expect((await handler(probe)).status).toBe(200);
});

test("a Mollie outage answers 503 so the state change comes back", async () => {
  const order = await paidOrder();
  const errors: WebhookErrorContext[] = [];
  const handler = createWebhookHandler({
    commerce: {
      handleWebhook: () => {
        throw new CommerceError("gateway_error", "mollie unreachable");
      },
    },
    onError: (_error, context) => void errors.push(context),
  });

  const response = await handler(webhook(order.payment.id!));

  expect(response.status).toBe(503);
  expect(errors).toEqual([{ paymentId: order.payment.id!, status: 503, attempts: 1 }]);
});

test("a storage blip answers 503, but a vanished order does not", async () => {
  const handler503 = createWebhookHandler({
    commerce: { handleWebhook: () => Promise.reject(storageError.failed("connection reset")) },
  });
  expect((await handler503(webhook("tr_1"))).status).toBe(503);

  const handler200 = createWebhookHandler({
    commerce: { handleWebhook: () => Promise.reject(storageError.orderNotFound("ord_1")) },
  });
  expect((await handler200(webhook("tr_1"))).status).toBe(200);
});

test("a broken handler answers 500", async () => {
  const handler = createWebhookHandler({
    commerce: {
      handleWebhook: () => {
        throw new TypeError("undefined is not a function");
      },
    },
  });

  expect((await handler(webhook("tr_1"))).status).toBe(500);
});

test("retries a concurrent duplicate delivery, then gives up to a 503", async () => {
  const order = await paidOrder();
  let attempts = 0;
  const handler = createWebhookHandler({
    commerce: {
      handleWebhook: (paymentId) => {
        attempts += 1;
        // Lose the race twice, then win — as a duplicate delivery does.
        if (attempts < 3) return Promise.reject(storageError.versionConflict(order.id, 1, 2));
        return commerce.handleWebhook(paymentId);
      },
    },
  });

  const response = await handler(webhook(order.payment.id!));
  expect(response.status).toBe(200);
  expect(attempts).toBe(3);
  expect((await commerce.getOrder(order.id))?.payment.state).toBe("paid");

  // Contention that outlasts the retries is handed back to Mollie.
  const contexts: WebhookErrorContext[] = [];
  const stubborn = createWebhookHandler({
    commerce: { handleWebhook: () => Promise.reject(storageError.versionConflict(order.id)) },
    maxConflictRetries: 1,
    onError: (_error, context) => void contexts.push(context),
  });
  expect((await stubborn(webhook(order.payment.id!))).status).toBe(503);
  expect(contexts[0]).toEqual({ paymentId: order.payment.id!, status: 503, attempts: 2 });
});

test("a throw from onOrder is reported but still answered 2xx", async () => {
  const order = await paidOrder();
  const errors: WebhookErrorContext[] = [];
  const handler = createWebhookHandler({
    commerce,
    onOrder: () => {
      throw new Error("queue is down");
    },
    onError: (_error, context) => void errors.push(context),
  });

  const response = await handler(webhook(order.payment.id!));

  expect(response.status).toBe(200);
  expect(errors).toEqual([{ paymentId: order.payment.id!, status: 200, attempts: 1 }]);
  // The reconciliation still landed.
  expect((await commerce.getOrder(order.id))?.payment.state).toBe("paid");
});

test("a throw from onError does not decide the response", async () => {
  const handler = createWebhookHandler({
    commerce: { handleWebhook: () => Promise.reject(storageError.failed("down")) },
    onError: () => {
      throw new Error("logger exploded");
    },
  });

  expect((await handler(webhook("tr_1"))).status).toBe(503);
});

test("is idempotent across redeliveries", async () => {
  const order = await paidOrder();
  const seen: string[] = [];
  const handler = createWebhookHandler({
    commerce,
    onOrder: (updated) => void seen.push(updated.payment.state),
  });

  for (let i = 0; i < 3; i += 1) {
    expect((await handler(webhook(order.payment.id!))).status).toBe(200);
  }

  expect(seen).toEqual(["paid", "paid", "paid"]);
  const final = await commerce.getOrder(order.id);
  expect(final?.payment.state).toBe("paid");
  expect(final?.delivery.state).toBe("ready");
});
