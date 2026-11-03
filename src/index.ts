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
  InMemorySkuStore,
} from "./storage/memory.ts";
// The SQL adapters are NOT re-exported here, so the core pulls in nothing.
// Import them from `mollie-ecommerce/storage/sqlite` (which needs
// `bun:sqlite`) and `mollie-ecommerce/storage/postgres` (bring your own
// driver).
export { aggregateStock } from "./storage/stock.ts";
export {
  orderToRow,
  skuToRow,
  rowToOrder,
  rowToSku,
  SCHEMA_SQL,
  type OrderRow,
  type SkuRow,
} from "./storage/rows.ts";
