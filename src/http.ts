import type { Commerce } from "./commerce.ts";
import { CommerceError, type CommerceErrorCode } from "./errors.ts";
import type { Order } from "./types.ts";

/* --------------------------------------------------------------- options */

/** Why the handler answered the way it did, for your logs and alerting. */
export type WebhookErrorContext = {
  /** The payment id Mollie posted, or `""` if the body carried none. */
  paymentId: string;
  /** The status being returned. `>= 500` means Mollie will redeliver. */
  status: number;
  /** How many times `handleWebhook` ran, counting the first attempt. */
  attempts: number;
};

export type WebhookHandlerOptions = {
  /** The commerce instance whose `handleWebhook` does the work. */
  commerce: Pick<Commerce, "handleWebhook">;
  /**
   * Called after the order has been reconciled and persisted, for every
   * webhook that matched an order of yours — branch on `order.payment.state`
   * yourself. Skipped when the payment is unknown here.
   *
   * **Enqueue, do not do the work.** Mollie waits for this response and gives
   * up after a few seconds; sending an email or rendering an invoice inline is
   * how a working integration starts timing out.
   *
   * ```ts
   * onOrder: (order) => {
   *   if (order.payment.state === "paid") queue.push({ type: "order.paid", orderId: order.id });
   * }
   * ```
   *
   * A throw from here is reported to {@link onError} but still answered 2xx:
   * the order state — all this handler is responsible for — is already
   * committed, and a redelivery cannot repair your queue, it can only turn
   * every payment into a retry storm. Durability past this point is yours.
   */
  onOrder?: (order: Order) => void | Promise<void>;
  /**
   * Called for anything that went wrong, including a throw from
   * {@link onOrder}. Observe only — the status is already decided.
   *
   * ```ts
   * onError: (error, { paymentId, status }) =>
   *   log.error({ err: error, paymentId, willRetry: status >= 500 }, "mollie webhook"),
   * ```
   */
  onError?: (error: unknown, context: WebhookErrorContext) => void;
  /**
   * Extra attempts when a concurrent delivery wins the write race
   * (`version_conflict`). Mollie does deliver the same webhook twice at once.
   * Default `2`.
   */
  maxConflictRetries?: number;
};

/* --------------------------------------------------------------- handler */

/**
 * A `Request → Response` handler for the Mollie webhook, holding the parts
 * every integration has to get right identically.
 *
 * ```ts
 * export const POST = createWebhookHandler({
 *   commerce,
 *   onOrder: (order) => queue.push({ type: "payment.changed", orderId: order.id }),
 *   onError: (error, ctx) => log.error({ err: error, ...ctx }, "mollie webhook"),
 * });
 * ```
 *
 * What it encodes:
 *
 * - **The wire format.** Mollie posts `application/x-www-form-urlencoded` with
 *   a single `id` field and nothing else — no status, no signature.
 * - **No signature check, by design.** Mollie does not sign webhooks, which is
 *   why {@link Commerce.handleWebhook} re-reads the payment from the API and a
 *   forged body cannot move an order. There is deliberately nothing to verify
 *   here, so nothing to configure.
 * - **Status codes that mean what Mollie thinks they mean.** 2xx says "state
 *   absorbed, stop" and anything else says "retry". So a payment that is not
 *   ours answers 200 — a non-2xx would retry forever for an order that will
 *   never exist — while a Mollie outage or a database blip answers 503,
 *   because a redelivery is exactly the recovery you want. Answering 2xx to a
 *   transient failure is how integrations silently drop a payment.
 * - **A bounded retry on `version_conflict`,** for the duplicate concurrent
 *   delivery that only ever happens in production.
 *
 * Refund and chargeback notifications arrive on this same route carrying the
 * same payment id, and `handleWebhook` folds them in the same way: one route
 * is all Mollie needs.
 *
 * Routing, the method check, and the path stay yours. In Bun:
 * `Bun.serve({ routes: { "/mollie-webhook": { POST: handler } } })`; in Hono,
 * `app.post("/mollie-webhook", (c) => handler(c.req.raw))`; in a Next.js route
 * file, `export { handler as POST }`. For a `req`/`res` framework like Express,
 * skip this and call `commerce.handleWebhook(paymentId)` directly.
 *
 * @param options See {@link WebhookHandlerOptions}.
 * @returns A handler that never throws — every failure becomes a status.
 */
export function createWebhookHandler(
  options: WebhookHandlerOptions,
): (request: Request) => Promise<Response> {
  const { commerce, onOrder, onError, maxConflictRetries = 2 } = options;

  return async function handleMollieWebhook(request: Request): Promise<Response> {
    const paymentId = await readPaymentId(request);
    // Not Mollie, or a probe. Retrying will not conjure an id.
    if (!paymentId) return answer(200, "ignored");

    let attempts = 0;
    let lastError: unknown;

    while (attempts <= maxConflictRetries) {
      attempts += 1;
      try {
        const order = await commerce.handleWebhook(paymentId);
        if (!order) return answer(200, "unknown");

        if (onOrder) {
          try {
            await onOrder(order);
          } catch (error) {
            // The order is committed; see `onOrder`'s contract.
            report(onError, error, { paymentId, status: 200, attempts });
          }
        }
        return answer(200, "ok");
      } catch (error) {
        lastError = error;
        // A concurrent delivery wrote first. `handleWebhook` re-reads both the
        // order and the payment, so simply running it again converges.
        if (codeOf(error) === "version_conflict") continue;
        break;
      }
    }

    const status = statusFor(lastError);
    report(onError, lastError, { paymentId, status, attempts });
    return answer(status, status >= 500 ? "retry" : "ignored");
  };
}

/* --------------------------------------------------------------- helpers */

/**
 * Pulls Mollie's `id` out of the form body, tolerating a body that is not a
 * form at all — a health check or a stray GET must not become a 500.
 */
async function readPaymentId(request: Request): Promise<string> {
  try {
    const form = await request.formData();
    const id = form.get("id");
    return typeof id === "string" ? id.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Maps a failure to what we want Mollie to do about it: redeliver (5xx), or
 * stop because redelivering cannot help (2xx).
 */
function statusFor(error: unknown): number {
  switch (codeOf(error)) {
    // The order disappeared between the lookup and the write. There is no
    // state left to converge on, so a redelivery would only repeat this.
    case "order_not_found":
      return 200;
    // Transient: Mollie unreachable, storage down, or still contended after
    // our own retries. Let Mollie bring the state change back.
    case "gateway_error":
    case "storage_error":
    case "version_conflict":
      return 503;
    // A bug — a broken storage handler, or something we have no mapping for.
    // Mollie's remaining retries are then the recovery path once it is fixed.
    default:
      return 500;
  }
}

function codeOf(error: unknown): CommerceErrorCode | undefined {
  return error instanceof CommerceError ? error.code : undefined;
}

function report(
  onError: WebhookHandlerOptions["onError"],
  error: unknown,
  context: WebhookErrorContext,
): void {
  // A logger that throws must not decide the response.
  try {
    onError?.(error, context);
  } catch {
    /* ignored */
  }
}

/** Mollie ignores the body; it is here for whoever is reading the logs. */
function answer(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}
