import { CommerceError, versionConflict } from "../errors.ts";
import type {
  Database,
  OrderQuery,
  OrderStore,
  ProductQuery,
  ProductStore,
  StockChange,
  StockShortage,
  Stores,
} from "../ports.ts";
import type { Order, Product } from "../types.ts";
import {
  orderToRow,
  productToRow,
  rowToOrder,
  rowToProduct,
  SCHEMA_SQL,
  type OrderRow,
  type ProductRow,
} from "./rows.ts";
import { aggregateStock } from "./stock.ts";

/**
 * Postgres storage. You bring the connection: this module imports no driver,
 * so it works with whatever you already use — node-postgres, Bun's `SQL`, or
 * an embedded Postgres such as PGlite.
 *
 * ```ts
 * import { Pool } from "pg";
 * import { applyPostgresSchema, createPostgresDatabase } from "mollie-ecommerce/storage/postgres";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * await applyPostgresSchema(pool);
 * const db = createPostgresDatabase(pool);
 * ```
 */

/**
 * Anything that can run a parameterized query and return rows — the shape
 * node-postgres' `Client`, `Pool`, and pooled clients already have.
 */
export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** A connection checked out of a pool, which must be returned when done. */
export interface PostgresClient extends Queryable {
  release(): void;
}

/** A pool that can check out a dedicated connection for a transaction. */
export interface PostgresPool extends Queryable {
  connect(): Promise<PostgresClient>;
}

/* --------------------------------------------------------------- products */

export class PostgresProductStore implements ProductStore {
  constructor(private readonly db: Queryable) {}

  async get(id: string): Promise<Product | null> {
    const { rows } = await this.db.query<ProductRow>("SELECT * FROM products WHERE id = $1", [id]);
    return rows[0] ? rowToProduct(rows[0]) : null;
  }

  async getMany(ids: string[]): Promise<Product[]> {
    if (ids.length === 0) return [];
    // One array parameter instead of a generated placeholder list.
    const { rows } = await this.db.query<ProductRow>(
      "SELECT * FROM products WHERE id = ANY($1::text[])",
      [ids],
    );
    return rows.map(rowToProduct);
  }

  async list(query: ProductQuery = {}): Promise<Product[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.kind !== undefined) where.push(`kind = $${params.push(query.kind)}`);
    if (query.active !== undefined) where.push(`active = $${params.push(query.active ? 1 : 0)}`);

    const sql = [
      "SELECT * FROM products",
      where.length ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY id",
      limitOffset(query, params),
    ]
      .filter(Boolean)
      .join(" ");
    const { rows } = await this.db.query<ProductRow>(sql, params);
    return rows.map(rowToProduct);
  }

  async save(product: Product): Promise<Product> {
    const row = productToRow(product);
    const columns = Object.keys(row);
    await this.db.query(
      `INSERT INTO products (${columns.join(", ")})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
       ON CONFLICT (id) DO UPDATE SET
         ${columns
           .filter((column) => column !== "id")
           .map((column) => `${column} = excluded.${column}`)
           .join(", ")}`,
      Object.values(row),
    );
    return rowToProduct(row);
  }

  async delete(id: string): Promise<void> {
    await this.db.query("DELETE FROM products WHERE id = $1", [id]);
  }

  /**
   * All-or-nothing in a single statement, so it needs no transaction of its
   * own: the data-modifying CTE always runs to completion, but its
   * `NOT EXISTS (SELECT 1 FROM shortage)` guard means it updates nothing when
   * any item falls short. `stock IS NULL` is unlimited.
   */
  async reserveStock(items: StockChange[]): Promise<StockShortage[]> {
    if (items.length === 0) return [];
    const wanted = aggregateStock(items);

    const { rows } = await this.db.query<{
      product_id: string;
      quantity: number;
      stock: number | null;
      missing: boolean;
    }>(
      `WITH wanted AS (
         SELECT product_id, quantity
         FROM unnest($1::text[], $2::int[]) AS t(product_id, quantity)
       ),
       shortage AS (
         SELECT w.product_id, w.quantity, p.stock, p.id IS NULL AS missing
         FROM wanted w
         LEFT JOIN products p ON p.id = w.product_id
         WHERE p.id IS NULL OR (p.stock IS NOT NULL AND p.stock < w.quantity)
       ),
       reserved AS (
         UPDATE products p
         SET stock = p.stock - w.quantity
         FROM wanted w
         WHERE p.id = w.product_id
           AND p.stock IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM shortage)
         RETURNING p.id
       )
       SELECT product_id, quantity, stock, missing FROM shortage ORDER BY product_id`,
      [wanted.map((item) => item.productId), wanted.map((item) => item.quantity)],
    );

    return rows.map((row) => ({
      productId: row.product_id,
      requested: row.quantity,
      available: row.missing ? null : row.stock,
    }));
  }

  async releaseStock(items: StockChange[]): Promise<void> {
    if (items.length === 0) return;
    const wanted = aggregateStock(items);
    await this.db.query(
      `UPDATE products p
       SET stock = p.stock + w.quantity
       FROM unnest($1::text[], $2::int[]) AS w(product_id, quantity)
       WHERE p.id = w.product_id AND p.stock IS NOT NULL`,
      [wanted.map((item) => item.productId), wanted.map((item) => item.quantity)],
    );
  }
}

/* ----------------------------------------------------------------- orders */

export class PostgresOrderStore implements OrderStore {
  constructor(private readonly db: Queryable) {}

  async get(id: string): Promise<Order | null> {
    return this.one("SELECT * FROM orders WHERE id = $1", id);
  }

  async findByPaymentId(paymentId: string): Promise<Order | null> {
    return this.one("SELECT * FROM orders WHERE payment_id = $1", paymentId);
  }

  async findByIdempotencyKey(key: string): Promise<Order | null> {
    return this.one("SELECT * FROM orders WHERE idempotency_key = $1", key);
  }

  async find(query: OrderQuery = {}): Promise<Order[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    inFilter(where, params, "payment_state", query.paymentState);
    inFilter(where, params, "delivery_state", query.deliveryState);
    if (query.customerEmail !== undefined) {
      where.push(`customer_email = $${params.push(query.customerEmail)}`);
    }
    if (query.createdAfter !== undefined) {
      where.push(`created_at >= $${params.push(query.createdAfter)}`);
    }
    if (query.createdBefore !== undefined) {
      where.push(`created_at < $${params.push(query.createdBefore)}`);
    }

    const sql = [
      "SELECT * FROM orders",
      where.length ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY created_at, id",
      limitOffset(query, params),
    ]
      .filter(Boolean)
      .join(" ");
    const { rows } = await this.db.query<OrderRow>(sql, params);
    return rows.map(rowToOrder);
  }

  async insert(order: Order): Promise<Order> {
    const stored = { ...order, version: 1 };
    const row = orderToRow(stored);
    const columns = Object.keys(row);
    try {
      await this.db.query(
        `INSERT INTO orders (${columns.join(", ")})
         VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        Object.values(row),
      );
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        throw new CommerceError("duplicate_order", `order ${order.id} already exists`, {
          orderId: order.id,
          cause,
        });
      }
      throw new CommerceError("storage_error", `inserting order ${order.id} failed`, { cause });
    }
    return stored;
  }

  async update(order: Order): Promise<Order> {
    const stored = { ...order, version: order.version + 1 };
    const row = orderToRow(stored);
    const columns = Object.keys(row).filter((column) => column !== "id");
    const values = columns.map((column) => row[column as keyof OrderRow]);

    // The version predicate is the optimistic lock: no row returned means a
    // concurrent writer got there first.
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE orders SET ${columns.map((column, index) => `${column} = $${index + 1}`).join(", ")}
       WHERE id = $${columns.length + 1} AND version = $${columns.length + 2}
       RETURNING id`,
      [...values, order.id, order.version],
    );

    if (rows.length === 0) {
      const { rows: current } = await this.db.query<{ version: number }>(
        "SELECT version FROM orders WHERE id = $1",
        [order.id],
      );
      if (!current[0]) {
        throw new CommerceError("order_not_found", `no order ${order.id}`, { orderId: order.id });
      }
      throw versionConflict(order.id, order.version, current[0].version);
    }
    return stored;
  }

  private async one(sql: string, param: string): Promise<Order | null> {
    const { rows } = await this.db.query<OrderRow>(sql, [param]);
    return rows[0] ? rowToOrder(rows[0]) : null;
  }
}

/* --------------------------------------------------------------- database */

/** Creates the tables and indexes if they are missing. Safe to re-run. */
export async function applyPostgresSchema(db: Queryable): Promise<void> {
  // One statement at a time: `Queryable` is the simple query protocol only.
  for (const statement of SCHEMA_SQL.split(";")) {
    if (statement.trim() !== "") await db.query(statement);
  }
}

/**
 * Wraps a pool into a {@link Database}. Transactions check out one connection
 * and run `BEGIN`/`COMMIT` on it, rolling back on any throw.
 *
 * @param pool Your pool — anything with `query` and `connect`, like a
 * node-postgres `Pool`.
 */
export function createPostgresDatabase(pool: PostgresPool): Database {
  let depth = 0;
  let active: Stores | undefined;

  return {
    products: new PostgresProductStore(pool),
    orders: new PostgresOrderStore(pool),

    async transaction<T>(run: (stores: Stores) => Promise<T>): Promise<T> {
      // A nested call joins the running transaction instead of taking a second
      // connection, which would deadlock on the rows the first one holds.
      if (depth > 0 && active) return run(active);

      const client = await pool.connect();
      depth++;
      try {
        await client.query("BEGIN");
        active = {
          products: new PostgresProductStore(client),
          orders: new PostgresOrderStore(client),
        };
        try {
          const result = await run(active);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      } finally {
        depth--;
        if (depth === 0) active = undefined;
        client.release();
      }
    },
  };
}

/* ---------------------------------------------------------------- helpers */

function limitOffset(query: { limit?: number; offset?: number }, params: unknown[]): string {
  const clauses: string[] = [];
  // Postgres has no "-1 means everything", so the clause is simply omitted.
  if (query.limit !== undefined) clauses.push(`LIMIT $${params.push(query.limit)}`);
  if (query.offset !== undefined) clauses.push(`OFFSET $${params.push(query.offset)}`);
  return clauses.join(" ");
}

function inFilter(
  where: string[],
  params: unknown[],
  column: string,
  filter: string | string[] | undefined,
): void {
  if (filter === undefined) return;
  const values = Array.isArray(filter) ? filter : [filter];
  if (values.length === 0) return;
  where.push(`${column} = ANY($${params.push(values)}::text[])`);
}

function isUniqueViolation(cause: unknown): boolean {
  // 23505 is Postgres' unique_violation.
  return (
    typeof cause === "object" &&
    cause !== null &&
    ((cause as { code?: unknown }).code === "23505" ||
      /duplicate key value|unique constraint/i.test(String((cause as Error).message ?? "")))
  );
}
