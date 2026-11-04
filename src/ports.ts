import type { Money } from "./money.ts";
import type { Customer, DeliveryState, OrderLine, PaymentState } from "./types.ts";

/* ------------------------------------------------------- shared value types */

export type StockChange = {
  skuId: string;
  quantity: number;
};

export type StockShortage = {
  skuId: string;
  requested: number;
  /** `null` when the SKU does not exist. */
  available: number | null;
};

/** Filters for {@link CommerceStorage.listOrders}. Absent fields match all. */
export type OrderQuery = {
  paymentState?: PaymentState | PaymentState[];
  deliveryState?: DeliveryState | DeliveryState[];
  customerEmail?: string;
  /** ISO timestamps, inclusive lower bound / exclusive upper bound. */
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  offset?: number;
};

/* ------------------------------------------------------------------ gateway */

/**
 * The slice of a payment provider this library needs. Mollie is the shipped
 * implementation (`createMollieGateway`); tests can pass a fake.
 */
export interface PaymentGateway {
  createPayment(input: CreatePaymentInput): Promise<PaymentSnapshot>;
  getPayment(paymentId: string): Promise<PaymentSnapshot>;
  cancelPayment(paymentId: string): Promise<PaymentSnapshot>;
  createRefund(input: CreateRefundInput): Promise<RefundSnapshot>;
}

export type CreatePaymentInput = {
  /** Store it on the payment so a provider record points back at the order. */
  orderId: string;
  description: string;
  amount: Money;
  lines: OrderLine[];
  customer?: Customer;
  redirectUrl?: string;
  cancelUrl?: string;
  webhookUrl?: string;
  idempotencyKey?: string;
};

export type GatewayPaymentState =
  | "open"
  | "pending"
  | "authorized"
  | "paid"
  | "canceled"
  | "expired"
  | "failed";

/** The provider's view of a payment, normalized. */
export type PaymentSnapshot = {
  id: string;
  state: GatewayPaymentState;
  amount: Money;
  /** Total refunded so far; absent is treated as zero. */
  amountRefunded?: Money;
  /** Where the customer pays. Only present while the payment is open. */
  checkoutUrl?: string;
};

export type CreateRefundInput = {
  paymentId: string;
  amount: Money;
  description?: string;
  idempotencyKey?: string;
};

export type RefundSnapshot = {
  id: string;
  state: "queued" | "pending" | "processing" | "refunded" | "failed" | "canceled";
  amount: Money;
};

/* -------------------------------------------------------------- small deps */

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  (prefix: string): string;
}

export const systemClock: Clock = { now: () => new Date() };

export const randomId: IdGenerator = (prefix) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
