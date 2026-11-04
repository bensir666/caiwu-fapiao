/** Round to cents. */
export const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Days between two ISO dates (YYYY-MM-DD...), b - a. */
export const daysBetween = (a, b) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 864e5);

export const today = () => new Date().toISOString().slice(0, 10);

/**
 * Split a statement amount into net / tax / gross.
 * mode '含税': amount already includes tax; '不含税': tax is added on top.
 */
export function splitAmount(amount, rate, mode) {
  const a = Number(amount), r = Number(rate);
  if (mode === '含税') {
    const net = r2(a / (1 + r));
    return { net, tax: r2(a - net), gross: r2(a) };
  }
  const tax = r2(a * r);
  return { net: r2(a), tax, gross: r2(a + tax) };
}

/** Aging buckets in days: 0-30, 31-60, 61-90, 90+. */
export function bucketOf(days) {
  return days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3;
}

/**
 * Outstanding for one supplier × board.
 * items: [{date, amount}] — opening balance and approved statements (adjustments may be negative).
 * paid:  total of booked invoices (red invoices already negative).
 * Invoices settle the oldest items first (FIFO). Returns owe, aging buckets and the oldest unpaid age.
 */
export function computeLedger(items, paid, asOf) {
  const sorted = items.filter((i) => Math.abs(i.amount) > 0.004).sort((a, b) => a.date.localeCompare(b.date));
  const should = r2(sorted.reduce((s, i) => s + i.amount, 0));
  const done = r2(paid);
  const owe = r2(should - done);
  const buckets = [0, 0, 0, 0];
  let oldest = null;
  if (owe > 0.004) {
    // Walk from the newest item backwards: the unpaid part is always the newest `owe` amount,
    // so the buckets always add up to owe.
    let left = owe;
    for (let k = sorted.length - 1; k >= 0 && left > 0.004; k--) {
      const it = sorted[k];
      if (it.amount <= 0) continue; // credits (negative adjustments) already reduced owe, like invoices do
      const part = Math.min(left, it.amount);
      const d = Math.max(0, daysBetween(it.date, asOf));
      buckets[bucketOf(d)] = r2(buckets[bucketOf(d)] + part);
      oldest = oldest === null ? d : Math.max(oldest, d);
      left = r2(left - part);
    }
  }
  return { should, done, owe, buckets, oldest };
}
