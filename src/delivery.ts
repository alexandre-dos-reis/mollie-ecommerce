import { CommerceError } from "./errors.ts";
import type { DeliveryState } from "./types.ts";

/** Allowed delivery transitions. Anything not listed here is rejected. */
const TRANSITIONS: Record<DeliveryState, readonly DeliveryState[]> = {
  not_started: ["ready", "canceled"],
  ready: ["shipped", "delivered", "canceled"],
  shipped: ["delivered", "returned"],
  delivered: ["returned"],
  returned: [],
  canceled: [],
};

export function canTransition(from: DeliveryState, to: DeliveryState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: DeliveryState, to: DeliveryState): void {
  if (!canTransition(from, to)) {
    throw new CommerceError(
      "invalid_delivery_transition",
      `cannot move delivery from "${from}" to "${to}"`,
      { from, to, allowed: TRANSITIONS[from] },
    );
  }
}

export function nextDeliveryStates(from: DeliveryState): readonly DeliveryState[] {
  return TRANSITIONS[from];
}
