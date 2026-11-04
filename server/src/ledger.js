import { computeLedger, r2, today } from './money.js';
import { getSetting } from './db.js';

/** Supplier ids a user may see: everything, or a 跟单员's own suppliers. */
export function visibleSupplierIds(db, user) {
  if (user.role !== '跟单员') return null; // null = no restriction
  return db.prepare('SELECT id FROM suppliers WHERE owner_id = ?').all(user.id).map((r) => r.id);
}

export function canSeeSupplier(db, user, supplierId) {
  const ids = visibleSupplierIds(db, user);
  return ids === null || ids.includes(Number(supplierId));
}

/** Ledger for one supplier × board. */
export function ledgerFor(db, supplierId, board, asOf = today()) {
  const sb = db.prepare('SELECT opening FROM supplier_boards WHERE supplier_id = ? AND board = ?').get(supplierId, board);
  const openingDate = getSetting(db, 'opening_date', asOf);
  const items = [];
  if (sb && sb.opening) items.push({ date: openingDate, amount: sb.opening });
  for (const s of db.prepare("SELECT gross, approved_at FROM statements WHERE supplier_id = ? AND board = ? AND status = '已生效'").all(supplierId, board)) {
    items.push({ date: s.approved_at.slice(0, 10), amount: s.gross });
  }
  const paid = db.prepare("SELECT COALESCE(SUM(total), 0) AS t FROM invoices WHERE supplier_id = ? AND board = ? AND status = '已入账'").get(supplierId, board).t;
  return { opening: sb ? sb.opening : 0, ...computeLedger(items, paid, asOf) };
}

/** All supplier × board rows a user may see, optionally for one board. */
export function overview(db, user, board, asOf = today()) {
  const ids = visibleSupplierIds(db, user);
  const rows = db.prepare(`
    SELECT s.id, s.code, s.name, s.tax_cost, s.owner_id, s.active, u.name AS owner_name, sb.board
    FROM suppliers s JOIN supplier_boards sb ON sb.supplier_id = s.id
    LEFT JOIN users u ON u.id = s.owner_id
    ORDER BY s.code`).all()
    .filter((r) => (ids === null || ids.includes(r.id)) && (!board || r.board === board));
  const out = rows.map((r) => ({ ...r, ...ledgerFor(db, r.id, r.board, asOf) }))
    .filter((r) => r.active || Math.abs(r.owe) > 0.004)
    .sort((a, b) => b.owe - a.owe);
  const sum = (k) => r2(out.reduce((s, r) => s + r[k], 0));
  const buckets = [0, 1, 2, 3].map((i) => r2(out.reduce((s, r) => s + r.buckets[i], 0)));
  return { asOf, rows: out, totals: { should: sum('should'), done: sum('done'), owe: sum('owe'), buckets } };
}

/** Outstanding helper used by invoice attribution. */
export function oweOf(db, supplierId, board) {
  return ledgerFor(db, supplierId, board).owe;
}
