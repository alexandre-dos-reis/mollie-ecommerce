import type { Money } from "./money.ts";

/* ----------------------------------------------------------------- products */

/**
 * What kind of thing is being sold. It drives one decision: whether paying for
 * it completes delivery (`digital`, `service`) or something still has to ship
 * (`physical`).
 */
export type ProductKind = "physical" | "digital" | "service";

/**
 * Mollie has no product concept, so this is ours — deliberately the minimum
 * needed to price a cart and build a payment. Anything else your shop shows
 * (images, SKUs, descriptions, VAT breakdowns, translations) belongs in your
 * own catalog, keyed by `id`.
 */
export type Product = {
  /** Your identifier. Stable: order lines keep a copy of it forever. */
  id: string;
  /** Shown to the customer, and used to build the Mollie payment description. */
  name: string;
  kind: ProductKind;
  /** Price per unit. Every product in one order must share a currency. */
  price: Money;
  /** Units available. `undefined` means unlimited — stock is never tracked. */
  stock?: number;
  /** `false` hides it from checkout. Defaults to true. */
  active?: boolean;
};

/* ------------------------------------------------------------------- orders */

/**
 * Mirrors Mollie's payment statuses, plus `created` (before the payment
 * exists) and the two refund-derived states.
 */
export type PaymentState =
  | "created"
  | "open"
  | "pending"
  | "authorized"
  | "paid"
  | "canceled"
  | "expired"
  | "failed"
  | "partially_refunded"
  | "refunded";

/** Fulfillment, tracked separately from the money. */
export type DeliveryState =
  | "not_started"
  | "ready"
  | "shipped"
  | "delivered"
  | "returned"
  | "canceled";

/** A product as it was when the order was placed. Never updated afterwards. */
export type OrderLine = {
  productId: string;
  name: string;
  kind: ProductKind;
  quantity: number;
  unitPrice: Money;
  /** `unitPrice × quantity`. */
  total: Money;
};

/** Just enough to reach the customer and localize their payment screen. */
export type Customer = {
  email?: string;
  /** Mollie locale, e.g. `nl_NL`. Passed through to the payment. */
  locale?: string;
};

export type Refund = {
  /** Mollie's refund id. */
  id: string;
  amount: Money;
  /** Forwarded to Mollie as the refund description. */
  reason?: string;
  state: "queued" | "pending" | "processing" | "refunded" | "failed" | "canceled";
  createdAt: string;
};

export type Order = {
  id: string;
  /**
   * Incremented on every write. Pass the version you read back to
   * `OrderStore.update` so concurrent writers collide instead of overwriting.
   */
  version: number;
  /** Set when checkout was called with a key; unique per order. */
  idempotencyKey?: string;
  lines: OrderLine[];
  /** Sum of the line totals. */
  total: Money;
  customer?: Customer;
  payment: {
    state: PaymentState;
    /** Mollie payment id. Absent only between order creation and the API call. */
    id?: string;
    /** Where to send the customer to pay. */
    checkoutUrl?: string;
    /** Refunded so far; drives `partially_refunded` / `refunded`. */
    amountRefunded: Money;
  };
  /** True while this order holds a stock reservation. */
  stockReserved: boolean;
  delivery: {
    state: DeliveryState;
    carrier?: string;
    trackingCode?: string;
  };
  refunds: Refund[];
  createdAt: string;
  /** Touched on every change, including payment and delivery transitions. */
  updatedAt: string;
};

/** True once the money has arrived, including after partial refunds. */
export function isPaid(order: Order): boolean {
  return (
    order.payment.state === "paid" ||
    order.payment.state === "partially_refunded" ||
    order.payment.state === "refunded"
  );
}

/** How much of the order can still be refunded. Zero for unpaid orders. */
export function refundableAmount(order: Order): Money {
  return {
    cents: isPaid(order) ? order.total.cents - order.payment.amountRefunded.cents : 0,
    currency: order.total.currency,
  };
}
