import { z } from "zod";
import { CommerceError } from "./errors.ts";
import type { OrderQuery } from "./ports.ts";
import {
  CreateOrderInputSchema,
  CreateOrderResultSchema,
  OrderMutationSchema,
  OrderQuerySchema,
  OrderSchema,
  SkuSchema,
  StockShortageSchema,
} from "./schemas.ts";
import type {
  CommerceStorage,
  CreateOrderInput,
  CreateOrderResult,
  OrderMutator,
} from "./storage-handlers.ts";
import type { Order, Sku } from "./types.ts";

/* -------------------------------------------------------- contract checks */

/** Marks an already-wrapped storage, so wrapping twice costs nothing. */
const CHECKED = Symbol.for("mollie-ecommerce.checkedStorage");

/**
 * Wraps storage handlers so every argument and return value is validated
 * against the documented contract, and a violation fails loudly at the call
 * site instead of corrupting an order three steps later.
 *
 * **Internal.** `createCommerce` applies this to every storage it is given, so
 * the contract is always enforced and there is nothing for a consumer to
 * switch on or import. `describeCommerceStorage` applies it too; wrapping an
 * already-wrapped storage returns it unchanged, so composing them is free.
 *
 * It checks shapes with {@link ../schemas.ts zod schemas} and also the things
 * a schema cannot express: that `loadSkus` returns only SKUs that were asked
 * for, without duplicates; that `createOrder` returns the order it was given,
 * with a version; and that `mutateOrder` returns the order it was asked to
 * change, with a higher version than it started with.
 *
 * Validated values are passed through **unchanged** — the original object is
 * returned, never zod's parsed copy, so nothing is stripped or coerced. Errors
 * your handlers throw are passed through too; only a thrown `out_of_stock` is
 * inspected, since its shortages are part of the contract.
 *
 * Validating one order costs roughly 2µs, which is noise beside the database
 * round trip that produced it.
 */
export function checkedStorage(storage: CommerceStorage): CommerceStorage {
  if (isChecked(storage)) return storage;

  const checked: CommerceStorage = {
    async loadSkus(ids: string[]): Promise<Sku[]> {
      check("loadSkus", "arguments", z.array(z.string()), ids);
      const skus = await storage.loadSkus(ids);
      check("loadSkus", "return value", z.array(SkuSchema), skus);

      const returned = skus.map((sku) => sku.id);
      const unexpected = returned.filter((id) => !ids.includes(id));
      if (unexpected.length > 0) {
        throw violation("loadSkus", `returned SKUs that were not requested: ${unexpected.join(", ")}`);
      }
      if (new Set(returned).size !== returned.length) {
        throw violation("loadSkus", "returned the same SKU more than once");
      }
      return skus;
    },

    async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
      check("createOrder", "arguments", CreateOrderInputSchema, input);

      let result: CreateOrderResult;
      try {
        result = await storage.createOrder(input);
      } catch (error) {
        // Throwing `out_of_stock` is an allowed alternative to returning it,
        // so its shortages are held to the same shape.
        if (error instanceof CommerceError && error.code === "out_of_stock") {
          const shortages = error.details?.shortages;
          if (shortages !== undefined) {
            check("createOrder", "the shortages it threw", z.array(StockShortageSchema), shortages);
          }
        }
        throw error;
      }
      check("createOrder", "return value", CreateOrderResultSchema, result);

      if (result.status === "created") {
        if (result.order.id !== input.order.id) {
          throw violation(
            "createOrder",
            `returned order ${result.order.id} but was given ${input.order.id}`,
          );
        }
        if (result.order.version < 1) {
          throw violation("createOrder", "must assign a version of at least 1");
        }
      }
      return result;
    },

    async mutateOrder(orderId: string, apply: OrderMutator): Promise<Order> {
      check("mutateOrder", "arguments", z.string().min(1), orderId);

      // Both directions of the callback are part of the contract: the order
      // handed to the mutator, and the mutation handed back.
      let seen: Order | undefined;
      const checkedApply: OrderMutator = async (order) => {
        check("mutateOrder", "the order passed to the mutator", OrderSchema, order);
        if (order.id !== orderId) {
          throw violation("mutateOrder", `passed order ${order.id} to a mutator for ${orderId}`);
        }
        seen = { ...order };
        const mutation = (await apply(order)) ?? {};
        check("mutateOrder", "the mutation", OrderMutationSchema, mutation);
        return mutation;
      };

      const updated = await storage.mutateOrder(orderId, checkedApply);
      check("mutateOrder", "return value", OrderSchema, updated);

      if (updated.id !== orderId) {
        throw violation("mutateOrder", `returned order ${updated.id} but was asked for ${orderId}`);
      }
      if (!seen) {
        throw violation("mutateOrder", "never called the mutator");
      }
      if (updated.version <= seen.version) {
        throw violation(
          "mutateOrder",
          `returned version ${updated.version}, which is not newer than ${seen.version}`,
        );
      }
      return updated;
    },

    findOrder: (id: string) => readOrder("findOrder", id, () => storage.findOrder(id)),
    findOrderByPaymentId: (paymentId: string) =>
      readOrder("findOrderByPaymentId", paymentId, () => storage.findOrderByPaymentId(paymentId)),
    findOrderByIdempotencyKey: (key: string) =>
      readOrder("findOrderByIdempotencyKey", key, () => storage.findOrderByIdempotencyKey(key)),

    async listOrders(query?: OrderQuery): Promise<Order[]> {
      if (query !== undefined) check("listOrders", "arguments", OrderQuerySchema, query);
      const orders = await storage.listOrders(query);
      check("listOrders", "return value", z.array(OrderSchema), orders);
      return orders;
    },
  };


  Object.defineProperty(checked, CHECKED, { value: true, enumerable: false });
  return checked;

  async function readOrder(
    handler: string,
    key: string,
    read: () => Promise<Order | null>,
  ): Promise<Order | null> {
    check(handler, "arguments", z.string().min(1), key);
    const order = await read();
    if (order !== null) check(handler, "return value", OrderSchema, order);
    return order;
  }
}

/** True when {@link checkedStorage} already wrapped this storage. */
export function isChecked(storage: CommerceStorage): boolean {
  return (storage as unknown as Record<PropertyKey, unknown>)[CHECKED] === true;
}

function check(handler: string, what: string, schema: z.ZodType, value: unknown): void {
  const result = schema.safeParse(value);
  if (result.success) return;

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  const summary = issues
    .slice(0, 3)
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");

  throw new CommerceError(
    "storage_contract",
    `${handler} ${what} does not match the storage contract — ${summary}`,
    { handler, what, issues },
  );
}

function violation(handler: string, message: string): CommerceError {
  return new CommerceError("storage_contract", `${handler} ${message}`, { handler });
}

/* ----------------------------------------------------------- error handler */

/** Which handler failed, and what it was working on. */
export type StorageErrorContext = {
  handler: keyof CommerceStorage;
  /** Present when the call targeted one order. */
  orderId?: string;
  /** Present for `loadSkus`. */
  skuIds?: string[];
  /** Present for the lookups that take a key. */
  key?: string;
};

/**
 * Handles an error thrown inside a storage handler.
 *
 * - Return a {@link CommerceError} to **translate** it — a driver's unique
 *   violation into `duplicate_order`, a deadlock into `version_conflict` — and
 *   that is what callers of `commerce.*` will see.
 * - Return nothing to **observe only**: log it, count it, and let the original
 *   error through untouched.
 * - Throw to replace it with anything you like.
 *
 * It never swallows: there is no way to make a failed write look like a
 * success, because the commerce layer would then persist nothing and carry on.
 */
export type StorageErrorHandler = (
  error: unknown,
  context: StorageErrorContext,
) => CommerceError | void | Promise<CommerceError | void>;

/**
 * Internal. Routes every error thrown by a storage handler through `onError`
 * first; `createCommerce({ onStorageError })` is the public way to reach it.
 */
export function withStorageErrorHandler(
  storage: CommerceStorage,
  onError: StorageErrorHandler,
): CommerceStorage {
  async function guard<T>(context: StorageErrorContext, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const replacement = await onError(error, context);
      if (replacement instanceof CommerceError) throw replacement;
      throw error;
    }
  }

  return {
    loadSkus: (ids) => guard({ handler: "loadSkus", skuIds: ids }, () => storage.loadSkus(ids)),
    createOrder: (input) =>
      guard({ handler: "createOrder", orderId: input.order.id }, () => storage.createOrder(input)),
    mutateOrder: (orderId, apply) =>
      guard({ handler: "mutateOrder", orderId }, () => storage.mutateOrder(orderId, apply)),
    findOrder: (id) => guard({ handler: "findOrder", orderId: id }, () => storage.findOrder(id)),
    findOrderByPaymentId: (paymentId) =>
      guard({ handler: "findOrderByPaymentId", key: paymentId }, () =>
        storage.findOrderByPaymentId(paymentId),
      ),
    findOrderByIdempotencyKey: (key) =>
      guard({ handler: "findOrderByIdempotencyKey", key }, () =>
        storage.findOrderByIdempotencyKey(key),
      ),
    listOrders: (query) => guard({ handler: "listOrders" }, () => storage.listOrders(query)),
  };
}
