import { BOARDS, audit } from '../db.js';
import { bad, forbidden, notFound } from '../app.js';
import { r2, splitAmount } from '../money.js';
import { canSeeSupplier, visibleSupplierIds } from '../ledger.js';
import { readWorkbook, cellVal } from '../xlsx.js';

function nextCode(db, kind, periodTo) {
  const ym = (periodTo || new Date().toISOString()).slice(2, 7).replace('-', '');
  const prefix = (kind === '调整单' ? 'TZ' : 'DZ') + ym + '-';
  const r = db.prepare('SELECT code FROM statements WHERE code LIKE ? ORDER BY code DESC LIMIT 1').get(prefix + '%');
  const n = r ? Number(r.code.slice(prefix.length)) + 1 : 1;
  return prefix + String(n).padStart(3, '0');
}

const isDate = (s) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function statementRoutes(app) {
  const db = app.db;
  const R = { preHandler: app.auth() };
  const FIN = { preHandler: app.auth('管理员', '财务') };
  const get = (id) => db.prepare('SELECT * FROM statements WHERE id = ?').get(id);

  const mayEdit = (user, st) => {
    if (user.role === '财务' || user.role === '管理员') return true;
    return user.role === '跟单员' && canSeeSupplier(db, user, st.supplier_id);
  };

  const validate = (b, kind) => {
    const sup = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(b.supplier_id);
    if (!sup) throw bad('请选择供应商');
    if (!BOARDS.includes(b.board)) throw bad('请选择板块');
    if (!db.prepare('SELECT 1 FROM supplier_boards WHERE supplier_id = ? AND board = ?').get(sup.id, b.board)) throw bad(`「${sup.name}」没有在${b.board}板块供货，请先在供应商资料里加上`);
    if (!['含税', '不含税'].includes(b.mode)) throw bad('请选择金额口径');
    const rate = Number(b.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 0.17) throw bad('税率不对');
    const amount = r2(Number(b.amount));
    if (!Number.isFinite(amount) || amount === 0) throw bad('请填写对账金额');
    if (kind === '对账单' && amount < 0) throw bad('对账单金额不能为负数，冲减请用调整单');
    if (!isDate(b.period_from) || !isDate(b.period_to)) throw bad('日期格式不对');
    if (b.period_from && b.period_to && b.period_from > b.period_to) throw bad('开始日期晚于结束日期');
    const taxCost = b.tax_cost === '' || b.tax_cost == null ? null : r2(Number(b.tax_cost));
    if (taxCost != null && (!Number.isFinite(taxCost) || taxCost < 0)) throw bad('税费成本不对');
    return { sup, rate, amount, taxCost, ...splitAmount(amount, rate, b.mode) };
  };

  app.get('/api/statements', R, async (req) => {
    const ids = visibleSupplierIds(db, req.user);
    const { status, board, supplier_id } = req.query;
    const rows = db.prepare(`SELECT st.*, s.name AS supplier_name, s.code AS supplier_code,
        cu.name AS created_by_name, au.name AS approved_by_name
      FROM statements st JOIN suppliers s ON s.id = st.supplier_id
      LEFT JOIN users cu ON cu.id = st.created_by LEFT JOIN users au ON au.id = st.approved_by
      WHERE (? IS NULL OR st.status = ?) AND (? IS NULL OR st.board = ?) AND (? IS NULL OR st.supplier_id = ?)
      ORDER BY st.id DESC LIMIT 1000`)
      .all(status ?? null, status ?? null, board ?? null, board ?? null, supplier_id ?? null, supplier_id ?? null);
    return rows.filter((r) => ids === null || ids.includes(r.supplier_id));
  });

  app.post('/api/statements', R, async (req) => {
    if (req.user.role === '管理员' && !req.body?.allow_admin) { /* admins may create too */ }
    const b = req.body || {};
    const kind = b.kind === '调整单' ? '调整单' : '对账单';
    const v = validate(b, kind);
    if (!canSeeSupplier(db, req.user, v.sup.id)) throw forbidden('这个供应商不归你负责');
    let parentId = null;
    if (kind === '调整单') {
      const p = get(b.parent_id);
      if (!p || p.status !== '已生效') throw bad('调整单要关联一张已生效的对账单');
      if (p.supplier_id !== v.sup.id || p.board !== b.board) throw bad('调整单的供应商和板块要和原对账单一致');
      parentId = p.id;
    }
    const status = b.submit ? '待终审' : '草稿';
    const code = nextCode(db, kind, b.period_to);
    const r = db.prepare(`INSERT INTO statements(code, kind, parent_id, supplier_id, board, period_from, period_to, mode, rate, amount, net, tax, gross,
        tax_cost, status, supplier_ref, note, created_by, submitted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, CASE WHEN ? = '待终审' THEN datetime('now') END)`)
      .run(code, kind, parentId, v.sup.id, b.board, b.period_from || null, b.period_to || null, b.mode, v.rate, v.amount, v.net, v.tax, v.gross,
        v.taxCost, status, b.supplier_ref || null, b.note || null, req.user.id, status);
    audit(db, req.user.id, 'statement', r.lastInsertRowid, status === '待终审' ? '创建并提交' : '创建草稿', { code, ...b });
    return { id: r.lastInsertRowid, code, status };
  });

  app.patch('/api/statements/:id', R, async (req) => {
    const st = get(req.params.id);
    if (!st) throw notFound();
    if (!mayEdit(req.user, st)) throw forbidden();
    if (!['草稿', '已驳回'].includes(st.status)) throw bad('只有草稿或已驳回的单据可以修改');
    const b = { ...st, ...req.body };
    const v = validate(b, st.kind);
    if (!canSeeSupplier(db, req.user, v.sup.id)) throw forbidden('这个供应商不归你负责');
    db.prepare(`UPDATE statements SET supplier_id=?, board=?, period_from=?, period_to=?, mode=?, rate=?, amount=?, net=?, tax=?, gross=?, tax_cost=?,
      supplier_ref=?, note=?, updated_at=datetime('now') WHERE id=?`)
      .run(v.sup.id, b.board, b.period_from || null, b.period_to || null, b.mode, v.rate, v.amount, v.net, v.tax, v.gross, v.taxCost,
        b.supplier_ref || null, b.note || null, st.id);
    audit(db, req.user.id, 'statement', st.id, '修改', req.body);
    return { ok: true };
  });

  app.post('/api/statements/:id/submit', R, async (req) => {
    const st = get(req.params.id);
    if (!st) throw notFound();
    if (!mayEdit(req.user, st)) throw forbidden();
    if (!['草稿', '已驳回'].includes(st.status)) throw bad('这张单据不能提交');
    db.prepare("UPDATE statements SET status='待终审', reject_reason=NULL, submitted_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(st.id);
    audit(db, req.user.id, 'statement', st.id, '复核并提交终审');
    return { ok: true };
  });

  app.post('/api/statements/:id/approve', FIN, async (req) => {
    const st = get(req.params.id);
    if (!st) throw notFound();
    if (st.status !== '待终审') throw bad('只有待终审的单据可以终审');
    db.prepare("UPDATE statements SET status='已生效', approved_by=?, approved_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(req.user.id, st.id);
    audit(db, req.user.id, 'statement', st.id, '终审通过', { gross: st.gross });
    return { ok: true };
  });

  app.post('/api/statements/:id/reject', FIN, async (req) => {
    const st = get(req.params.id);
    if (!st) throw notFound();
    if (st.status !== '待终审') throw bad('只有待终审的单据可以驳回');
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw bad('请填写驳回原因');
    db.prepare("UPDATE statements SET status='已驳回', reject_reason=?, updated_at=datetime('now') WHERE id=?").run(reason.slice(0, 500), st.id);
    audit(db, req.user.id, 'statement', st.id, '驳回', { reason });
    return { ok: true };
  });

  app.post('/api/statements/:id/void', R, async (req) => {
    const st = get(req.params.id);
    if (!st) throw notFound();
    if (!mayEdit(req.user, st)) throw forbidden();
    if (!['草稿', '已驳回'].includes(st.status)) throw bad('已生效的单据不能作废，请新建调整单冲减');
    db.prepare("UPDATE statements SET status='已作废', updated_at=datetime('now') WHERE id=?").run(st.id);
    audit(db, req.user.id, 'statement', st.id, '作废');
    return { ok: true };
  });

  /** Read the supplier-filled statement template and return the fields for the form. */
  app.post('/api/statements/parse-xlsx', R, async (req) => {
    const file = await req.file();
    if (!file) throw bad('请选择 Excel 文件');
    let wb;
    try { wb = await readWorkbook(await file.toBuffer()); } catch { throw bad('读不了这个文件，请确认是 .xlsx 格式'); }
    const ws = wb.getWorksheet('对账单');
    if (!ws) throw bad('没找到「对账单」工作表，请用系统的对账单模板');
    const v = (a) => cellVal(ws.getCell(a));
    const d = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 10) : null));
    let rate = Number(v('B10'));
    if (!Number.isFinite(rate)) rate = null; else if (rate > 1) rate = rate / 100;
    let total = 0, lines = 0;
    for (let r = 18; r <= 67; r++) {
      const q = Number(v('G' + r)), p = Number(v('H' + r));
      const name = v('D' + r);
      if (typeof name === 'string' && name.startsWith('示例')) continue;
      if (Number.isFinite(q) && Number.isFinite(p) && q && p) { total += q * p; lines++; }
    }
    const supName = String(v('B3') || '').trim();
    const ids = visibleSupplierIds(db, req.user);
    const sups = db.prepare('SELECT id, name FROM suppliers WHERE active = 1').all().filter((s) => ids === null || ids.includes(s.id));
    const match = supName ? sups.find((s) => s.name === supName) || sups.find((s) => supName.includes(s.name) || s.name.includes(supName)) : null;
    return {
      supplier_name: supName || null,
      supplier_id: match ? match.id : null,
      supplier_ref: v('B4') ? String(v('B4')) : null,
      board: BOARDS.includes(v('B5')) ? v('B5') : null,
      buyer_name: v('B6') || null,
      period_from: d(v('B7')),
      period_to: d(v('B8')),
      mode: ['含税', '不含税'].includes(v('B9')) ? v('B9') : '含税',
      rate,
      amount: r2(total),
      tax_cost: Number(v('B11')) || null,
      lines,
    };
  });
}
