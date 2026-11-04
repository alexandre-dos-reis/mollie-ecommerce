import { CommerceError } from "../../src/errors.ts";
import type { Database, OrderQuery, StockShortage } from "./ports.ts";
import type {
  CommerceStorage,
  CreateOrderInput,
  CreateOrderResult,
  OrderMutator,
} from "../../src/storage-handlers.ts";
import type { Order, Sku } from "../../src/types.ts";

/**
 * Builds {@link CommerceStorage} handlers from a {@link Database} adapter —
 * `InMemoryDatabase`, `SqliteDatabase`, the Postgres stores, or your own. Each
 * write handler runs in one transaction, which is what makes it atomic.
 *
 * ```ts
 * const commerce = createCommerce({
 *   gateway,
 *   storage: storageFromDatabase(new SqliteDatabase({ filename: "./shop.sqlite" })),
 * });
 * ```
 *
 * Passing `db` to `createCommerce` does exactly this for you.
 */
export function storageFromDatabase(db: Database): CommerceStorage {
  return {
    loadSkus: (ids: string[]): Promise<Sku[]> => db.skus.getMany(ids),

    async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
      try {
        return await db.transaction(async (stores) => {
          if (input.reserveStock.length > 0) {
            const shortages = await stores.skus.reserveStock(input.reserveStock);
            // Throwing is how the transaction is told to roll back; it never
            // escapes this function.
            if (shortages.length > 0) throw new Shortages(shortages);
          }
          return { status: "created", order: await stores.orders.insert(input.order) };
        });
      } catch (error) {
        if (error instanceof Shortages) {
          return { status: "out_of_stock", shortages: error.shortages };
        }
        throw error;
      }
    },

    mutateOrder(orderId: string, apply: OrderMutator): Promise<Order> {
      return db.transaction(async (stores) => {
        const order = await stores.orders.get(orderId);
        if (!order) {
          throw new CommerceError("order_not_found", `no order ${orderId}`, { orderId });
        }
        const mutation = (await apply(order)) ?? {};
        if (mutation.releaseStock && mutation.releaseStock.length > 0) {
          await stores.skus.releaseStock(mutation.releaseStock);
        }
        // `update` is the optimistic lock: it throws on a concurrent write.
        return stores.orders.update(order);
      });
    },

    findOrder: (id: string): Promise<Order | null> => db.orders.get(id),
    findOrderByPaymentId: (paymentId: string): Promise<Order | null> =>
      db.orders.findByPaymentId(paymentId),
    findOrderByIdempotencyKey: (key: string): Promise<Order | null> =>
      db.orders.findByIdempotencyKey(key),
    listOrders: (query?: OrderQuery): Promise<Order[]> => db.orders.find(query),
  };
}

/** Internal signal: abort the transaction, then report the shortages. */
class Shortages extends Error {
  constructor(readonly shortages: StockShortage[]) {
    super("stock reservation failed");
  }
}
