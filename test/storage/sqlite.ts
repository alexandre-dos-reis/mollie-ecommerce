import { Database as Sqlite } from "bun:sqlite";
import { CommerceError, storageError } from "../../src/errors.ts";
import type {
  Database,
  OrderQuery,
  OrderStore,
  SkuQuery,
  SkuStore,
  StockChange,
  StockShortage,
  Stores,
} from "./ports.ts";
import type { Order, Sku } from "../../src/types.ts";
import { aggregateStock } from "../../src/stock.ts";
import {
  orderToRow,
  skuToRow,
  rowToOrder,
  rowToSku,
  SCHEMA_SQL,
  type OrderRow,
  type SkuRow,
} from "./rows.ts";

/**
 * Reference SQL adapter, on `bun:sqlite`. It exists to prove the ports are
 * implementable with ordinary SQL and to be copied: the statements below are
 * plain enough to port to Postgres or MySQL by swapping placeholders and the
 * `transaction` helper.
 */
export class SqliteSkuStore implements SkuStore {
  private savepoints = 0;

  constructor(private readonly db: Sqlite) {}

  async get(id: string): Promise<Sku | null> {
    const row = this.db.query<SkuRow, [string]>("SELECT * FROM skus WHERE id = ?").get(id);
    return row ? rowToSku(row) : null;
  }

  async getMany(ids: string[]): Promise<Sku[]> {
    if (ids.length === 0) return [];
    const holes = ids.map(() => "?").join(", ");
    const rows = this.db
      .query<SkuRow, string[]>(`SELECT * FROM skus WHERE id IN (${holes})`)
      .all(...ids);
    return rows.map(rowToSku);
  }

  async list(query: SkuQuery = {}): Promise<Sku[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.kind !== undefined) {
      where.push("kind = ?");
      params.push(query.kind);
    }
    if (query.active !== undefined) {
      where.push("active = ?");
      params.push(query.active ? 1 : 0);
    }
    if (query.productId !== undefined) {
      where.push("product_id = ?");
      params.push(query.productId);
    }
    const sql = [
      "SELECT * FROM skus",
      where.length ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY id",
      limitOffset(query, params),
    ]
      .filter(Boolean)
      .join(" ");
    return this.db
      .query<SkuRow, (string | number)[]>(sql)
      .all(...params)
      .map(rowToSku);
  }

  async save(sku: Sku): Promise<Sku> {
    const row = skuToRow(sku);
    const columns = Object.keys(row);
    this.db
      .query(
        `INSERT INTO skus (${columns.join(", ")})
         VALUES (${columns.map((column) => `$${column}`).join(", ")})
         ON CONFLICT (id) DO UPDATE SET
           ${columns
             .filter((column) => column !== "id")
             .map((column) => `${column} = excluded.${column}`)
             .join(", ")}`,
      )
      .run(bind(row));
    return rowToSku(row);
  }

  async delete(id: string): Promise<void> {
    this.db.query("DELETE FROM skus WHERE id = ?").run(id);
  }

  async reserveStock(items: StockChange[]): Promise<StockShortage[]> {
    const shortages: StockShortage[] = [];
    const reserve = this.db.query<SkuRow, [number, string, number]>(
      `UPDATE skus SET stock = stock - ?
       WHERE id = ? AND stock IS NOT NULL AND stock >= ?
       RETURNING *`,
    );
    const probe = this.db.query<{ stock: number | null }, [string]>(
      "SELECT stock FROM skus WHERE id = ?",
    );

    const wanted = aggregateStock(items);

    // A savepoint makes the reservation all-or-nothing on its own, whether or
    // not a surrounding transaction is open.
    const savepoint = `reserve_${(this.savepoints++).toString(36)}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      for (const item of wanted) {
        if (reserve.get(item.quantity, item.skuId, item.quantity)) continue;

        const existing = probe.get(item.skuId);
        if (!existing) {
          shortages.push({ skuId: item.skuId, requested: item.quantity, available: null });
        } else if (existing.stock !== null) {
          shortages.push({
            skuId: item.skuId,
            requested: item.quantity,
            available: existing.stock,
          });
        }
        // stock IS NULL means unlimited: nothing to decrement, nothing to report.
      }
      if (shortages.length > 0) this.db.exec(`ROLLBACK TO ${savepoint}`);
      return shortages;
    } finally {
      this.db.exec(`RELEASE ${savepoint}`);
    }
  }

  async releaseStock(items: StockChange[]): Promise<void> {
    const release = this.db.query<never, [number, string]>(
      "UPDATE skus SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL",
    );
    for (const item of aggregateStock(items)) release.run(item.quantity, item.skuId);
  }
}

export class SqliteOrderStore implements OrderStore {
  constructor(private readonly db: Sqlite) {}

  async get(id: string): Promise<Order | null> {
    return this.one("SELECT * FROM orders WHERE id = ?", id);
  }

  async findByPaymentId(paymentId: string): Promise<Order | null> {
    return this.one("SELECT * FROM orders WHERE payment_id = ?", paymentId);
  }

  async findByIdempotencyKey(key: string): Promise<Order | null> {
    return this.one("SELECT * FROM orders WHERE idempotency_key = ?", key);
  }

  async find(query: OrderQuery = {}): Promise<Order[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    inFilter(where, params, "payment_state", query.paymentState);
    inFilter(where, params, "delivery_state", query.deliveryState);
    if (query.customerEmail !== undefined) {
      where.push("customer_email = ?");
      params.push(query.customerEmail);
    }
    if (query.createdAfter !== undefined) {
      where.push("created_at >= ?");
      params.push(query.createdAfter);
    }
    if (query.createdBefore !== undefined) {
      where.push("created_at < ?");
      params.push(query.createdBefore);
    }
    const sql = [
      "SELECT * FROM orders",
      where.length ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY created_at, id",
      limitOffset(query, params),
    ]
      .filter(Boolean)
      .join(" ");
    return this.db
      .query<OrderRow, (string | number)[]>(sql)
      .all(...params)
      .map(rowToOrder);
  }

  async insert(order: Order): Promise<Order> {
    const stored = { ...order, version: 1 };
    const row = orderToRow(stored);
    const columns = Object.keys(row);
    try {
      this.db
        .query(
          `INSERT INTO orders (${columns.join(", ")})
           VALUES (${columns.map((column) => `$${column}`).join(", ")})`,
        )
        .run(bind(row));
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
    const assignments = Object.keys(row)
      .filter((column) => column !== "id")
      .map((column) => `${column} = $${column}`)
      .join(", ");

    // The version predicate is the optimistic lock: zero rows means conflict.
    const result = this.db
      .query(`UPDATE orders SET ${assignments} WHERE id = $id AND version = $expected_version`)
      .run({ ...bind(row), $expected_version: order.version });

    if (result.changes === 0) {
      const current = this.db
        .query<{ version: number }, [string]>("SELECT version FROM orders WHERE id = ?")
        .get(order.id);
      if (!current) {
        throw new CommerceError("order_not_found", `no order ${order.id}`, { orderId: order.id });
      }
      throw storageError.versionConflict(order.id, order.version, current.version);
    }
    return stored;
  }

  private one(sql: string, param: string): Order | null {
    const row = this.db.query<OrderRow, [string]>(sql).get(param);
    return row ? rowToOrder(row) : null;
  }
}

export type SqliteDatabaseOptions = {
  /** File path, or `:memory:`. Ignored when `db` is given. */
  filename?: string;
  db?: Sqlite;
  /** Create tables and indexes if missing. Default true. */
  migrate?: boolean;
};

export class SqliteDatabase implements Database {
  readonly db: Sqlite;
  readonly skus: SqliteSkuStore;
  readonly orders: SqliteOrderStore;
  private depth = 0;

  constructor(options: SqliteDatabaseOptions = {}) {
    this.db = options.db ?? new Sqlite(options.filename ?? ":memory:");
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    if (options.migrate !== false) this.db.exec(SCHEMA_SQL);
    this.skus = new SqliteSkuStore(this.db);
    this.orders = new SqliteOrderStore(this.db);
  }

  async transaction<T>(run: (stores: Stores) => Promise<T>): Promise<T> {
    // bun:sqlite's transaction() helper is synchronous, and our store methods
    // are async, so drive BEGIN/COMMIT directly. Nested calls join the parent.
    if (this.depth > 0) return run({ skus: this.skus, orders: this.orders });

    this.db.exec("BEGIN");
    this.depth++;
    try {
      const result = await run({ skus: this.skus, orders: this.orders });
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.db.close();
  }
}

/* ---------------------------------------------------------------- helpers */

function bind(row: Record<string, string | number | null>): Record<string, string | number | null> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [`$${key}`, value]));
}

function limitOffset(
  query: { limit?: number; offset?: number },
  params: (string | number)[],
): string {
  if (query.limit === undefined && query.offset === undefined) return "";
  params.push(query.limit ?? -1, query.offset ?? 0);
  return "LIMIT ? OFFSET ?";
}

function inFilter(
  where: string[],
  params: (string | number)[],
  column: string,
  filter: string | string[] | undefined,
): void {
  if (filter === undefined) return;
  const values = Array.isArray(filter) ? filter : [filter];
  if (values.length === 0) return;
  where.push(`${column} IN (${values.map(() => "?").join(", ")})`);
  params.push(...values);
}

function isUniqueViolation(cause: unknown): boolean {
  return cause instanceof Error && /UNIQUE constraint/i.test(cause.message);
}
