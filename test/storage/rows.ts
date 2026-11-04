import { money } from "../../src/money.ts";
import type { Order, OrderLine, Refund, Sku } from "../../src/types.ts";

/**
 * Flat row shapes for the two entities, plus mappers. Nothing here knows about
 * a specific database: every field is a string, number, or JSON text, so the
 * same mapping works for SQLite, Postgres, MySQL, or a document store.
 *
 * Money is split into `*_cents` integers plus one currency per row — never
 * floats. Lines and refunds are JSON columns; if you need to query inside
 * them, promote them to child tables and keep these mappers for the parent.
 */
export type SkuRow = {
  id: string;
  name: string;
  kind: string;
  price_cents: number;
  currency: string;
  /** `null` means unlimited. */
  stock: number | null;
  active: number;
  /** Optional grouping key; the library never interprets it. */
  product_id: string | null;
};

export type OrderRow = {
  id: string;
  version: number;
  idempotency_key: string | null;
  currency: string;
  total_cents: number;
  amount_refunded_cents: number;
  payment_state: string;
  payment_id: string | null;
  checkout_url: string | null;
  delivery_state: string;
  carrier: string | null;
  tracking_code: string | null;
  stock_reserved: number;
  customer_email: string | null;
  customer_locale: string | null;
  lines: string;
  refunds: string;
  created_at: string;
  updated_at: string;
};

/* ------------------------------------------------------------------- skus */

export function skuToRow(sku: Sku): SkuRow {
  return {
    id: sku.id,
    name: sku.name,
    kind: sku.kind,
    price_cents: sku.price.cents,
    currency: sku.price.currency,
    stock: sku.stock ?? null,
    active: sku.active === false ? 0 : 1,
    product_id: sku.productId ?? null,
  };
}

export function rowToSku(row: SkuRow): Sku {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as Sku["kind"],
    price: money(row.price_cents, row.currency),
    stock: row.stock ?? undefined,
    active: row.active !== 0,
    productId: row.product_id ?? undefined,
  };
}

/* ----------------------------------------------------------------- orders */

export function orderToRow(order: Order): OrderRow {
  return {
    id: order.id,
    version: order.version,
    idempotency_key: order.idempotencyKey ?? null,
    currency: order.total.currency,
    total_cents: order.total.cents,
    amount_refunded_cents: order.payment.amountRefunded.cents,
    payment_state: order.payment.state,
    payment_id: order.payment.id ?? null,
    checkout_url: order.payment.checkoutUrl ?? null,
    delivery_state: order.delivery.state,
    carrier: order.delivery.carrier ?? null,
    tracking_code: order.delivery.trackingCode ?? null,
    stock_reserved: order.stockReserved ? 1 : 0,
    customer_email: order.customer?.email ?? null,
    customer_locale: order.customer?.locale ?? null,
    lines: JSON.stringify(order.lines),
    refunds: JSON.stringify(order.refunds),
    created_at: order.createdAt,
    updated_at: order.updatedAt,
  };
}

export function rowToOrder(row: OrderRow): Order {
  const customer = {
    email: row.customer_email ?? undefined,
    locale: row.customer_locale ?? undefined,
  };
  const hasCustomer = Object.values(customer).some((value) => value !== undefined);

  return {
    id: row.id,
    version: row.version,
    idempotencyKey: row.idempotency_key ?? undefined,
    lines: JSON.parse(row.lines) as OrderLine[],
    total: money(row.total_cents, row.currency),
    customer: hasCustomer ? customer : undefined,
    payment: {
      state: row.payment_state as Order["payment"]["state"],
      id: row.payment_id ?? undefined,
      checkoutUrl: row.checkout_url ?? undefined,
      amountRefunded: money(row.amount_refunded_cents, row.currency),
    },
    stockReserved: row.stock_reserved !== 0,
    delivery: {
      state: row.delivery_state as Order["delivery"]["state"],
      carrier: row.carrier ?? undefined,
      trackingCode: row.tracking_code ?? undefined,
    },
    refunds: JSON.parse(row.refunds) as Refund[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ----------------------------------------------------------------- schema */

/**
 * Reference DDL in portable SQL. Adjust types for your engine (`TEXT` →
 * `VARCHAR`/`JSONB`, `INTEGER` → `BIGINT`); the column names match the row
 * shapes above. The indexes are the ones this library's lookups need.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS skus (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  currency    TEXT NOT NULL,
  stock       INTEGER,
  active      INTEGER NOT NULL DEFAULT 1,
  product_id  TEXT
);

CREATE INDEX IF NOT EXISTS skus_product_id ON skus (product_id);

CREATE TABLE IF NOT EXISTS orders (
  id                    TEXT PRIMARY KEY,
  version               INTEGER NOT NULL,
  idempotency_key       TEXT,
  currency              TEXT NOT NULL,
  total_cents           INTEGER NOT NULL,
  amount_refunded_cents INTEGER NOT NULL DEFAULT 0,
  payment_state         TEXT NOT NULL,
  payment_id            TEXT,
  checkout_url          TEXT,
  delivery_state        TEXT NOT NULL,
  carrier               TEXT,
  tracking_code         TEXT,
  stock_reserved        INTEGER NOT NULL DEFAULT 0,
  customer_email        TEXT,
  customer_locale       TEXT,
  lines                 TEXT NOT NULL,
  refunds               TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_id ON orders (payment_id);
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key ON orders (idempotency_key);
CREATE INDEX IF NOT EXISTS orders_payment_state ON orders (payment_state);
CREATE INDEX IF NOT EXISTS orders_delivery_state ON orders (delivery_state);
CREATE INDEX IF NOT EXISTS orders_customer_email ON orders (customer_email);
CREATE INDEX IF NOT EXISTS orders_created_at ON orders (created_at);
`;
