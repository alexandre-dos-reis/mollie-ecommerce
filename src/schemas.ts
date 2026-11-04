import { z } from "zod";
import type { OrderQuery, StockChange, StockShortage } from "./ports.ts";
import type {
  CreateOrderInput,
  CreateOrderResult,
  OrderMutation,
} from "./storage-handlers.ts";
import type { Customer, Order, OrderLine, Refund, Sku } from "./types.ts";

/**
 * Zod schemas for the data crossing the storage boundary. They exist so a
 * storage implementation can be held to the contract at runtime — see
 * `checkedStorage` — and they are exported because they are useful on your
 * side too: validating rows you rebuilt from JSON columns, or an order that
 * arrived over HTTP.
 *
 * They describe exactly the documented shapes, nothing looser: money in
 * integer minor units, ISO-8601 timestamps, versions counting up.
 */
export const MoneySchema = z.object({
  cents: z.number().int(),
  currency: z.string().min(1),
});

export const SkuKindSchema = z.enum(["physical", "digital", "service"]);

export const SkuSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: SkuKindSchema,
  price: MoneySchema,
  stock: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
  productId: z.string().optional(),
});

export const PaymentStateSchema = z.enum([
  "created",
  "open",
  "pending",
  "authorized",
  "paid",
  "canceled",
  "expired",
  "failed",
  "partially_refunded",
  "refunded",
]);

export const DeliveryStateSchema = z.enum([
  "not_started",
  "ready",
  "shipped",
  "delivered",
  "returned",
  "canceled",
]);

export const OrderLineSchema = z.object({
  skuId: z.string().min(1),
  name: z.string(),
  kind: SkuKindSchema,
  quantity: z.number().int().positive(),
  unitPrice: MoneySchema,
  total: MoneySchema,
  productId: z.string().optional(),
});

export const CustomerSchema = z.object({
  email: z.string().optional(),
  locale: z.string().optional(),
});

export const RefundSchema = z.object({
  id: z.string(),
  amount: MoneySchema,
  reason: z.string().optional(),
  state: z.enum(["queued", "pending", "processing", "refunded", "failed", "canceled"]),
  createdAt: z.string(),
});

/** ISO-8601, as `Date.prototype.toISOString` produces it. */
const TimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "expected an ISO-8601 timestamp",
});

export const OrderSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(0),
  idempotencyKey: z.string().optional(),
  lines: z.array(OrderLineSchema),
  total: MoneySchema,
  customer: CustomerSchema.optional(),
  payment: z.object({
    state: PaymentStateSchema,
    id: z.string().optional(),
    checkoutUrl: z.string().optional(),
    amountRefunded: MoneySchema,
  }),
  stockReserved: z.boolean(),
  delivery: z.object({
    state: DeliveryStateSchema,
    carrier: z.string().optional(),
    trackingCode: z.string().optional(),
  }),
  refunds: z.array(RefundSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const StockChangeSchema = z.object({
  skuId: z.string().min(1),
  quantity: z.number().int().positive(),
});

export const StockShortageSchema = z.object({
  skuId: z.string().min(1),
  requested: z.number().int().positive(),
  available: z.number().int().nullable(),
});

export const OrderQuerySchema = z.object({
  paymentState: z.union([PaymentStateSchema, z.array(PaymentStateSchema)]).optional(),
  deliveryState: z.union([DeliveryStateSchema, z.array(DeliveryStateSchema)]).optional(),
  customerEmail: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().min(0).optional(),
});

export const CreateOrderInputSchema = z.object({
  order: OrderSchema,
  reserveStock: z.array(StockChangeSchema),
});

export const CreateOrderResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), order: OrderSchema }),
  z.object({
    status: z.literal("out_of_stock"),
    // An empty list would mean "nothing was wrong", which contradicts the status.
    shortages: z.array(StockShortageSchema).min(1),
  }),
]);

export const OrderMutationSchema = z.object({
  releaseStock: z.array(StockChangeSchema).optional(),
});

/* Compile-time guard: a schema that drifts from its type stops building. */
const _typeChecks = {
  money: MoneySchema satisfies z.ZodType<{ cents: number; currency: string }>,
  sku: SkuSchema satisfies z.ZodType<Sku>,
  line: OrderLineSchema satisfies z.ZodType<OrderLine>,
  customer: CustomerSchema satisfies z.ZodType<Customer>,
  refund: RefundSchema satisfies z.ZodType<Refund>,
  order: OrderSchema satisfies z.ZodType<Order>,
  stockChange: StockChangeSchema satisfies z.ZodType<StockChange>,
  stockShortage: StockShortageSchema satisfies z.ZodType<StockShortage>,
  orderQuery: OrderQuerySchema satisfies z.ZodType<OrderQuery>,
  createOrderInput: CreateOrderInputSchema satisfies z.ZodType<CreateOrderInput>,
  createOrderResult: CreateOrderResultSchema satisfies z.ZodType<CreateOrderResult>,
  orderMutation: OrderMutationSchema satisfies z.ZodType<OrderMutation>,
};
void _typeChecks;
