import { assertTransition } from "./delivery.ts";
import { CommerceError } from "./errors.ts";
import { money, multiply, subtract, sum } from "./money.ts";
import type { Money } from "./money.ts";
import {
  randomId,
  systemClock,
  type Clock,
  type IdGenerator,
  type OrderQuery,
  type PaymentGateway,
  type PaymentSnapshot,
  type StockChange,
} from "./ports.ts";
import type { CommerceStorage, OrderMutation } from "./storage-handlers.ts";
import { withStorageErrorHandler, type StorageErrorHandler } from "./storage-guards.ts";
import {
  isPaid,
  refundableAmount,
  type Customer,
  type DeliveryState,
  type Order,
  type OrderLine,
  type PaymentState,
  type Refund,
  type Sku,
} from "./types.ts";

/* ---------------------------------------------------------------- options */

export type CommerceOptions = {
  /**
   * Payment provider. `createMollieGateway()` for production,
   * `new FakePaymentGateway()` for tests and local development.
   */
  gateway: PaymentGateway;
  /**
   * The storage handlers to fulfil. See {@link CommerceStorage} — seven
   * functions, with no transactions or queries on this side of the boundary.
   *
   * Wrap it in `checkedStorage` to have every argument and return value
   * validated against the contract.
   */
  storage: CommerceStorage;
  /**
   * Called when a storage handler throws, before the error reaches your
   * caller. Return a {@link CommerceError} to translate it, return nothing to
   * just observe it, or throw your own.
   *
   * ```ts
   * onStorageError: (error, { handler, orderId }) => {
   *   log.error({ err: error, handler, orderId }, "storage failed");
   *   if (isDeadlock(error)) return new CommerceError("version_conflict", "retry", { orderId });
   * }
   * ```
   */
  onStorageError?: StorageErrorHandler;
  /**
   * Where Mollie returns the customer after paying. Required by Mollie for
   * most payment methods; override per checkout if it varies.
   */
  redirectUrl?: string;
  /** Where Mollie returns the customer if they abandon the payment. */
  cancelUrl?: string;
  /**
   * Public URL Mollie posts status changes to. Without it you get no status
   * updates and must poll {@link Commerce.syncOrder} yourself. Cannot be
   * `localhost`.
   */
  webhookUrl?: string;
  /**
   * Move delivery straight to `delivered` when an order with no physical lines
   * is paid. Default `true`.
   */
  autoDeliverDigital?: boolean;
  /**
   * Decrement SKU stock at checkout and give it back if the payment dies.
   * Default `true`. Set `false` if you track stock elsewhere.
   */
  reserveStock?: boolean;
  /** Override the clock, e.g. to freeze timestamps in tests. */
  clock?: Clock;
  /** Override id generation. Receives a prefix such as `"ord"`. */
  generateId?: IdGenerator;
};

/* ----------------------------------------------------------------- inputs */

export type CartItem = {
  /** The SKU being bought — one purchasable variant. */
  skuId: string;
  /** Defaults to 1. Repeated SKUs are merged into one line. */
  quantity?: number;
};

export type CheckoutInput = {
  /** At least one item. Prices, stock, and currency are validated. */
  items: CartItem[];
  customer?: Customer;
  /**
   * Payment description shown on the customer's statement. Defaults to a
   * generated summary; Mollie truncates it per payment method.
   */
  description?: string;
  /** Overrides {@link CommerceOptions.redirectUrl} for this order. */
  redirectUrl?: string;
  /** Overrides {@link CommerceOptions.cancelUrl} for this order. */
  cancelUrl?: string;
  /** Overrides {@link CommerceOptions.webhookUrl} for this order. */
  webhookUrl?: string;
  /**
   * Makes checkout replay-safe: calling again with the same key returns the
   * original order instead of charging twice. Also sent to Mollie.
   */
  idempotencyKey?: string;
};

export type CheckoutResult = {
  order: Order;
  /** Redirect the customer here to pay. Absent only if Mollie returns none. */
  checkoutUrl?: string;
  /** True when an existing order was returned for a repeated idempotency key. */
  replayed: boolean;
};

export type RefundInput = {
  orderId: string;
  /**
   * Exact amount to refund. Mutually exclusive with `lines`; omit both to
   * refund everything still refundable.
   */
  amount?: Money;
  /**
   * Refund by order line instead of by amount. Quantity defaults to the whole
   * line. Only the money is affected — stock is not restored.
   */
  lines?: { skuId: string; quantity?: number }[];
  /** Forwarded to Mollie as the refund description, and stored on the order. */
  reason?: string;
  /** Prevents a retried request from refunding twice. */
  idempotencyKey?: string;
};

export type RefundResult = {
  /** The order after the refund was applied. */
  order: Order;
  /** The refund that was just created. */
  refund: Refund;
};

export type ShipInput = {
  orderId: string;
  carrier?: string;
  trackingCode?: string;
};

export type ReturnInput = {
  orderId: string;
  /** Put the goods back into stock. Does not move money — refund separately. */
  restock?: boolean;
};

/* ---------------------------------------------------------------- service */

/**
 * Builds the commerce API: checkout, payment reconciliation, refunds, and the
 * delivery lifecycle, over any storage and any payment gateway.
 *
 * ```ts
 * const commerce = createCommerce({
 *   gateway: createMollieGateway({ apiKey: process.env.MOLLIE_API_KEY }),
 *   db: new SqliteDatabase({ filename: "./shop.sqlite" }),
 *   redirectUrl: "https://shop.example/thanks",
 *   webhookUrl: "https://shop.example/mollie-webhook",
 * });
 * ```
 *
 * Every method throws {@link CommerceError} with a machine-readable `code`.
 * No gateway call happens inside a storage write handler, so the transactions
 * you open there stay short.
 */
export function createCommerce(options: CommerceOptions) {
  const {
    gateway,
    clock = systemClock,
    generateId = randomId,
    autoDeliverDigital = true,
    reserveStock: shouldReserveStock = true,
  } = options;

  const storage = options.onStorageError
    ? withStorageErrorHandler(options.storage, options.onStorageError)
    : options.storage;
  const now = () => clock.now().toISOString();

  /* ------------------------------------------------------------- internals */

  /**
   * Every write to an existing order goes through here: the handler decides
   * atomicity, this side only describes the change.
   */
  function mutate(
    orderId: string,
    apply: (order: Order) => OrderMutation | void,
  ): Promise<Order> {
    return storage.mutateOrder(orderId, (order) => {
      const mutation = apply(order);
      order.updatedAt = now();
      return mutation ?? {};
    });
  }

  function stockChanges(order: Order): StockChange[] {
    return order.lines.map((line) => ({
      skuId: line.skuId,
      quantity: line.quantity,
    }));
  }

  /** Give stock back exactly once, whoever triggers it. */
  function releaseReservation(order: Order): StockChange[] {
    if (!order.stockReserved) return [];
    order.stockReserved = false;
    return stockChanges(order);
  }

  /**
   * Mutates `order` to reflect a gateway snapshot, including knock-on effects,
   * and reports any stock the storage handler should give back.
   */
  function reconcile(order: Order, snapshot: PaymentSnapshot): OrderMutation {
    const wasPaid = isPaid(order);
    order.payment.state = derivePaymentState(snapshot, order.total);
    if (snapshot.amountRefunded) order.payment.amountRefunded = snapshot.amountRefunded;
    if (snapshot.checkoutUrl) order.payment.checkoutUrl = snapshot.checkoutUrl;

    if (!wasPaid && isPaid(order) && order.delivery.state === "not_started") {
      order.delivery.state = "ready";
      const allDigital = order.lines.every((line) => line.kind !== "physical");
      if (autoDeliverDigital && allDigital) order.delivery.state = "delivered";
    }

    if (DEAD_PAYMENT_STATES.includes(order.payment.state)) {
      const releaseStock = releaseReservation(order);
      if (order.delivery.state === "not_started") order.delivery.state = "canceled";
      return { releaseStock };
    }

    return {};
  }

  async function mustGetOrder(orderId: string): Promise<Order> {
    const order = await storage.findOrder(orderId);
    if (!order) {
      throw new CommerceError("order_not_found", `no order ${orderId}`, { orderId });
    }
    return order;
  }

  /** Merges repeated SKUs, so a cart is one batched read and one line each. */
  function cartQuantities(items: CartItem[]): Map<string, number> {
    if (items.length === 0) {
      throw new CommerceError("empty_cart", "checkout needs at least one item");
    }
    const quantities = new Map<string, number>();
    for (const item of items) {
      const quantity = item.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new CommerceError("empty_cart", `invalid quantity ${quantity}`, { item });
      }
      quantities.set(item.skuId, (quantities.get(item.skuId) ?? 0) + quantity);
    }
    return quantities;
  }

  function priceCart(skus: Sku[], quantities: Map<string, number>): OrderLine[] {
    const byId = new Map(skus.map((sku) => [sku.id, sku]));

    const lines: OrderLine[] = [];
    for (const [skuId, quantity] of quantities) {
      const sku = byId.get(skuId);
      if (!sku) {
        throw new CommerceError("sku_not_found", `no sku ${skuId}`, { skuId });
      }
      if (sku.active === false) {
        throw new CommerceError("sku_inactive", `sku ${sku.id} is inactive`, { skuId: sku.id });
      }
      lines.push(lineFromSku(sku, quantity));
    }

    const currency = lines[0]!.unitPrice.currency;
    const mixed = lines.find((line) => line.unitPrice.currency !== currency);
    if (mixed) {
      throw new CommerceError(
        "currency_mismatch",
        "every SKU in an order must share one currency",
        { expected: currency, found: mixed.unitPrice.currency },
      );
    }

    return lines;
  }

  /* ------------------------------------------------------------- checkout */

  async function checkout(input: CheckoutInput): Promise<CheckoutResult> {
    if (input.idempotencyKey) {
      const existing = await storage.findOrderByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return { order: existing, checkoutUrl: existing.payment.checkoutUrl, replayed: true };
      }
    }

    // Phase 1: price the cart, then hand the order and its stock to one write
    // handler — which is where they are made atomic.
    const quantities = cartQuantities(input.items);
    const lines = priceCart(await storage.loadSkus([...quantities.keys()]), quantities);
    const total = sum(lines.map((line) => line.total));
    const reserveStock = shouldReserveStock
      ? lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity }))
      : [];

    const createdAt = now();
    const created = await storage.createOrder({
      reserveStock,
      order: {
        id: generateId("ord"),
        version: 0,
        idempotencyKey: input.idempotencyKey,
        lines,
        total,
        customer: input.customer,
        payment: { state: "created", amountRefunded: money(0, total.currency) },
        stockReserved: reserveStock.length > 0,
        delivery: { state: "not_started" },
        refunds: [],
        createdAt,
        updatedAt: createdAt,
      },
    });

    if (created.status === "out_of_stock") {
      const first = created.shortages[0];
      throw new CommerceError(
        "out_of_stock",
        first ? `sku ${first.skuId} is out of stock` : "out of stock",
        { shortages: created.shortages },
      );
    }
    const draft = created.order;

    // Phase 2: the gateway call, outside any transaction.
    let snapshot: PaymentSnapshot;
    try {
      snapshot = await gateway.createPayment({
        orderId: draft.id,
        description: input.description ?? describeOrder(draft),
        amount: draft.total,
        lines: draft.lines,
        customer: input.customer,
        redirectUrl: input.redirectUrl ?? options.redirectUrl,
        cancelUrl: input.cancelUrl ?? options.cancelUrl,
        webhookUrl: input.webhookUrl ?? options.webhookUrl,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      // Don't sit on stock for an order that can never be paid.
      await mutate(draft.id, (order) => {
        order.payment.state = "failed";
        const releaseStock = releaseReservation(order);
        if (order.delivery.state === "not_started") order.delivery.state = "canceled";
        return { releaseStock };
      });
      throw error;
    }

    // Phase 3: record what the gateway told us.
    const order = await mutate(draft.id, (current) => {
      current.payment.id = snapshot.id;
      current.payment.checkoutUrl = snapshot.checkoutUrl;
      return reconcile(current, snapshot);
    });

    return { order, checkoutUrl: order.payment.checkoutUrl, replayed: false };
  }

  /* ----------------------------------------------------------------- sync */

  async function syncOrder(orderId: string): Promise<Order> {
    const order = await mustGetOrder(orderId);
    if (!order.payment.id) return order;

    const snapshot = await gateway.getPayment(order.payment.id);
    return mutate(orderId, (current) => reconcile(current, snapshot));
  }

  async function handleWebhook(paymentId: string): Promise<Order | null> {
    const known = await storage.findOrderByPaymentId(paymentId);
    if (!known) return null;

    const snapshot = await gateway.getPayment(paymentId);
    return mutate(known.id, (current) => reconcile(current, snapshot));
  }

  /* --------------------------------------------------------------- refund */

  async function refund(input: RefundInput): Promise<RefundResult> {
    // Validate against freshly read state, call the gateway, then persist
    // through the write handler.
    const order = await mustGetOrder(input.orderId);
    if (!isPaid(order) || !order.payment.id) {
      throw new CommerceError("not_refundable", `order ${order.id} is not paid`, {
        orderId: order.id,
        state: order.payment.state,
      });
    }

    const refundable = refundableAmount(order);
    const amount =
      input.amount ?? (input.lines ? amountForLines(order, input.lines) : refundable);

    if (amount.currency !== order.total.currency) {
      throw new CommerceError("currency_mismatch", "refund currency differs from order", {
        orderId: order.id,
        expected: order.total.currency,
        found: amount.currency,
      });
    }
    if (amount.cents <= 0) {
      throw new CommerceError("not_refundable", "refund amount must be positive", { amount });
    }
    if (amount.cents > refundable.cents) {
      throw new CommerceError(
        "refund_too_large",
        `can refund at most ${refundable.cents} minor units`,
        { orderId: order.id, requested: amount.cents, refundable: refundable.cents },
      );
    }

    const snapshot = await gateway.createRefund({
      paymentId: order.payment.id,
      amount,
      description: input.reason,
      idempotencyKey: input.idempotencyKey,
    });

    const record: Refund = {
      id: snapshot.id,
      amount: snapshot.amount,
      reason: input.reason,
      state: snapshot.state,
      createdAt: now(),
    };

    const saved = await mutate(order.id, (current) => {
      current.refunds.push(record);

      if (record.state !== "failed" && record.state !== "canceled") {
        current.payment.amountRefunded = sum(
          [current.payment.amountRefunded, record.amount],
          current.total.currency,
        );
        current.payment.state =
          current.payment.amountRefunded.cents >= current.total.cents
            ? "refunded"
            : "partially_refunded";
      }
    });

    return { order: saved, refund: record };
  }

  /* ------------------------------------------------------------- delivery */

  function transition(state: DeliveryState) {
    return (orderId: string) =>
      mutate(orderId, (order) => {
        assertTransition(order.delivery.state, state);
        order.delivery.state = state;
      });
  }

  async function markShipped(input: ShipInput): Promise<Order> {
    return mutate(input.orderId, (order) => {
      assertTransition(order.delivery.state, "shipped");
      order.delivery.state = "shipped";
      order.delivery.carrier = input.carrier ?? order.delivery.carrier;
      order.delivery.trackingCode = input.trackingCode ?? order.delivery.trackingCode;
    });
  }

  async function markReturned(input: ReturnInput): Promise<Order> {
    return mutate(input.orderId, (order) => {
      assertTransition(order.delivery.state, "returned");
      order.delivery.state = "returned";
      // Returning the goods to stock is part of the same atomic write.
      return input.restock ? { releaseStock: stockChanges(order) } : {};
    });
  }

  async function cancelOrder(orderId: string): Promise<Order> {
    const order = await mustGetOrder(orderId);
    if (isPaid(order)) {
      throw new CommerceError(
        "not_payable",
        `order ${order.id} is already paid — refund it instead`,
        { orderId: order.id },
      );
    }

    const snapshot = order.payment.id ? await gateway.cancelPayment(order.payment.id) : undefined;
    return mutate(orderId, (current) => {
      const mutation = snapshot
        ? reconcile(current, snapshot)
        : ((current.payment.state = "canceled"),
          { releaseStock: releaseReservation(current) });
      if (current.delivery.state === "not_started") current.delivery.state = "canceled";
      return mutation;
    });
  }

  return {
    /**
     * Starts an order: prices the cart from the catalog, reserves stock, and
     * creates a Mollie payment. Send the customer to `checkoutUrl`.
     *
     * The order is persisted before the payment is created, so a gateway
     * failure leaves a `failed` order rather than a lost cart — and its stock
     * reservation is released.
     *
     * @param input.items Cart items; `[{ skuId, quantity? }]`, quantity defaults to 1.
     * @param input.customer Optional `{ email?, locale? }`.
     * @param input.description Payment description; defaults to a generated summary.
     * @param input.redirectUrl Overrides the configured redirect URL.
     * @param input.cancelUrl Overrides the configured cancel URL.
     * @param input.webhookUrl Overrides the configured webhook URL.
     * @param input.idempotencyKey Replaying this key returns the first order instead of charging again.
     * @returns `{ order, checkoutUrl, replayed }`.
     * @throws `empty_cart` no items, or a quantity below 1.
     * @throws `sku_not_found` an item references an unknown SKU.
     * @throws `sku_inactive` a SKU has `active: false`.
     * @throws `out_of_stock` insufficient stock; nothing is reserved.
     * @throws `currency_mismatch` the cart mixes currencies.
     */
    checkout,

    /**
     * Re-reads the payment from Mollie and folds it into the order: payment
     * state, refunded amount, and the delivery/stock consequences. Idempotent.
     *
     * Use it when you cannot receive webhooks, when the customer returns to
     * your redirect URL, or to reconcile on a schedule.
     *
     * @param orderId The order to refresh.
     * @returns The updated order; unchanged if no payment exists yet.
     * @throws `order_not_found` no such order.
     * @throws `gateway_error` Mollie could not be reached.
     */
    syncOrder,

    /**
     * Handles a Mollie webhook, which carries only a payment id and no status.
     * Looks the order up, then does the same work as {@link syncOrder}.
     *
     * Respond 2xx even for `null`: a non-2xx makes Mollie retry a payment you
     * will never recognize.
     *
     * @param paymentId The `id` Mollie posted (`tr_...`).
     * @returns The updated order, or `null` if the payment is unknown here.
     */
    handleWebhook,

    /**
     * Refunds a paid order, in full, by amount, or by line. Mollie usually
     * reports refunds as `pending`; {@link syncOrder} reconciles the final
     * state. Does not restock — see {@link markReturned}.
     *
     * @param input.orderId The order to refund.
     * @param input.amount Exact amount; mutually exclusive with `lines`.
     * @param input.lines Lines to refund as `[{ skuId, quantity? }]`; quantity defaults to the whole line.
     * @param input.reason Refund description, forwarded to Mollie.
     * @param input.idempotencyKey Prevents a retry from refunding twice.
     * @returns `{ order, refund }`.
     * @throws `order_not_found` no such order.
     * @throws `not_refundable` the order is not paid, or the amount is not positive.
     * @throws `refund_too_large` more than `total − amountRefunded`, or more units than the line holds.
     * @throws `currency_mismatch` the amount's currency is not the order's.
     */
    refund,

    /**
     * Marks the order ready to fulfil. Paying already does this, so you only
     * need it when `reserveStock`/payment flows are bypassed.
     *
     * @param orderId The order to advance.
     * @returns The updated order.
     * @throws `invalid_delivery_transition` not reachable from the current state.
     */
    markReady: transition("ready"),

    /**
     * Marks the order shipped and records the carrier and tracking code.
     *
     * @param input.orderId The order being shipped.
     * @param input.carrier Carrier name, e.g. `"PostNL"`. Keeps the existing value if omitted.
     * @param input.trackingCode Tracking code. Keeps the existing value if omitted.
     * @returns The updated order.
     * @throws `invalid_delivery_transition` the order is not `ready`.
     */
    markShipped,

    /**
     * Marks the order delivered. Digital-only orders reach this automatically
     * when paid, unless `autoDeliverDigital` is off.
     *
     * @param orderId The delivered order.
     * @returns The updated order.
     * @throws `invalid_delivery_transition` the order is not `ready` or `shipped`.
     */
    markDelivered: transition("delivered"),

    /**
     * Records a return. Moves no money — call {@link refund} for that.
     *
     * @param input.orderId The returned order.
     * @param input.restock `true` to put the goods back into stock.
     * @returns The updated order.
     * @throws `invalid_delivery_transition` the order was never shipped or delivered.
     */
    markReturned,

    /**
     * Cancels an unpaid order: cancels the Mollie payment when it is still
     * cancelable, releases the stock, and cancels the delivery.
     *
     * @param orderId The order to cancel.
     * @returns The updated order.
     * @throws `order_not_found` no such order.
     * @throws `not_payable` the order is already paid — refund it instead.
     */
    cancelOrder,

    /**
     * Reads one order, including its lines, refunds, and both state machines.
     *
     * @param orderId The order to read.
     * @returns The order, or `null` if it does not exist.
     */
    getOrder: (orderId: string) => storage.findOrder(orderId),

    /**
     * Lists orders, newest-created last.
     *
     * @param query Optional filters: `paymentState`, `deliveryState`,
     * `customerEmail`, `createdAfter`, `createdBefore`, `limit`, `offset`.
     * State filters accept one value or an array.
     * @returns Matching orders.
     */
    findOrders: (query?: OrderQuery) => storage.listOrders(query),

    /**
     * The storage handlers in use, as resolved from `storage` or `db`. Exposed
     * for wrapping and testing; catalog writes go to your own storage, not
     * through here.
     */
    storage,
  };
}

export type Commerce = ReturnType<typeof createCommerce>;


/** Payment states after which no money will move, so stock can be released. */
const DEAD_PAYMENT_STATES: readonly PaymentState[] = ["canceled", "expired", "failed"];

/* ---------------------------------------------------------------- helpers */

/** Freezes a catalog SKU into an order line at the given quantity. */
export function lineFromSku(sku: Sku, quantity: number): OrderLine {
  return {
    skuId: sku.id,
    name: sku.name,
    kind: sku.kind,
    quantity,
    unitPrice: sku.price,
    total: multiply(sku.price, quantity),
    productId: sku.productId,
  };
}

/** Default payment description. Mollie truncates, so keep it identifiable. */
export function describeOrder(order: Order): string {
  const first = order.lines[0];
  if (!first) return `Order ${order.id}`;
  const rest = order.lines.length - 1;
  const items = rest > 0 ? ` + ${rest} more` : "";
  return `Order ${order.id}: ${first.quantity}× ${first.name}${items}`;
}

function amountForLines(
  order: Order,
  lines: { skuId: string; quantity?: number }[],
): Money {
  const amounts = lines.map((wanted) => {
    const line = order.lines.find((candidate) => candidate.skuId === wanted.skuId);
    if (!line) {
      throw new CommerceError("sku_not_found", `order has no line for ${wanted.skuId}`, {
        orderId: order.id,
        skuId: wanted.skuId,
      });
    }
    const quantity = wanted.quantity ?? line.quantity;
    if (quantity > line.quantity) {
      throw new CommerceError(
        "refund_too_large",
        `order has ${line.quantity}× ${wanted.skuId}, cannot refund ${quantity}`,
        { orderId: order.id, skuId: wanted.skuId },
      );
    }
    return multiply(line.unitPrice, quantity);
  });
  return sum(amounts, order.total.currency);
}

/** Mollie reports refunds on the payment, so `paid` can mean partly refunded. */
function derivePaymentState(snapshot: PaymentSnapshot, total: Money): PaymentState {
  if (snapshot.state !== "paid") return snapshot.state;
  const refunded = snapshot.amountRefunded?.cents ?? 0;
  if (refunded <= 0) return "paid";
  return subtract(total, snapshot.amountRefunded!).cents <= 0 ? "refunded" : "partially_refunded";
}
