/**
 * A minimal, complete {@link CommerceStorage} implementation over two maps.
 *
 * The library ships no storage adapters: it calls seven handlers and leaves
 * persistence entirely to you. This is the smallest honest fulfilment of that
 * contract — useful for tests and local development, and a readable starting
 * point for a real one. Swap the maps for your database and keep the shape.
 *
 * The one rule a real implementation must carry over: `createOrder` and
 * `mutateOrder` each apply **everything or nothing**. Single-threaded
 * JavaScript gives that for free here; a database gives it through a
 * transaction or a compare-and-swap.
 */
import {
  aggregateStock,
  CommerceError,
  type CommerceStorage,
  type CreateOrderInput,
  type CreateOrderResult,
  type Order,
  type OrderMutator,
  type OrderQuery,
  type Sku,
  type StockChange,
  type StockShortage,
} from "../src/index.ts";

export type MemoryStorage = {
  storage: CommerceStorage;
  /** Your catalog's job, not the library's — hence not a handler. */
  saveSku: (sku: Sku) => Promise<Sku>;
  skus: Map<string, Sku>;
  orders: Map<string, Order>;
};

export function createMemoryStorage(seed: Sku[] = []): MemoryStorage {
  const skus = new Map<string, Sku>();
  const orders = new Map<string, Order>();
  const clone = <T,>(value: T): T => structuredClone(value);

  for (const sku of seed) skus.set(sku.id, clone(sku));

  /** Decrements (`-1`) or restores (`+1`) stock for a set of changes. */
  function applyStock(changes: StockChange[], sign: 1 | -1): StockShortage[] {
    // Repeated SKU ids must consume their sum, or two lines of the same SKU
    // each pass the check and together oversell.
    const wanted = aggregateStock(changes);

    if (sign === -1) {
      const shortages: StockShortage[] = [];
      for (const item of wanted) {
        const sku = skus.get(item.skuId);
        if (!sku) {
          shortages.push({ skuId: item.skuId, requested: item.quantity, available: null });
        } else if (sku.stock !== undefined && sku.stock < item.quantity) {
          shortages.push({ skuId: item.skuId, requested: item.quantity, available: sku.stock });
        }
      }
      // All or nothing: report without touching anything.
      if (shortages.length > 0) return shortages;
    }

    for (const item of wanted) {
      const sku = skus.get(item.skuId);
      // `stock: undefined` means unlimited, so there is nothing to move.
      if (sku?.stock !== undefined) sku.stock += sign * item.quantity;
    }
    return [];
  }

  function matches(order: Order, query: OrderQuery): boolean {
    const inFilter = (filter: string | string[] | undefined, value: string) =>
      filter === undefined || (Array.isArray(filter) ? filter.includes(value) : filter === value);

    return (
      inFilter(query.paymentState, order.payment.state) &&
      inFilter(query.deliveryState, order.delivery.state) &&
      (query.customerEmail === undefined || order.customer?.email === query.customerEmail) &&
      (!query.createdAfter || order.createdAt >= query.createdAfter) &&
      (!query.createdBefore || order.createdAt < query.createdBefore)
    );
  }

  const storage: CommerceStorage = {
    async loadSkus(ids: string[]): Promise<Sku[]> {
      return ids.flatMap((id) => {
        const sku = skus.get(id);
        return sku ? [clone(sku)] : [];
      });
    },

    async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
      const shortages = applyStock(input.reserveStock, -1);
      if (shortages.length > 0) return { status: "out_of_stock", shortages };

      const stored = { ...clone(input.order), version: 1 };
      orders.set(stored.id, stored);
      return { status: "created", order: clone(stored) };
    },

    async mutateOrder(orderId: string, apply: OrderMutator): Promise<Order> {
      const current = orders.get(orderId);
      if (!current) {
        throw new CommerceError("order_not_found", `no order ${orderId}`, { orderId });
      }

      // Mutate a copy, so a mutator that throws leaves nothing behind.
      const draft = clone(current);
      const mutation = (await apply(draft)) ?? {};
      if (mutation.releaseStock?.length) applyStock(mutation.releaseStock, 1);

      draft.version = current.version + 1;
      orders.set(orderId, draft);
      return clone(draft);
    },

    async findOrder(id: string): Promise<Order | null> {
      const found = orders.get(id);
      return found ? clone(found) : null;
    },

    async findOrderByPaymentId(paymentId: string): Promise<Order | null> {
      return find((order) => order.payment.id === paymentId);
    },

    async findOrderByIdempotencyKey(key: string): Promise<Order | null> {
      return find((order) => order.idempotencyKey === key);
    },

    async listOrders(query: OrderQuery = {}): Promise<Order[]> {
      const all = [...orders.values()]
        .filter((order) => matches(order, query))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map(clone);
      const start = query.offset ?? 0;
      return query.limit === undefined ? all.slice(start) : all.slice(start, start + query.limit);
    },
  };

  function find(predicate: (order: Order) => boolean): Order | null {
    for (const order of orders.values()) {
      if (predicate(order)) return clone(order);
    }
    return null;
  }

  return {
    storage,
    saveSku: async (sku: Sku) => {
      const stored = { ...clone(sku), active: sku.active !== false };
      skus.set(stored.id, stored);
      return clone(stored);
    },
    skus,
    orders,
  };
}
