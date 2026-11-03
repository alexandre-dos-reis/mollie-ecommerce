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
  | "storage_error";

export class CommerceError extends Error {
  constructor(
    readonly code: CommerceErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CommerceError";
  }
}

/** Thrown by stores on optimistic-concurrency mismatch. */
export function versionConflict(orderId: string, expected: number, actual: number): CommerceError {
  return new CommerceError(
    "version_conflict",
    `order ${orderId} was modified concurrently (expected version ${expected}, found ${actual})`,
    { orderId, expected, actual },
  );
}
