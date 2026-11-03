export * from "./money.ts";
export * from "./types.ts";
export * from "./ports.ts";
export * from "./errors.ts";
export * from "./delivery.ts";
export * from "./commerce.ts";
export * from "./fake-gateway.ts";
export { createMollieGateway, toSnapshot } from "./mollie.ts";
export type { MollieGatewayOptions } from "./mollie.ts";

/* Storage: ports live in `ports.ts`, implementations here. */
export {
  InMemoryDatabase,
  InMemoryOrderStore,
  InMemoryProductStore,
} from "./storage/memory.ts";
// The SQL adapter is NOT re-exported here: it imports `bun:sqlite`, and the
// core must stay runtime-agnostic. Import it from `mollie-ecommerce/storage/sqlite`.
export {
  orderToRow,
  productToRow,
  rowToOrder,
  rowToProduct,
  SCHEMA_SQL,
  type OrderRow,
  type ProductRow,
} from "./storage/rows.ts";
