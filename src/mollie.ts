import { Client as MollieClient } from "mollie-api-typescript";
import type { Locale2 } from "mollie-api-typescript/models/locale2.js";
import { CommerceError } from "./errors.ts";
import { fromMollieAmount, money, toMollieAmount } from "./money.ts";
import type {
  CreatePaymentInput,
  CreateRefundInput,
  GatewayPaymentState,
  PaymentGateway,
  PaymentSnapshot,
  RefundSnapshot,
} from "./ports.ts";
import type { OrderLine } from "./types.ts";

export type MollieGatewayOptions = {
  /** An existing SDK client, or pass `apiKey` and we build one. */
  client?: MollieClient;
  apiKey?: string;
  /** Mollie truncates per method; 255 is the absolute maximum. */
  maxDescriptionLength?: number;
  /** Send order lines along with the payment (required for Klarna, in3, …). */
  sendLines?: boolean;
};

/** Mollie's `PaymentLineType` values we map onto. */
const LINE_TYPE = {
  physical: "physical",
  digital: "digital",
  service: "digital",
} as const;

export function createMollieGateway(options: MollieGatewayOptions = {}): PaymentGateway {
  const client =
    options.client ??
    new MollieClient({
      security: { apiKey: options.apiKey ?? process.env.MOLLIE_API_KEY ?? "" },
    });
  const maxDescription = options.maxDescriptionLength ?? 255;
  const sendLines = options.sendLines ?? true;

  async function guard<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      throw new CommerceError("gateway_error", `mollie ${what} failed: ${describe(cause)}`, {
        cause,
      });
    }
  }

  return {
    async createPayment(input: CreatePaymentInput): Promise<PaymentSnapshot> {
      const payment = await guard("createPayment", () =>
        client.payments.create({
          idempotencyKey: input.idempotencyKey,
          paymentRequest: {
            description: input.description.slice(0, maxDescription),
            amount: toMollieAmount(input.amount),
            redirectUrl: input.redirectUrl,
            cancelUrl: input.cancelUrl,
            webhookUrl: input.webhookUrl,
            // Mollie validates against its own locale enum; pass through as-is.
            locale: input.customer?.locale as Locale2 | undefined,
            lines: sendLines ? input.lines.map(toMollieLine) : undefined,
            // Lets you find the order from the Mollie dashboard.
            metadata: { orderId: input.orderId },
          },
        }),
      );
      return toSnapshot(payment);
    },

    async getPayment(paymentId: string): Promise<PaymentSnapshot> {
      const payment = await guard("getPayment", () => client.payments.get({ paymentId }));
      return toSnapshot(payment);
    },

    async cancelPayment(paymentId: string): Promise<PaymentSnapshot> {
      const payment = await guard("cancelPayment", () => client.payments.cancel({ paymentId }));
      return toSnapshot(payment ?? { id: paymentId, status: "canceled" });
    },

    async createRefund(input: CreateRefundInput): Promise<RefundSnapshot> {
      const refund = await guard("createRefund", () =>
        client.refunds.create({
          paymentId: input.paymentId,
          idempotencyKey: input.idempotencyKey,
          refundRequest: {
            amount: toMollieAmount(input.amount),
            description: input.description,
          },
        }),
      );
      return {
        id: refund.id ?? "",
        state: (refund.status as RefundSnapshot["state"]) ?? "pending",
        amount: refund.amount ? fromMollieAmount(refund.amount) : input.amount,
      };
    },
  };
}

/* ---------------------------------------------------------------- mapping */

/** Mollie payment response, loosely typed so SDK revisions don't break us. */
type MolliePaymentish = {
  id?: string | null;
  status?: string | null;
  amount?: { currency: string; value: string } | null;
  amountRefunded?: { currency: string; value: string } | null;
  links?: { checkout?: { href?: string | null } | null } | null;
  _links?: { checkout?: { href?: string | null } | null } | null;
};

export function toSnapshot(payment: MolliePaymentish): PaymentSnapshot {
  const amount = payment.amount ? fromMollieAmount(payment.amount) : money(0, "EUR");
  const links = payment.links ?? payment._links ?? undefined;
  return {
    id: payment.id ?? "",
    state: toGatewayState(payment.status),
    amount,
    amountRefunded: payment.amountRefunded
      ? fromMollieAmount(payment.amountRefunded)
      : money(0, amount.currency),
    checkoutUrl: links?.checkout?.href ?? undefined,
  };
}

const GATEWAY_STATES: readonly GatewayPaymentState[] = [
  "open",
  "pending",
  "authorized",
  "paid",
  "canceled",
  "expired",
  "failed",
];

function toGatewayState(status: string | null | undefined): GatewayPaymentState {
  const found = GATEWAY_STATES.find((state) => state === status);
  // Unknown statuses are treated as still open rather than silently "paid".
  return found ?? "open";
}

function toMollieLine(line: OrderLine) {
  return {
    type: LINE_TYPE[line.kind],
    description: line.name,
    quantity: line.quantity,
    unitPrice: toMollieAmount(line.unitPrice),
    totalAmount: toMollieAmount(line.total),
  };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
