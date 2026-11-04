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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function matchesAny<T>(value: T, filter: T | T[] | undefined): boolean {
  if (filter === undefined) return true;
  return Array.isArray(filter) ? filter.includes(value) : filter === value;
}

export class InMemorySkuStore implements SkuStore {
  constructor(private readonly skus = new Map<string, Sku>()) {}

  static seeded(seed: Sku[]): InMemorySkuStore {
    const store = new InMemorySkuStore();
    for (const sku of seed) store.skus.set(sku.id, clone(sku));
    return store;
  }

  async get(id: string): Promise<Sku | null> {
    const found = this.skus.get(id);
    return found ? clone(found) : null;
  }

  async getMany(ids: string[]): Promise<Sku[]> {
    return ids
      .map((id) => this.skus.get(id))
      .filter((sku): sku is Sku => sku !== undefined)
      .map(clone);
  }

  async list(query: SkuQuery = {}): Promise<Sku[]> {
    const all = [...this.skus.values()]
      .filter((sku) => matchesAny(sku.kind, query.kind))
      .filter((sku) => query.active === undefined || sku.active !== false === query.active)
      .filter((sku) => query.productId === undefined || sku.productId === query.productId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(clone);
    return page(all, query.limit, query.offset);
  }

  async save(sku: Sku): Promise<Sku> {
    // `active` is normalized on write, so every adapter reads back a boolean.
    const stored = { ...clone(sku), active: sku.active !== false };
    this.skus.set(stored.id, stored);
    return clone(stored);
  }

  async delete(id: string): Promise<void> {
    this.skus.delete(id);
  }

  async reserveStock(items: StockChange[]): Promise<StockShortage[]> {
    const wanted = aggregateStock(items);
    const shortages: StockShortage[] = [];
    for (const item of wanted) {
      const sku = this.skus.get(item.skuId);
      if (!sku) {
        shortages.push({ skuId: item.skuId, requested: item.quantity, available: null });
      } else if (sku.stock !== undefined && sku.stock < item.quantity) {
        shortages.push({ skuId: item.skuId, requested: item.quantity, available: sku.stock });
      }
    }
    // All-or-nothing, like the SQL implementation's transaction.
    if (shortages.length > 0) return shortages;

    for (const item of wanted) {
      const sku = this.skus.get(item.skuId)!;
      if (sku.stock !== undefined) sku.stock -= item.quantity;
    }
    return [];
  }

  async releaseStock(items: StockChange[]): Promise<void> {
    for (const item of aggregateStock(items)) {
      const sku = this.skus.get(item.skuId);
      if (sku && sku.stock !== undefined) sku.stock += item.quantity;
    }
  }

  /** @internal used by {@link InMemoryDatabase} to snapshot for rollback. */
  snapshot(): Map<string, Sku> {
    return new Map([...this.skus].map(([id, sku]) => [id, clone(sku)]));
  }

  /** @internal */
  restore(snapshot: Map<string, Sku>): void {
    this.skus.clear();
    for (const [id, sku] of snapshot) this.skus.set(id, sku);
  }
}

export class InMemoryOrderStore implements OrderStore {
  constructor(private readonly orders = new Map<string, Order>()) {}

  async get(id: string): Promise<Order | null> {
    const found = this.orders.get(id);
    return found ? clone(found) : null;
  }

  async findByPaymentId(paymentId: string): Promise<Order | null> {
    return this.first((order) => order.payment.id === paymentId);
  }

  async findByIdempotencyKey(key: string): Promise<Order | null> {
    return this.first((order) => order.idempotencyKey === key);
  }

  async find(query: OrderQuery = {}): Promise<Order[]> {
    const all = [...this.orders.values()]
      .filter((order) => matchesAny(order.payment.state, query.paymentState))
      .filter((order) => matchesAny(order.delivery.state, query.deliveryState))
      .filter(
        (order) =>
          query.customerEmail === undefined || order.customer?.email === query.customerEmail,
      )
      .filter((order) => !query.createdAfter || order.createdAt >= query.createdAfter)
      .filter((order) => !query.createdBefore || order.createdAt < query.createdBefore)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
    return page(all, query.limit, query.offset);
  }

  async insert(order: Order): Promise<Order> {
    if (this.orders.has(order.id)) {
      throw new CommerceError("duplicate_order", `order ${order.id} already exists`, {
        orderId: order.id,
      });
    }
    const stored = { ...clone(order), version: 1 };
    this.orders.set(stored.id, stored);
    return clone(stored);
  }

  async update(order: Order): Promise<Order> {
    const current = this.orders.get(order.id);
    if (!current) {
      throw new CommerceError("order_not_found", `no order ${order.id}`, { orderId: order.id });
    }
    if (current.version !== order.version) {
      throw storageError.versionConflict(order.id, order.version, current.version);
    }
    const stored = { ...clone(order), version: current.version + 1 };
    this.orders.set(stored.id, stored);
    return clone(stored);
  }

  private first(predicate: (order: Order) => boolean): Order | null {
    for (const order of this.orders.values()) {
      if (predicate(order)) return clone(order);
    }
    return null;
  }

  /** @internal */
  snapshot(): Map<string, Order> {
    return new Map([...this.orders].map(([id, order]) => [id, clone(order)]));
  }

  /** @internal */
  restore(snapshot: Map<string, Order>): void {
    this.orders.clear();
    for (const [id, order] of snapshot) this.orders.set(id, order);
  }
}

/**
 * Development/test database. `transaction()` is serialized and rolls back by
 * restoring a snapshot — enough to match the semantics a real engine gives you,
 * without pretending to be concurrent-safe across processes.
 */
export class InMemoryDatabase implements Database {
  readonly skus: InMemorySkuStore;
  readonly orders: InMemoryOrderStore;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(seed: { skus?: Sku[] } = {}) {
    this.skus = InMemorySkuStore.seeded(seed.skus ?? []);
    this.orders = new InMemoryOrderStore();
  }

  async transaction<T>(run: (stores: Stores) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const before = {
        skus: this.skus.snapshot(),
        orders: this.orders.snapshot(),
      };
      try {
        return await run({ skus: this.skus, orders: this.orders });
      } catch (error) {
        this.skus.restore(before.skus);
        this.orders.restore(before.orders);
        throw error;
      }
    });
    // Keep the queue alive regardless of this transaction's outcome.
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function page<T>(items: T[], limit?: number, offset?: number): T[] {
  const start = offset ?? 0;
  return limit === undefined ? items.slice(start) : items.slice(start, start + limit);
}
