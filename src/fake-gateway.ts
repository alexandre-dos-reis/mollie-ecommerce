import { money, sum } from "./money.ts";
import type {
  CreatePaymentInput,
  CreateRefundInput,
  GatewayPaymentState,
  PaymentGateway,
  PaymentSnapshot,
  RefundSnapshot,
} from "./ports.ts";

/**
 * An in-memory stand-in for Mollie: useful in tests and local development,
 * where you want to drive a payment to `paid` without leaving the process.
 */
export class FakePaymentGateway implements PaymentGateway {
  readonly payments = new Map<string, PaymentSnapshot>();
  /** Refunds per payment, in creation order, as the provider would hold them. */
  readonly refunds = new Map<string, RefundSnapshot[]>();
  private counter = 0;
  private nextCreateError?: Error;

  /** Test helper: make the next createPayment call blow up. */
  failNextCreate(error: Error): void {
    this.nextCreateError = error;
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentSnapshot> {
    if (this.nextCreateError) {
      const error = this.nextCreateError;
      this.nextCreateError = undefined;
      throw error;
    }

    const id = `tr_fake${++this.counter}`;
    const snapshot: PaymentSnapshot = {
      id,
      state: "open",
      amount: input.amount,
      amountRefunded: money(0, input.amount.currency),
      checkoutUrl: `https://pay.example.test/${id}`,
    };
    this.payments.set(id, snapshot);
    return { ...snapshot };
  }

  async getPayment(paymentId: string): Promise<PaymentSnapshot> {
    const found = this.payments.get(paymentId);
    if (!found) throw new Error(`unknown payment ${paymentId}`);
    return { ...found };
  }

  async cancelPayment(paymentId: string): Promise<PaymentSnapshot> {
    return this.setState(paymentId, "canceled");
  }

  async createRefund(input: CreateRefundInput): Promise<RefundSnapshot> {
    await this.getPayment(input.paymentId);

    // `amountRefunded` is deliberately *not* moved here: Mollie counts a
    // refund in it only once executed, which is what `settleRefund` stands
    // for. Moving it at creation would hide the window this fake exists to
    // reproduce.
    const refund: RefundSnapshot = {
      id: `re_fake${++this.counter}`,
      state: "pending",
      amount: input.amount,
    };

    this.refunds.set(input.paymentId, [...(this.refunds.get(input.paymentId) ?? []), refund]);

    return { ...refund };
  }

  async listRefunds(paymentId: string): Promise<RefundSnapshot[]> {
    return (this.refunds.get(paymentId) ?? []).map((refund) => ({ ...refund }));
  }

  /**
   * Test helper: move a refund to any state, the way the provider does hours
   * after accepting it. Settling one (`refunded`) also moves the payment's
   * `amountRefunded`, since that is when the money actually leaves.
   */
  settleRefund(paymentId: string, refundId: string, state: RefundSnapshot["state"]): void {
    const refunds = this.refunds.get(paymentId) ?? [];
    const refund = refunds.find((candidate) => candidate.id === refundId);
    if (!refund) throw new Error(`unknown refund ${refundId}`);

    const wasRefunded = refund.state === "refunded";
    refund.state = state;

    if (state !== "refunded" || wasRefunded) return;

    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error(`unknown payment ${paymentId}`);

    payment.amountRefunded = sum(
      [payment.amountRefunded ?? money(0, refund.amount.currency), refund.amount],
      refund.amount.currency,
    );
  }

  /** Test helper: move a payment to any gateway state. */
  setState(paymentId: string, state: GatewayPaymentState): PaymentSnapshot {
    const found = this.payments.get(paymentId);
    if (!found) throw new Error(`unknown payment ${paymentId}`);
    found.state = state;
    return { ...found };
  }
}
