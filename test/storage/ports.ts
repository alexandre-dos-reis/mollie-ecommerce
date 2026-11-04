import type { Order, Sku } from "../../src/types.ts";
export type { OrderQuery, StockChange, StockShortage } from "../../src/ports.ts";
import type { OrderQuery, StockChange, StockShortage } from "../../src/ports.ts";

/* ----------------------------------------------------------------- storage */

/**
 * **Test fixture, not part of the published package.** A lower-level store
 * shape that `storageFromDatabase` can drive, used to run this repo's suites
 * against in-memory, SQLite and Postgres storage. Consumers fulfil
 * `CommerceStorage` directly instead.
 *
 * The shapes are
 * deliberately database-agnostic, but chosen so a real database can implement
 * them without fighting the library:
 *
 * - every read a request needs is batched (`getMany`) rather than per-row,
 * - writes carry a `version` so you can use optimistic concurrency,
 * - lookups the library performs are all by indexable keys,
 * - stock changes are expressed as one atomic operation, not read-then-write,
 * - checkout is idempotent via a key you can put a unique index on.
 *
 */
export interface SkuStore {
  get(id: string): Promise<Sku | null>;
  /** Batched read; may return fewer rows than ids, in any order. */
  getMany(ids: string[]): Promise<Sku[]>;
  list(query?: SkuQuery): Promise<Sku[]>;
  /** Insert or replace. `active` is normalized to a boolean on write. */
  save(sku: Sku): Promise<Sku>;
  delete(id: string): Promise<void>;
  /**
   * Atomically decrement stock for every item, or change nothing at all.
   * Returns the items that could not be satisfied — an empty array means the
   * whole reservation succeeded. SKUs with `stock: undefined` are unlimited and
   * always succeed. Repeated SKU ids must consume their sum (see
   * `aggregateStock`), or the adapter oversells.
   */
  reserveStock(items: StockChange[]): Promise<StockShortage[]>;
  /** Give reserved stock back. Must be safe to call for unlimited SKUs. */
  releaseStock(items: StockChange[]): Promise<void>;
}

export type SkuQuery = {
  kind?: Sku["kind"];
  active?: boolean;
  /** All SKUs of one product — the variants of a T-shirt, say. */
  productId?: string;
  limit?: number;
  offset?: number;
};

export interface OrderStore {
  get(id: string): Promise<Order | null>;
  /** Lookup for webhooks, which carry only the provider's payment id. */
  findByPaymentId(paymentId: string): Promise<Order | null>;
  /** Lookup for idempotent checkout. Index this column uniquely. */
  findByIdempotencyKey(key: string): Promise<Order | null>;
  find(query?: OrderQuery): Promise<Order[]>;
  /** Fails with `duplicate_order` if the id already exists. */
  insert(order: Order): Promise<Order>;
  /**
   * Optimistic update: `order.version` is the version being replaced. On a
   * mismatch, throw `CommerceError("version_conflict")` — never write.
   * Returns the order with its new version.
   */
  update(order: Order): Promise<Order>;
}

export type Stores = {
  skus: SkuStore;
  orders: OrderStore;
};

/**
 * A database the library can open a transaction on. `transaction()` must pass
 * stores bound to that transaction and roll back if `run` throws. No network
 * call is ever made inside one — the library only wraps its own reads/writes.
 */
export interface Database extends Stores {
  transaction<T>(run: (stores: Stores) => Promise<T>): Promise<T>;
  /** Optional: release pools, close handles. */
  close?(): Promise<void> | void;
}

