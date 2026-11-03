/**
 * Money is stored in minor units (cents) to keep arithmetic exact.
 * Mollie speaks decimal strings, so we convert at the boundary only.
 */
export type Currency = string;

export type Money = {
  /** Integer amount in minor units, e.g. 1050 for EUR 10.50 */
  cents: number;
  currency: Currency;
};

/** Currencies Mollie expects without decimals. */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "ISK", "VND", "CLP"]);
/** Currencies Mollie expects with three decimals. */
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

export function decimals(currency: Currency): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

export function money(cents: number, currency: Currency): Money {
  if (!Number.isInteger(cents)) {
    throw new TypeError(`money() expects integer minor units, got ${cents}`);
  }
  return { cents, currency: currency.toUpperCase() };
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { cents: a.cents + b.cents, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { cents: a.cents - b.cents, currency: a.currency };
}

export function multiply(a: Money, factor: number): Money {
  return { cents: Math.round(a.cents * factor), currency: a.currency };
}

export function sum(amounts: Money[], currency?: Currency): Money {
  const first = amounts[0];
  if (!first) {
    if (!currency) throw new TypeError("sum() of an empty list needs a currency");
    return money(0, currency);
  }
  return amounts.slice(1).reduce(add, first);
}

export function isZero(a: Money): boolean {
  return a.cents === 0;
}

export function compare(a: Money, b: Money): number {
  sameCurrency(a, b);
  return a.cents - b.cents;
}

/** Mollie wire format: `{ currency: "EUR", value: "10.50" }`. */
export function toMollieAmount(a: Money): { currency: string; value: string } {
  const d = decimals(a.currency);
  const sign = a.cents < 0 ? "-" : "";
  const abs = Math.abs(a.cents).toString().padStart(d + 1, "0");
  const value = d === 0
    ? abs
    : `${abs.slice(0, abs.length - d)}.${abs.slice(abs.length - d)}`;
  return { currency: a.currency, value: `${sign}${value}` };
}

export function fromMollieAmount(a: { currency: string; value: string }): Money {
  const d = decimals(a.currency);
  const negative = a.value.trim().startsWith("-");
  const [whole = "0", fraction = ""] = a.value.trim().replace("-", "").split(".");
  const cents = Number(`${whole}${fraction.padEnd(d, "0").slice(0, d)}`);
  return money(negative ? -cents : cents, a.currency);
}

export function formatMoney(a: Money): string {
  const { currency, value } = toMollieAmount(a);
  return `${value} ${currency}`;
}
