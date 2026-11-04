import type { OrderQuery, StockChange, StockShortage } from "./ports.ts";
import type { Order, Sku } from "./types.ts";

/**
 * Everything the commerce layer needs from persistence, as a flat set of
 * handlers you fulfill. `createCommerce` calls nothing else: it opens no
 * transaction, issues no query, and knows nothing about tables, stores or
 * optimistic locking. Where and how data is kept is entirely yours.
 *
 * Handlers come in two kinds, and the difference is the contract:
 *
 * - **Reads** (`loadSkus`, `findOrder*`, `listOrders`) are plain lookups.
 * - **Writes** (`createOrder`, `mutateOrder`) must each apply *everything they
 *   are given, or nothing at all*. They are the only places the commerce layer
 *   relies on atomicity, which is why there are just two of them.
 *
 * Fulfil them however suits you — a SQL transaction, a document update, a
 * compare-and-swap loop, an in-memory map. If you already have a
 * {@link ../ports.ts Database} adapter, `storageFromDatabase` builds these
 * handlers for you.
 *
 * `describeCommerceStorage` in `mollie-ecommerce/storage/conformance` tests an
 * implementation against this contract.
 */
export interface CommerceStorage {
  /**
   * Reads the SKUs being bought, for pricing. Ids are unique; missing ones are
   * simply absent from the result, and the commerce layer reports them.
   *
   * @param ids SKU ids, in no particular order.
   */
  loadSkus(ids: string[]): Promise<Sku[]>;

  /**
   * Persists a new order **and** takes its stock, atomically.
   *
   * Assign the order `version: 1` (or your own first version) and return the
   * stored copy. If any requested stock cannot be satisfied, change nothing
   * and return the shortages instead — do not throw, and do not persist the
   * order.
   *
   * @param input.order The order to store. Its id is already generated.
   * @param input.reserveStock Stock to decrement. Empty when stock
   * reservation is turned off; repeated SKU ids must consume their sum.
   */
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;

  /**
   * Reads one order, applies `apply` to it, and persists the result —
   * atomically, with the returned stock changes.
   *
   * The commerce layer expresses every write to an existing order this way, so
   * this handler is where concurrency is decided: either hold a lock for the
   * duration, or re-read and retry if the order changed underneath (its
   * `version` tells you). Reject a lost race by throwing
   * `CommerceError("version_conflict")` rather than overwriting.
   *
   * @param orderId The order to change. Throw
   * `CommerceError("order_not_found")` if it does not exist.
   * @param apply Mutates the order in place and returns any stock to give
   * back. Call it once per attempt, on freshly read state.
   * @returns The persisted order, with its new version.
   */
  mutateOrder(orderId: string, apply: OrderMutator): Promise<Order>;

  /** @param id The order id. `null` when unknown. */
  findOrder(id: string): Promise<Order | null>;

  /**
   * Looks an order up by its payment id, for webhooks — which carry nothing
   * else. At most one order per payment id.
   *
   * @param paymentId The provider's payment id, e.g. `tr_…`.
   */
  findOrderByPaymentId(paymentId: string): Promise<Order | null>;

  /**
   * Looks an order up by the idempotency key checkout was called with, so a
   * retried checkout replays instead of charging twice. At most one order per
   * key.
   *
   * @param key The caller's key.
   */
  findOrderByIdempotencyKey(key: string): Promise<Order | null>;

  /**
   * Lists orders oldest-created first.
   *
   * @param query Filters: `paymentState`, `deliveryState`, `customerEmail`,
   * `createdAfter`, `createdBefore`, `limit`, `offset`. State filters accept
   * one value or an array; absent filters match everything.
   */
  listOrders(query?: OrderQuery): Promise<Order[]>;
}

export type CreateOrderInput = {
  order: Order;
  reserveStock: StockChange[];
};

export type CreateOrderResult =
  /** Stored, with the version you assigned. */
  | { status: "created"; order: Order }
  /** Nothing was stored and no stock was taken. */
  | { status: "out_of_stock"; shortages: StockShortage[] };

/**
 * Mutates the order in place and reports side effects to apply in the same
 * atomic unit. Returning nothing means "just save the order".
 */
export type OrderMutator = (order: Order) => OrderMutation | void | Promise<OrderMutation | void>;

export type OrderMutation = {
  /** Stock to give back — a dead payment, or a restocked return. */
  releaseStock?: StockChange[];
};
