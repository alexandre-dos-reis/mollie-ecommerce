import type { StockShortage } from "./ports.ts";

export type CommerceErrorCode =
  | "sku_not_found"
  | "sku_inactive"
  | "out_of_stock"
  | "order_not_found"
  | "empty_cart"
  | "currency_mismatch"
  | "not_payable"
  | "not_refundable"
  | "refund_too_large"
  | "invalid_delivery_transition"
  | "gateway_error"
  /** Someone else updated the order first; reload and retry. */
  | "version_conflict"
  | "duplicate_order"
  | "storage_error"
  /** A storage handler broke its contract — see `checkedStorage`. */
  | "storage_contract";

export class CommerceError extends Error {
  constructor(
    readonly code: CommerceErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    /** Standard `Error` options, so `{ cause }` survives for your logs. */
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommerceError";
  }
}

/**
 * Errors a storage handler is expected to raise, pre-shaped so your handlers
 * speak the same vocabulary the rest of the library does — and so your
 * application's error mapping only ever has to know `CommerceError.code`.
 *
 * ```ts
 * async mutateOrder(orderId, apply) {
 *   const order = await db.loadOrder(orderId);
 *   if (!order) throw storageError.orderNotFound(orderId);
 *   // …
 *   if (!written) throw storageError.versionConflict(orderId, order.version);
 * }
 * ```
 *
 * Throwing anything else is fine too: it travels out through whichever
 * `commerce.*` method was running, and `onStorageError` can translate it.
 */
export const storageError = {
  /**
   * Not enough stock. `createOrder` may either return
   * `{ status: "out_of_stock", shortages }` or throw this — whichever suits
   * your implementation, since aborting a transaction usually means throwing.
   *
   * @param shortages What fell short, as `reserveStock` reported it.
   */
  outOfStock(shortages: StockShortage[]): CommerceError {
    const first = shortages[0];
    return new CommerceError(
      "out_of_stock",
      first ? `sku ${first.skuId} is out of stock` : "out of stock",
      { shortages },
    );
  },

  /**
   * The order a handler was asked for does not exist. `mutateOrder` must throw
   * this; the read handlers return `null` instead.
   *
   * @param orderId The id that was not found.
   */
  orderNotFound(orderId: string): CommerceError {
    return new CommerceError("order_not_found", `no order ${orderId}`, { orderId });
  },

  /**
   * Someone else wrote the order first, so this write was refused rather than
   * allowed to overwrite. Callers are expected to re-read and retry.
   *
   * @param orderId The contested order.
   * @param expected The version the write was based on.
   * @param actual The version found in storage, if you know it.
   */
  versionConflict(orderId: string, expected?: number, actual?: number): CommerceError {
    const detail =
      expected === undefined
        ? ""
        : actual === undefined
          ? ` (expected version ${expected})`
          : ` (expected version ${expected}, found ${actual})`;
    return new CommerceError(
      "version_conflict",
      `order ${orderId} was modified concurrently${detail}`,
      { orderId, expected, actual },
    );
  },

  /**
   * An order already exists with that id, payment id, or idempotency key —
   * typically a unique-index violation from `createOrder`.
   *
   * @param orderId The order being inserted.
   * @param cause The driver error, kept for your logs.
   */
  duplicateOrder(orderId: string, cause?: unknown): CommerceError {
    return new CommerceError(
      "duplicate_order",
      `order ${orderId} already exists`,
      { orderId },
      { cause },
    );
  },

  /**
   * Storage failed for a reason the library has no opinion about: a dropped
   * connection, a timeout, a disk error.
   *
   * @param message What went wrong, for your logs.
   * @param cause The underlying error.
   */
  failed(message: string, cause?: unknown): CommerceError {
    return new CommerceError("storage_error", message, undefined, { cause });
  },
};

