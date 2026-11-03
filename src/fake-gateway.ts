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
    const payment = await this.getPayment(input.paymentId);
    const stored = this.payments.get(input.paymentId)!;
    stored.amountRefunded = sum(
      [payment.amountRefunded ?? money(0, input.amount.currency), input.amount],
      input.amount.currency,
    );
    return {
      id: `re_fake${++this.counter}`,
      state: "pending",
      amount: input.amount,
    };
  }

  /** Test helper: move a payment to any gateway state. */
  setState(paymentId: string, state: GatewayPaymentState): PaymentSnapshot {
    const found = this.payments.get(paymentId);
    if (!found) throw new Error(`unknown payment ${paymentId}`);
    found.state = state;
    return { ...found };
  }
}
