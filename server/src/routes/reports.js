import { BOARDS, getSetting } from '../db.js';
import { bad, forbidden, notFound } from '../app.js';
import { r2, today } from '../money.js';
import { overview, ledgerFor, canSeeSupplier, visibleSupplierIds } from '../ledger.js';
import { tableWorkbook } from '../xlsx.js';

const BUCKET_NAMES = ['0-30天', '31-60天', '61-90天', '90天以上'];
const MONEY = '#,##0.00';
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const fmt = (n) => Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function sendXlsx(reply, buf, filename) {
  reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return reply.send(buf);
}

/** The message a 跟单员 can paste to the supplier. */
export function dunningText(company, row) {
  const age = row.oldest >= 30 ? `，最早一笔已经欠了 ${row.oldest} 天` : '';
  return `${row.name}您好，截至 ${row.asOf}，贵司在我司${row.board}板块还有 ${fmt(row.owe)} 元发票未开${age}。`
    + `麻烦尽快安排开具数电发票，开好后发给我们。谢谢！——${company}`;
}

export default async function reportRoutes(app) {
  const db = app.db;
  const R = { preHandler: app.auth() };
  const FIN = { preHandler: app.auth('管理员', '财务') };
  const boardOf = (q) => {
    if (q.board == null || q.board === '') return null;
    if (!BOARDS.includes(q.board)) throw bad('板块不对');
    return q.board;
  };
  const asOfOf = (q) => {
    if (q.as_of == null || q.as_of === '') return today();
    if (!isDate(q.as_of)) throw bad('日期格式应为 YYYY-MM-DD');
    return q.as_of;
  };

  /** Outstanding per supplier × board, plus the to-do counts for the home page. */
  app.get('/api/overview', R, async (req) => {
    const o = overview(db, req.user, boardOf(req.query), asOfOf(req.query));
    const ids = visibleSupplierIds(db, req.user);
    const mine = (sql) => db.prepare(sql).all().filter((r) => ids === null || ids.includes(r.supplier_id)).length;
    const counts = {
      statements_pending: mine("SELECT supplier_id FROM statements WHERE status = '待终审'"),
      statements_rejected: mine("SELECT supplier_id FROM statements WHERE status = '已驳回'"),
      statements_draft: mine("SELECT supplier_id FROM statements WHERE status = '草稿'"),
      invoices_pending: req.user.role === '跟单员' ? 0 : db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = '待处理'").get().n,
    };
    return { ...o, counts };
  });

  /** Everything about one supplier: ledger per board, statements, invoices, tax costs, entities. */
  app.get('/api/suppliers/:id/detail', R, async (req) => {
    const s = db.prepare(`SELECT s.*, u.name AS owner_name FROM suppliers s LEFT JOIN users u ON u.id = s.owner_id WHERE s.id = ?`).get(req.params.id);
    if (!s) throw notFound();
    if (!canSeeSupplier(db, req.user, s.id)) throw forbidden('这个供应商不归你负责');
    const board = boardOf(req.query);
    const asOf = asOfOf(req.query);
    const allBoards = db.prepare('SELECT board FROM supplier_boards WHERE supplier_id = ? ORDER BY board').all(s.id).map((r) => r.board);
    const boards = allBoards.filter((b) => !board || b === board);
    const ledgers = boards.map((b) => ({ board: b, ...ledgerFor(db, s.id, b, asOf) }));
    const bf = board ? ' AND board = ?' : '';
    const args = board ? [s.id, board] : [s.id];
    const statements = db.prepare(`SELECT id, code, kind, board, period_from, period_to, mode, rate, amount, gross, tax_cost, status, approved_at, created_at
      FROM statements WHERE supplier_id = ?${bf} AND status != '已作废' ORDER BY id DESC`).all(...args);
    const invoices = db.prepare(`SELECT id, number, issue_date, type, seller_name, seller_tax_id, buyer_name, net, tax, total, board, status, moved, red_of, file_name
      FROM invoices WHERE supplier_id = ?${bf} ORDER BY issue_date DESC, id DESC`).all(...args);
    const taxCosts = req.user.role === '跟单员' ? [] : db.prepare(`SELECT * FROM tax_costs WHERE supplier_id = ?${bf} ORDER BY paid_at DESC, id DESC`).all(...args);
    const entities = db.prepare(`SELECT e.* FROM entities e JOIN entity_suppliers es ON es.entity_id = e.id WHERE es.supplier_id = ? ORDER BY e.name`).all(s.id);
    const company = getSetting(db, 'company_name');
    return {
      supplier: s, boards: allBoards, asOf, ledgers, statements, invoices, tax_costs: taxCosts, entities,
      tax_cost_total: r2(taxCosts.reduce((a, t) => a + t.amount, 0)),
      dunning: ledgers.filter((l) => l.owe > 0.004).map((l) => dunningText(company, { ...l, name: s.name, asOf })),
    };
  });

  /** Suppliers that owe invoices, with a ready-to-send message each. */
  app.get('/api/dunning', R, async (req) => {
    const o = overview(db, req.user, boardOf(req.query), asOfOf(req.query));
    const min = Number(req.query.min) || 0;
    const company = getSetting(db, 'company_name');
    return o.rows.filter((r) => r.owe > Math.max(min, 0.004))
      .map((r) => ({ supplier_id: r.id, code: r.code, name: r.name, board: r.board, owner_name: r.owner_name, owe: r.owe, oldest: r.oldest, buckets: r.buckets,
        text: dunningText(company, { ...r, asOf: o.asOf }) }));
  });

  // ---- Excel exports ----
  app.get('/api/export/overview', R, async (req, reply) => {
    const o = overview(db, req.user, boardOf(req.query), asOfOf(req.query));
    const rows = o.rows.map((r) => ({
      code: r.code, name: r.name, board: r.board, owner: r.owner_name || '', opening: r.opening, should: r.should, done: r.done, owe: r.owe,
      b0: r.buckets[0], b1: r.buckets[1], b2: r.buckets[2], b3: r.buckets[3], oldest: r.oldest ?? '',
    }));
    rows.push({ code: '合计', should: o.totals.should, done: o.totals.done, owe: o.totals.owe,
      b0: o.totals.buckets[0], b1: o.totals.buckets[1], b2: o.totals.buckets[2], b3: o.totals.buckets[3] });
    const buf = await tableWorkbook([{
      name: '欠票总览',
      columns: [
        { header: '编号', key: 'code', width: 8 }, { header: '供应商', key: 'name', width: 20 }, { header: '板块', key: 'board', width: 8 },
        { header: '跟单员', key: 'owner', width: 10 }, { header: '期初欠票', key: 'opening', numFmt: MONEY },
        { header: '应开票', key: 'should', numFmt: MONEY }, { header: '已开票', key: 'done', numFmt: MONEY }, { header: '欠票', key: 'owe', numFmt: MONEY },
        ...BUCKET_NAMES.map((h, i) => ({ header: h, key: 'b' + i, numFmt: MONEY })), { header: '最早欠票天数', key: 'oldest', width: 12 },
      ],
      rows,
      note: `截至 ${o.asOf}。应开票 = 期初欠票 + 已生效对账单和调整单（含税）；已开票 = 已入账发票（红字发票为负）。账龄按先开先抵计算。`,
    }]);
    return sendXlsx(reply, buf, `欠票总览_${o.asOf}.xlsx`);
  });

  app.get('/api/export/invoices', FIN, async (req, reply) => {
    const { from, to, status } = req.query;
    const board = boardOf(req.query);
    if ((from && !isDate(from)) || (to && !isDate(to))) throw bad('日期格式应为 YYYY-MM-DD');
    const rows = db.prepare(`SELECT i.*, s.name AS supplier_name FROM invoices i LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE (? IS NULL OR i.board = ?) AND (? IS NULL OR i.status = ?) AND (? IS NULL OR i.issue_date >= ?) AND (? IS NULL OR i.issue_date <= ?)
      ORDER BY i.issue_date, i.id`).all(board, board, status || null, status || null, from || null, from || null, to || null, to || null);
    const buf = await tableWorkbook([{
      name: '发票明细',
      columns: [
        { header: '发票号码', key: 'number', width: 24 }, { header: '开票日期', key: 'issue_date', width: 12 }, { header: '类型', key: 'type', width: 12 },
        { header: '销售方', key: 'seller_name', width: 28 }, { header: '销售方税号', key: 'seller_tax_id', width: 22 },
        { header: '购买方', key: 'buyer_name', width: 28 }, { header: '归属供应商', key: 'supplier_name', width: 18 }, { header: '板块', key: 'board', width: 8 },
        { header: '金额', key: 'net', numFmt: MONEY }, { header: '税额', key: 'tax', numFmt: MONEY }, { header: '价税合计', key: 'total', numFmt: MONEY },
        { header: '状态', key: 'status', width: 10 }, { header: '待处理原因', key: 'pending_reason', width: 16 }, { header: '红冲原票', key: 'red_of', width: 24 },
      ],
      rows: rows.map((r) => ({ ...r, supplier_name: r.supplier_name || '' })),
    }]);
    return sendXlsx(reply, buf, `发票明细_${today()}.xlsx`);
  });

  app.get('/api/export/tax-costs', FIN, async (req, reply) => {
    const board = boardOf(req.query);
    const rows = db.prepare(`SELECT t.*, s.name AS supplier_name FROM tax_costs t JOIN suppliers s ON s.id = t.supplier_id
      WHERE (? IS NULL OR t.board = ?) ORDER BY t.paid_at, t.id`).all(board, board);
    const byS = new Map();
    for (const r of rows) {
      const k = `${r.supplier_name}|${r.board}`;
      byS.set(k, r2((byS.get(k) || 0) + r.amount));
    }
    const buf = await tableWorkbook([
      {
        name: '税费成本明细',
        columns: [
          { header: '支付日期', key: 'paid_at', width: 12 }, { header: '供应商', key: 'supplier_name', width: 20 }, { header: '板块', key: 'board', width: 8 },
          { header: '金额', key: 'amount', numFmt: MONEY }, { header: '对应发票', key: 'invoice_number', width: 24 }, { header: '备注', key: 'note', width: 30 },
        ],
        rows,
      },
      {
        name: '按供应商汇总',
        columns: [{ header: '供应商', key: 's', width: 20 }, { header: '板块', key: 'b', width: 8 }, { header: '税费成本合计', key: 't', width: 14, numFmt: MONEY }],
        rows: [...byS].map(([k, t]) => { const [s, b] = k.split('|'); return { s, b, t }; }),
      },
    ]);
    return sendXlsx(reply, buf, `税费成本_${today()}.xlsx`);
  });
}
