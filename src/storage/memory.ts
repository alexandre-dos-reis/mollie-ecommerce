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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function matchesAny<T>(value: T, filter: T | T[] | undefined): boolean {
  if (filter === undefined) return true;
  return Array.isArray(filter) ? filter.includes(value) : filter === value;
}

export class InMemoryProductStore implements ProductStore {
  constructor(private readonly products = new Map<string, Product>()) {}

  static seeded(seed: Product[]): InMemoryProductStore {
    const store = new InMemoryProductStore();
    for (const product of seed) store.products.set(product.id, clone(product));
    return store;
  }

  async get(id: string): Promise<Product | null> {
    const found = this.products.get(id);
    return found ? clone(found) : null;
  }

  async getMany(ids: string[]): Promise<Product[]> {
    return ids
      .map((id) => this.products.get(id))
      .filter((product): product is Product => product !== undefined)
      .map(clone);
  }

  async list(query: ProductQuery = {}): Promise<Product[]> {
    const all = [...this.products.values()]
      .filter((product) => matchesAny(product.kind, query.kind))
      .filter((product) => query.active === undefined || product.active !== false === query.active)
      .map(clone);
    return page(all, query.limit, query.offset);
  }

  async save(product: Product): Promise<Product> {
    // `active` is normalized on write, so every adapter reads back a boolean.
    const stored = { ...clone(product), active: product.active !== false };
    this.products.set(stored.id, stored);
    return clone(stored);
  }

  async delete(id: string): Promise<void> {
    this.products.delete(id);
  }

  async reserveStock(items: StockChange[]): Promise<StockShortage[]> {
    const shortages: StockShortage[] = [];
    for (const item of items) {
      const product = this.products.get(item.productId);
      if (!product) {
        shortages.push({ productId: item.productId, requested: item.quantity, available: null });
      } else if (product.stock !== undefined && product.stock < item.quantity) {
        shortages.push({
          productId: item.productId,
          requested: item.quantity,
          available: product.stock,
        });
      }
    }
    // All-or-nothing, like the SQL implementation's transaction.
    if (shortages.length > 0) return shortages;

    for (const item of items) {
      const product = this.products.get(item.productId)!;
      if (product.stock !== undefined) product.stock -= item.quantity;
    }
    return [];
  }

  async releaseStock(items: StockChange[]): Promise<void> {
    for (const item of items) {
      const product = this.products.get(item.productId);
      if (product && product.stock !== undefined) product.stock += item.quantity;
    }
  }

  /** @internal used by {@link InMemoryDatabase} to snapshot for rollback. */
  snapshot(): Map<string, Product> {
    return new Map([...this.products].map(([id, product]) => [id, clone(product)]));
  }

  /** @internal */
  restore(snapshot: Map<string, Product>): void {
    this.products.clear();
    for (const [id, product] of snapshot) this.products.set(id, product);
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
      throw versionConflict(order.id, order.version, current.version);
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
  readonly products: InMemoryProductStore;
  readonly orders: InMemoryOrderStore;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(seed: { products?: Product[] } = {}) {
    this.products = InMemoryProductStore.seeded(seed.products ?? []);
    this.orders = new InMemoryOrderStore();
  }

  async transaction<T>(run: (stores: Stores) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const before = {
        products: this.products.snapshot(),
        orders: this.orders.snapshot(),
      };
      try {
        return await run({ products: this.products, orders: this.orders });
      } catch (error) {
        this.products.restore(before.products);
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
