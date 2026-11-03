import type { StockChange } from "../ports.ts";

/**
 * Collapses repeated product ids into one change each.
 *
 * Every adapter must do this before touching stock: checking `[2, 2]` against
 * a stock of 3 passes twice if the lines are treated independently, and then
 * decrements 4 — overselling. Commerce merges cart lines before it gets here,
 * but the port is public, so the guarantee belongs in the adapters.
 */
export function aggregateStock(items: StockChange[]): StockChange[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.productId, (totals.get(item.productId) ?? 0) + item.quantity);
  }
  return [...totals].map(([productId, quantity]) => ({ productId, quantity }));
}
