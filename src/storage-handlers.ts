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
 * - **Reads** (`loadSkus`, `findOrder*`, `listOrders`) are plain lookups. One
 *   statement each; no transaction needed.
 * - **Writes** (`createOrder`, `mutateOrder`) must each apply *everything they
 *   are given, or nothing at all*. **Wrap each one in a database transaction**
 *   — they are the only two places the commerce layer relies on atomicity,
 *   which is why there are just two of them. A single statement that is
 *   already all-or-nothing works too, as does a compare-and-swap loop.
 *
 * The commerce layer never calls one handler from inside another, and never
 * makes a payment-provider call while one is running, so your transactions
 * stay short and never nest. Default isolation (`READ COMMITTED`) is enough:
 * each write handler's own predicate — stock sufficiency, order version — is
 * what keeps concurrent callers correct.
 *
 * Writing your own tables from a write handler is encouraged — status history,
 * audit rows, your own inventory — since they then commit with the order. What
 * does not belong in a handler:
 *
 * - **Anything that leaves the process**: emails, queue publishes, HTTP calls.
 *   A write handler can roll back or retry, so insert an outbox row inside the
 *   transaction and act on it after commit, or react to the order the commerce
 *   method returns.
 * - **Business rules**: transitions, refund limits and totals are already
 *   decided; disagreeing here silently corrupts state.
 * - **SKU writes**: there is no handler for them. Your catalog owns SKUs and
 *   the library only reads them — apart from the stock column, which the two
 *   write handlers move for you.
 *
 * `describeCommerceStorage` in `mollie-ecommerce/storage/conformance` tests an
 * implementation against this contract.
 */
export interface CommerceStorage {
  /**
   * Reads the SKUs being bought, for pricing. One batched read — no
   * transaction needed, and the prices are snapshotted onto the order anyway.
   *
   * Ids are unique; missing ones are simply absent from the result, and the
   * commerce layer reports them.
   *
   * @param ids SKU ids, in no particular order.
   */
  loadSkus(ids: string[]): Promise<Sku[]>;

  /**
   * Persists a new order **and** takes its stock, atomically.
   *
   * **Open a transaction** around both: decrement every `reserveStock` entry,
   * insert the order, commit. Roll back if any decrement falls short, so a
   * partial reservation can never survive. (In Postgres a single guarded
   * statement can do it without an explicit transaction — see the README's
   * reference schema.)
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
   * **Open a transaction** around the whole sequence: read the order, call
   * `apply`, apply `releaseStock`, write the order back. If `apply` throws,
   * roll back and let the error through — a half-applied mutation is worse
   * than a failed one.
   *
   * This handler is where concurrency is decided, since the commerce layer
   * expresses every write to an existing order through it. Either hold a lock
   * for the duration (`SELECT … FOR UPDATE`), or write with the version you
   * read (`UPDATE … WHERE version = $n`) and retry if no row matched. Reject a
   * lost race by throwing `CommerceError("version_conflict")` rather than
   * overwriting.
   *
   * @param orderId The order to change. Throw
   * `CommerceError("order_not_found")` if it does not exist.
   * @param apply Mutates the order in place and returns any stock to give
   * back. Call it once per attempt, on freshly read state — if you retry, it
   * runs again, so keep your own side effects outside it.
   * @returns The persisted order, with its new version.
   */
  mutateOrder(orderId: string, apply: OrderMutator): Promise<Order>;

  /**
   * Reads one order. A plain lookup — no transaction needed.
   *
   * @param id The order id. `null` when unknown.
   */
  findOrder(id: string): Promise<Order | null>;

  /**
   * Looks an order up by its payment id, for webhooks — which carry nothing
   * else. A plain lookup; at most one order per payment id, so index it
   * uniquely.
   *
   * @param paymentId The provider's payment id, e.g. `tr_…`.
   */
  findOrderByPaymentId(paymentId: string): Promise<Order | null>;

  /**
   * Looks an order up by the idempotency key checkout was called with, so a
   * retried checkout replays instead of charging twice. A plain lookup; at
   * most one order per key, so index it uniquely.
   *
   * @param key The caller's key.
   */
  findOrderByIdempotencyKey(key: string): Promise<Order | null>;

  /**
   * Lists orders oldest-created first. A plain read.
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
