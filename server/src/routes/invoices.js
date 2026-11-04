import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BOARDS, audit } from '../db.js';
import { HttpError, bad, forbidden, notFound } from '../app.js';
import { r2, today } from '../money.js';
import { classifyInvoice } from '../classify.js';
import { parseInvoiceFile } from '../parsers.js';
import { saveEntityRow } from './master.js';
import { oweOf, visibleSupplierIds, canSeeSupplier } from '../ledger.js';

const TYPES = ['数电专票', '数电普票', '纸质专票', '纸质普票'];
const ALLOWED_EXT = ['.pdf', '.xml', '.ofd', '.jpg', '.jpeg', '.png', '.webp'];
const TOKEN = /^[a-f0-9]{32}$/;

export default async function invoiceRoutes(app) {
  const db = app.db;
  const R = { preHandler: app.auth() };
  const FIN = { preHandler: app.auth('管理员', '财务') };
  const tmpDir = path.join(app.uploadDir, 'tmp');

  const ctx = {
    invoiceExists: (n) => !!db.prepare('SELECT 1 FROM invoices WHERE number = ?').get(n),
    buyerByTax: (t) => db.prepare('SELECT name, board FROM buyers WHERE tax_id = ? AND active = 1').get(String(t || '').toUpperCase()) || null,
    suppliersForEntity: (t) => {
      const e = db.prepare('SELECT id FROM entities WHERE tax_id = ?').get(String(t || '').toUpperCase());
      if (!e) return null;
      return db.prepare('SELECT s.id, s.name FROM entity_suppliers es JOIN suppliers s ON s.id = es.supplier_id WHERE es.entity_id = ? AND s.active = 1').all(e.id)
        .map((s) => ({ ...s, boards: db.prepare('SELECT board FROM supplier_boards WHERE supplier_id = ?').all(s.id).map((x) => x.board) }));
    },
    owe: (sid, board) => oweOf(db, sid, board),
  };

  const clean = (f = {}) => ({
    number: String(f.number || '').replace(/\s/g, ''),
    issue_date: f.issue_date || null,
    type: TYPES.includes(f.type) ? f.type : '数电专票',
    seller_name: f.seller_name ? String(f.seller_name).trim() : null,
    seller_tax_id: f.seller_tax_id ? String(f.seller_tax_id).trim().toUpperCase() : null,
    buyer_name: f.buyer_name ? String(f.buyer_name).trim() : null,
    buyer_tax_id: f.buyer_tax_id ? String(f.buyer_tax_id).trim().toUpperCase() : null,
    net: f.net === '' || f.net == null ? null : r2(Number(f.net)),
    tax: f.tax === '' || f.tax == null ? null : r2(Number(f.tax)),
    total: f.total === '' || f.total == null ? null : r2(Number(f.total)),
    rate: f.rate === '' || f.rate == null ? null : Number(f.rate),
    remark: f.remark ? String(f.remark).slice(0, 500) : null,
  });

  const supplierName = (id) => (id ? db.prepare('SELECT name FROM suppliers WHERE id = ?').get(id)?.name : null);
  const describe = (c) => ({
    ...c,
    supplier_name: supplierName(c.supplier_id),
    candidates: c.candidates ? c.candidates.map((id) => ({ id, name: supplierName(id), owe: c.board ? oweOf(db, id, c.board) : null })) : null,
  });

  app.post('/api/invoices/parse', R, async (req) => {
    const file = await req.file();
    if (!file) throw bad('请选择发票文件');
    const ext = path.extname(file.filename || '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) throw bad('支持 PDF、XML、OFD 和图片文件');
    const buf = await file.toBuffer();
    const token = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(tmpDir, token), buf);
    fs.writeFileSync(path.join(tmpDir, token + '.json'), JSON.stringify({ name: file.filename, ext, user: req.user.id, at: Date.now() }));
    let parsed = { source: 'other', fields: null };
    let error = null;
    try {
      parsed = await parseInvoiceFile(buf, file.filename, (t) => !!ctx.buyerByTax(t));
    } catch (e) {
      req.log.warn(e);
      error = '自动识别失败，请对照原件手工填写';
    }
    if (parsed.source === 'other') error = ext === '.ofd' ? 'OFD 暂不支持自动识别，请上传同一张发票的 XML 或 PDF，或手工填写' : '图片暂不支持自动识别，请手工填写，原件会一起存档';
    const fields = parsed.fields ? clean(parsed.fields) : null;
    return { token, file_name: file.filename, source: parsed.source, fields, error, preview: fields ? describe(classifyInvoice(fields, ctx)) : null };
  });

  app.post('/api/invoices/preview', R, async (req) => describe(classifyInvoice(clean(req.body?.fields), ctx)));

  const moveTmp = (token, number) => {
    if (!token) return { file_path: null, file_name: null };
    if (!TOKEN.test(token)) throw bad('文件凭证无效');
    const meta = path.join(tmpDir, token + '.json');
    if (!fs.existsSync(meta)) throw bad('上传的文件已过期，请重新上传');
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    const rel = path.join(today().slice(0, 7), `${number}${m.ext}`);
    fs.mkdirSync(path.join(app.uploadDir, path.dirname(rel)), { recursive: true });
    fs.renameSync(path.join(tmpDir, token), path.join(app.uploadDir, rel));
    fs.unlinkSync(meta);
    return { file_path: rel, file_name: m.name };
  };

  app.post('/api/invoices', R, async (req) => {
    const f = clean(req.body?.fields);
    const c = classifyInvoice(f, ctx);
    if (c.status === '重复') throw new HttpError(409, `发票 ${f.number} 已经录入过，不能重复入账`);
    if (c.pending_reason === '信息不完整') throw bad('发票号码和金额必须填写完整');
    const file = moveTmp(req.body?.token, f.number);
    const r = db.prepare(`INSERT INTO invoices(number, issue_date, type, seller_name, seller_tax_id, buyer_name, buyer_tax_id, net, tax, total, rate, remark, red_of,
        supplier_id, board, status, pending_reason, candidates, moved, source, file_path, file_name, created_by, booked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, CASE WHEN ? = '已入账' THEN datetime('now') END)`)
      .run(f.number, f.issue_date, f.type, f.seller_name, f.seller_tax_id, f.buyer_name, f.buyer_tax_id, f.net, f.tax, f.total, f.rate, f.remark, c.red_of,
        c.supplier_id, c.board, c.status, c.pending_reason, c.candidates ? JSON.stringify(c.candidates) : null, c.moved,
        req.body?.source || 'manual', file.file_path, file.file_name, req.user.id, c.status);
    audit(db, req.user.id, 'invoice', r.lastInsertRowid, c.status === '已入账' ? '上传并入账' : '上传，进入待处理', { number: f.number, total: f.total, reason: c.pending_reason });
    const taxCost = c.supplier_id && c.status === '已入账' && db.prepare('SELECT tax_cost FROM suppliers WHERE id = ?').get(c.supplier_id).tax_cost && f.total > 0;
    return { id: r.lastInsertRowid, ...describe(c), tax_cost_reminder: !!taxCost };
  });

  app.get('/api/invoices', R, async (req) => {
    const ids = visibleSupplierIds(db, req.user);
    const { status, board, supplier_id, q } = req.query;
    const like = q ? `%${q}%` : null;
    const rows = db.prepare(`SELECT i.*, s.name AS supplier_name, u.name AS created_by_name FROM invoices i
      LEFT JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN users u ON u.id = i.created_by
      WHERE (? IS NULL OR i.status = ?) AND (? IS NULL OR i.board = ?) AND (? IS NULL OR i.supplier_id = ?)
        AND (? IS NULL OR i.number LIKE ? OR i.seller_name LIKE ?)
      ORDER BY i.id DESC LIMIT 2000`)
      .all(status ?? null, status ?? null, board ?? null, board ?? null, supplier_id ?? null, supplier_id ?? null, like, like, like);
    return rows
      .filter((r) => ids === null || (r.supplier_id ? ids.includes(r.supplier_id) : r.created_by === req.user.id))
      .map((r) => ({ ...r, candidates: r.candidates ? JSON.parse(r.candidates).map((id) => ({ id, name: supplierName(id), owe: r.board ? oweOf(db, id, r.board) : null })) : null }));
  });

  const getInv = (id) => {
    const i = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!i) throw notFound();
    return i;
  };

  app.get('/api/invoices/:id/file', R, async (req, reply) => {
    const i = getInv(req.params.id);
    if (i.supplier_id ? !canSeeSupplier(db, req.user, i.supplier_id) : (req.user.role === '跟单员' && i.created_by !== req.user.id)) throw forbidden();
    if (!i.file_path) throw notFound('这张发票没有原件');
    const full = path.join(app.uploadDir, i.file_path);
    if (!full.startsWith(app.uploadDir) || !fs.existsSync(full)) throw notFound('原件文件不见了');
    const types = { '.pdf': 'application/pdf', '.xml': 'application/xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.ofd': 'application/octet-stream' };
    reply.header('Content-Type', types[path.extname(full)] || 'application/octet-stream');
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(i.file_name || path.basename(full))}`);
    return reply.send(fs.createReadStream(full));
  });

  const book = (i, supplierId, board, userId, action, extra) => {
    if (!db.prepare('SELECT 1 FROM supplier_boards WHERE supplier_id = ? AND board = ?').get(supplierId, board)) {
      db.prepare('INSERT INTO supplier_boards(supplier_id, board, opening) VALUES (?,?,0)').run(supplierId, board);
    }
    db.prepare("UPDATE invoices SET supplier_id=?, board=?, status='已入账', pending_reason=NULL, candidates=NULL, booked_at=datetime('now') WHERE id=?").run(supplierId, board, i.id);
    audit(db, userId, 'invoice', i.id, action, { supplier_id: supplierId, board, ...extra });
  };

  app.post('/api/invoices/:id/assign', FIN, async (req) => {
    const i = getInv(req.params.id);
    if (i.status !== '待处理') throw bad('这张发票不在待处理中');
    const sid = Number(req.body?.supplier_id);
    if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(sid)) throw bad('请选择供应商');
    const board = BOARDS.includes(req.body?.board) ? req.body.board : i.board;
    if (!board) throw bad('请选择板块');
    if (i.pending_reason === '开票主体未登记' && req.body?.register_entity) {
      const e = db.prepare('SELECT id FROM entities WHERE tax_id = ?').get(i.seller_tax_id);
      if (e) db.prepare('INSERT OR IGNORE INTO entity_suppliers(entity_id, supplier_id) VALUES (?,?)').run(e.id, sid);
      else saveEntityRow(db, null, { name: i.seller_name || i.seller_tax_id, tax_id: i.seller_tax_id, supplier_ids: [sid] }, req.user.id);
    }
    book(i, sid, board, req.user.id, '财务分配并入账', { reason: i.pending_reason, registered: !!req.body?.register_entity });
    return { ok: true };
  });

  app.post('/api/invoices/:id/return', FIN, async (req) => {
    const i = getInv(req.params.id);
    if (i.status !== '待处理') throw bad('只有待处理的发票可以退回');
    const reason = String(req.body?.reason || i.pending_reason || '').slice(0, 300);
    db.prepare("UPDATE invoices SET status='已退回', pending_reason=? WHERE id=?").run(reason, i.id);
    audit(db, req.user.id, 'invoice', i.id, '退回供应商', { reason });
    return { ok: true };
  });

  app.post('/api/invoices/:id/move', FIN, async (req) => {
    const i = getInv(req.params.id);
    if (i.status !== '已入账') throw bad('只有已入账的发票可以改板块');
    const board = req.body?.board;
    if (!BOARDS.includes(board) || board === i.board) throw bad('请选择另一个板块');
    if (!db.prepare('SELECT 1 FROM supplier_boards WHERE supplier_id = ? AND board = ?').get(i.supplier_id, board)) {
      db.prepare('INSERT INTO supplier_boards(supplier_id, board, opening) VALUES (?,?,0)').run(i.supplier_id, board);
    }
    db.prepare('UPDATE invoices SET board = ?, moved = 1 WHERE id = ?').run(board, i.id);
    audit(db, req.user.id, 'invoice', i.id, '跨板块调整', { from: i.board, to: board });
    return { ok: true };
  });

  app.patch('/api/invoices/:id', FIN, async (req) => {
    const i = getInv(req.params.id);
    const f = clean({ ...i, ...req.body?.fields });
    if (Math.abs(r2(f.net + f.tax) - f.total) > 0.011) throw bad('不含税金额 + 税额 应等于价税合计');
    if (f.number !== i.number && ctx.invoiceExists(f.number)) throw bad('这个发票号码已存在');
    db.prepare(`UPDATE invoices SET number=?, issue_date=?, type=?, seller_name=?, seller_tax_id=?, buyer_name=?, buyer_tax_id=?, net=?, tax=?, total=?, rate=?, remark=? WHERE id=?`)
      .run(f.number, f.issue_date, f.type, f.seller_name, f.seller_tax_id, f.buyer_name, f.buyer_tax_id, f.net, f.tax, f.total, f.rate, f.remark, i.id);
    audit(db, req.user.id, 'invoice', i.id, '修改发票信息', { before: { number: i.number, total: i.total }, after: { number: f.number, total: f.total } });
    return { ok: true };
  });

  app.delete('/api/invoices/:id', FIN, async (req) => {
    const i = getInv(req.params.id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(i.id);
    audit(db, req.user.id, 'invoice', i.id, '删除发票', i);
    return { ok: true };
  });

  // ---- tax costs ----
  app.get('/api/tax-costs', FIN, async (req) => {
    const { board, supplier_id } = req.query;
    return db.prepare(`SELECT t.*, s.name AS supplier_name, u.name AS created_by_name FROM tax_costs t JOIN suppliers s ON s.id = t.supplier_id
      LEFT JOIN users u ON u.id = t.created_by WHERE (? IS NULL OR t.board = ?) AND (? IS NULL OR t.supplier_id = ?) ORDER BY t.paid_at DESC, t.id DESC`)
      .all(board ?? null, board ?? null, supplier_id ?? null, supplier_id ?? null);
  });
  app.get('/api/tax-costs/reminders', FIN, async () => db.prepare(`SELECT i.id, i.number, i.issue_date, i.total, i.board, i.supplier_id, s.name AS supplier_name
      FROM invoices i JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.status = '已入账' AND i.total > 0 AND s.tax_cost = 1 AND NOT EXISTS (SELECT 1 FROM tax_costs t WHERE t.invoice_number = i.number)
        AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.target = 'invoice' AND a.target_id = CAST(i.id AS TEXT) AND a.action = '无需税费成本')
      ORDER BY i.id DESC`).all());
  app.post('/api/tax-costs/skip/:invoiceId', FIN, async (req) => {
    const i = getInv(req.params.invoiceId);
    audit(db, req.user.id, 'invoice', i.id, '无需税费成本');
    return { ok: true };
  });
  app.post('/api/tax-costs', FIN, async (req) => {
    const b = req.body || {};
    const sid = Number(b.supplier_id);
    if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(sid)) throw bad('请选择供应商');
    if (!BOARDS.includes(b.board)) throw bad('请选择板块');
    const amount = r2(Number(b.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw bad('请填写金额');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.paid_at || '')) throw bad('请填写支付日期');
    const r = db.prepare('INSERT INTO tax_costs(supplier_id, board, amount, paid_at, invoice_number, statement_id, note, created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(sid, b.board, amount, b.paid_at, b.invoice_number || null, b.statement_id || null, b.note || null, req.user.id);
    audit(db, req.user.id, 'tax_cost', r.lastInsertRowid, '记录税费成本', b);
    return { id: r.lastInsertRowid };
  });
  app.delete('/api/tax-costs/:id', FIN, async (req) => {
    const t = db.prepare('SELECT * FROM tax_costs WHERE id = ?').get(req.params.id);
    if (!t) throw notFound();
    db.prepare('DELETE FROM tax_costs WHERE id = ?').run(t.id);
    audit(db, req.user.id, 'tax_cost', t.id, '删除税费成本', t);
    return { ok: true };
  });

  // clean temp uploads older than a day
  const sweep = () => {
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        const p = path.join(tmpDir, f);
        if (Date.now() - fs.statSync(p).mtimeMs > 86400e3) fs.unlinkSync(p);
      }
    } catch { /* ignore */ }
  };
  sweep();
  const timer = setInterval(sweep, 3600e3);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
