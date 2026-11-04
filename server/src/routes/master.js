import { BOARDS, audit } from '../db.js';
import { bad, notFound } from '../app.js';
import { r2 } from '../money.js';
import { readWorkbook, sheetRows, masterTemplate } from '../xlsx.js';
import { visibleSupplierIds } from '../ledger.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
const TAX_ID = /^[0-9A-Z]{15,20}$/;
const normTax = (s) => String(s || '').trim().toUpperCase();
const parseRate = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace('%', ''));
  if (!Number.isFinite(n)) return null;
  return n > 1 ? r2(n / 100) : n;
};
const parseBoards = (v) => {
  const s = String(v || '');
  const b = BOARDS.filter((x) => s.includes(x));
  return b;
};

export function nextSupplierCode(db) {
  const r = db.prepare("SELECT code FROM suppliers WHERE code LIKE 'S%' ORDER BY CAST(SUBSTR(code, 2) AS INTEGER) DESC LIMIT 1").get();
  const n = r ? Number(r.code.slice(1)) + 1 : 1;
  return 'S' + String(n).padStart(3, '0');
}

export function suppliersWithBoards(db) {
  const sups = db.prepare(`SELECT s.*, u.name AS owner_name FROM suppliers s LEFT JOIN users u ON u.id = s.owner_id ORDER BY s.code`).all();
  const boards = db.prepare('SELECT * FROM supplier_boards').all();
  return sups.map((s) => ({ ...s, boards: boards.filter((b) => b.supplier_id === s.id).map((b) => ({ board: b.board, opening: b.opening })) }));
}

/** Create or update an entity and its supplier links. Returns the id. */
export function saveEntityRow(db, id, b, userId) {
  const tax = normTax(b.tax_id);
  if (!b.name || !String(b.name).trim()) throw bad('请填写开票主体全称');
  if (!TAX_ID.test(tax)) throw bad('税号应为 15-20 位数字或大写字母');
  const sids = [...new Set((b.supplier_ids || []).map(Number))];
  if (!sids.length) throw bad('至少关联一个供应商');
  for (const s of sids) if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(s)) throw bad('供应商不存在');
  const dup = db.prepare('SELECT id FROM entities WHERE tax_id = ? AND id IS NOT ?').get(tax, id);
  if (dup) throw bad('这个税号已经登记过，请在原记录上增加关联供应商');
  db.transaction(() => {
    if (id == null) id = db.prepare('INSERT INTO entities(name, tax_id, note) VALUES (?,?,?)').run(String(b.name).trim(), tax, b.note || null).lastInsertRowid;
    else db.prepare('UPDATE entities SET name = ?, tax_id = ?, note = ? WHERE id = ?').run(String(b.name).trim(), tax, b.note || null, id);
    db.prepare('DELETE FROM entity_suppliers WHERE entity_id = ?').run(id);
    for (const s of sids) db.prepare('INSERT INTO entity_suppliers(entity_id, supplier_id) VALUES (?,?)').run(id, s);
  })();
  audit(db, userId, 'entity', id, b.id ? '修改开票主体' : '新增开票主体', b);
  return id;
}

export default async function masterRoutes(app) {
  const db = app.db;
  const W = { preHandler: app.auth('管理员', '财务') };
  const R = { preHandler: app.auth() };

  app.get('/api/master', R, async (req) => {
    const ids = visibleSupplierIds(db, req.user);
    const suppliers = suppliersWithBoards(db).filter((s) => ids === null || ids.includes(s.id));
    const links = db.prepare('SELECT * FROM entity_suppliers').all();
    const entities = db.prepare('SELECT * FROM entities ORDER BY name').all()
      .map((e) => ({ ...e, supplier_ids: links.filter((l) => l.entity_id === e.id).map((l) => l.supplier_id) }))
      .filter((e) => ids === null || e.supplier_ids.some((id) => ids.includes(id)));
    const buyers = db.prepare('SELECT * FROM buyers ORDER BY board, name').all();
    return { buyers, suppliers, entities };
  });

  // ---- buyers ----
  const checkBuyer = (b) => {
    if (!b.name) throw bad('请填写公司名称');
    if (!TAX_ID.test(normTax(b.tax_id))) throw bad('税号应为 15-20 位数字或大写字母');
    if (!BOARDS.includes(b.board)) throw bad('请选择板块');
  };
  app.post('/api/buyers', W, async (req) => {
    const b = req.body || {}; checkBuyer(b);
    if (db.prepare('SELECT 1 FROM buyers WHERE tax_id = ?').get(normTax(b.tax_id))) throw bad('这个税号已经登记过');
    const r = db.prepare('INSERT INTO buyers(name, tax_id, board) VALUES (?,?,?)').run(b.name.trim(), normTax(b.tax_id), b.board);
    audit(db, req.user.id, 'buyer', r.lastInsertRowid, '新增受票主体', b);
    return { id: r.lastInsertRowid };
  });
  app.patch('/api/buyers/:id', W, async (req) => {
    const cur = db.prepare('SELECT * FROM buyers WHERE id = ?').get(req.params.id);
    if (!cur) throw notFound();
    const b = { ...cur, ...req.body }; checkBuyer(b);
    const dup = db.prepare('SELECT id FROM buyers WHERE tax_id = ? AND id != ?').get(normTax(b.tax_id), cur.id);
    if (dup) throw bad('这个税号已经登记过');
    db.prepare('UPDATE buyers SET name = ?, tax_id = ?, board = ?, active = ? WHERE id = ?').run(b.name.trim(), normTax(b.tax_id), b.board, b.active ? 1 : 0, cur.id);
    audit(db, req.user.id, 'buyer', cur.id, '修改受票主体', req.body);
    return { ok: true };
  });

  // ---- suppliers ----
  const saveSupplier = (id, b, userId) => {
    if (!b.name || !String(b.name).trim()) throw bad('请填写供应商名称');
    const rate = parseRate(b.rate);
    if (rate == null || rate < 0 || rate > 0.17) throw bad('税率不对');
    const boards = (b.boards || []).filter((x) => BOARDS.includes(x.board));
    if (!boards.length) throw bad('至少选择一个供应板块');
    const ownerId = b.owner_id ? Number(b.owner_id) : null;
    if (ownerId && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = '跟单员'").get(ownerId)) throw bad('负责人必须是跟单员');
    const name = String(b.name).trim();
    const dup = db.prepare('SELECT id FROM suppliers WHERE name = ? AND id IS NOT ?').get(name, id);
    if (dup) throw bad('已有同名供应商');
    db.transaction(() => {
      if (id == null) {
        id = db.prepare('INSERT INTO suppliers(code, name, rate, tax_cost, owner_id, contact, note) VALUES (?,?,?,?,?,?,?)')
          .run(nextSupplierCode(db), name, rate, b.tax_cost ? 1 : 0, ownerId, b.contact || null, b.note || null).lastInsertRowid;
      } else {
        db.prepare('UPDATE suppliers SET name = ?, rate = ?, tax_cost = ?, owner_id = ?, contact = ?, note = ?, active = ? WHERE id = ?')
          .run(name, rate, b.tax_cost ? 1 : 0, ownerId, b.contact || null, b.note || null, b.active === false || b.active === 0 ? 0 : 1, id);
      }
      const keep = boards.map((x) => x.board);
      for (const x of BOARDS) {
        if (!keep.includes(x)) {
          const used = db.prepare("SELECT 1 FROM statements WHERE supplier_id = ? AND board = ? AND status != '已作废' UNION SELECT 1 FROM invoices WHERE supplier_id = ? AND board = ?").get(id, x, id, x);
          if (used) throw bad(`${x}板块已有对账单或发票，不能取消`);
          db.prepare('DELETE FROM supplier_boards WHERE supplier_id = ? AND board = ?').run(id, x);
        }
      }
      for (const x of boards) {
        const opening = r2(Number(x.opening) || 0);
        if (opening < 0) throw bad('期初欠票不能为负数');
        db.prepare('INSERT INTO supplier_boards(supplier_id, board, opening) VALUES (?,?,?) ON CONFLICT(supplier_id, board) DO UPDATE SET opening = excluded.opening').run(id, x.board, opening);
      }
    })();
    audit(db, userId, 'supplier', id, b.id ? '修改供应商' : '新增供应商', b);
    return id;
  };
  app.post('/api/suppliers', W, async (req) => ({ id: saveSupplier(null, req.body || {}, req.user.id) }));
  app.patch('/api/suppliers/:id', W, async (req) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(id)) throw notFound();
    saveSupplier(id, { ...req.body, id }, req.user.id);
    return { ok: true };
  });
  app.put('/api/opening', W, async (req) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const upd = db.prepare('UPDATE supplier_boards SET opening = ? WHERE supplier_id = ? AND board = ?');
    let n = 0;
    db.transaction(() => {
      for (const r of rows) {
        const v = r2(Number(r.opening));
        if (!Number.isFinite(v) || v < 0) throw bad('期初欠票必须是不小于 0 的数字');
        n += upd.run(v, r.supplier_id, r.board).changes;
      }
    })();
    audit(db, req.user.id, 'opening', null, '修改期初欠票', rows);
    return { updated: n };
  });

  // ---- entities ----
  const saveEntity = (id, b, userId) => saveEntityRow(db, id, b, userId);
  app.post('/api/entities', W, async (req) => ({ id: saveEntity(null, req.body || {}, req.user.id) }));
  app.patch('/api/entities/:id', W, async (req) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM entities WHERE id = ?').get(id)) throw notFound();
    saveEntity(id, { ...req.body, id }, req.user.id);
    return { ok: true };
  });
  app.delete('/api/entities/:id', W, async (req) => {
    const e = db.prepare('SELECT * FROM entities WHERE id = ?').get(req.params.id);
    if (!e) throw notFound();
    db.prepare('DELETE FROM entities WHERE id = ?').run(e.id);
    audit(db, req.user.id, 'entity', e.id, '删除开票主体', e);
    return { ok: true };
  });

  // ---- templates & import ----
  app.get('/api/templates/:name', R, async (req, reply) => {
    const name = req.params.name;
    let buf, filename;
    if (name === 'master') { buf = await masterTemplate(); filename = '供应商资料导入模板.xlsx'; }
    else if (name === 'statement') { buf = fs.readFileSync(path.join(ASSETS, 'statement-template.xlsx')); filename = '供应商对账单模板.xlsx'; }
    else throw notFound('没有这个模板');
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return reply.send(buf);
  });

  /**
   * Import suppliers, entities and opening balances. Accepts our 供应商资料 template, or the 开票主体 sheet of the
   * supplier-filled statement template (then `board` from the query decides the supplier's board).
   * ?dry=1 only reports what would happen.
   */
  app.post('/api/import/master', W, async (req) => {
    const file = await req.file();
    if (!file) throw bad('请选择 Excel 文件');
    const wb = await readWorkbook(await file.toBuffer());
    const dry = req.query.dry === '1';
    const ws = wb.getWorksheet('供应商资料') || wb.getWorksheet('开票主体');
    if (!ws) throw bad('没找到「供应商资料」或「开票主体」工作表，请用系统模板');
    const supplierSheet = ws.name === '开票主体';
    const defaultBoard = BOARDS.includes(req.query.board) ? req.query.board : null;
    if (supplierSheet && !defaultBoard) throw bad('导入供应商填写的开票主体表时，请先选择板块');
    const rows = sheetRows(ws).filter((r) => !String(r['供应商名称'] || '').startsWith('示例'));
    const users = db.prepare("SELECT id, username FROM users WHERE role = '跟单员'").all();
    const report = { suppliers_created: 0, suppliers_updated: 0, entities_created: 0, entities_linked: 0, errors: [] };
    const bySup = new Map();
    for (const r of rows) {
      const name = String(r['供应商名称'] || '').trim();
      if (!name) { report.errors.push(`第 ${r._row} 行：缺少供应商名称`); continue; }
      if (!bySup.has(name)) bySup.set(name, []);
      bySup.get(name).push(r);
    }
    const run = db.transaction(() => {
      for (const [name, rs] of bySup) {
        const f = rs[0];
        let boards = supplierSheet ? [defaultBoard] : parseBoards(f['供应板块']);
        const existing = db.prepare('SELECT * FROM suppliers WHERE name = ?').get(name);
        if (!boards.length) {
          if (existing) boards = db.prepare('SELECT board FROM supplier_boards WHERE supplier_id = ?').all(existing.id).map((x) => x.board);
          if (!boards.length) { report.errors.push(`第 ${f._row} 行：「${name}」缺少供应板块`); continue; }
        }
        const rate = parseRate(f['默认税率']) ?? (existing ? existing.rate : 0.13);
        const owner = f['跟单员用户名'] ? users.find((u) => u.username === String(f['跟单员用户名']).trim()) : null;
        if (f['跟单员用户名'] && !owner) report.errors.push(`第 ${f._row} 行：跟单员用户名「${f['跟单员用户名']}」不存在，先不分配`);
        const oldBoards = existing ? db.prepare('SELECT * FROM supplier_boards WHERE supplier_id = ?').all(existing.id) : [];
        const allBoards = [...new Set([...oldBoards.map((x) => x.board), ...boards])];
        const opening = (b) => {
          const col = b === '电商' ? '电商期初欠票' : '工厂期初欠票';
          if (f[col] != null && f[col] !== '') return Number(f[col]) || 0;
          return oldBoards.find((x) => x.board === b)?.opening || 0;
        };
        try {
          const id = saveSupplier(existing ? existing.id : null, {
            id: existing?.id, name, rate,
            tax_cost: f['另付税费'] != null ? /是|y|1|true/i.test(String(f['另付税费'])) : existing?.tax_cost,
            owner_id: owner ? owner.id : existing?.owner_id, contact: existing?.contact, note: existing?.note,
            boards: allBoards.map((b) => ({ board: b, opening: opening(b) })),
          }, req.user.id);
          existing ? report.suppliers_updated++ : report.suppliers_created++;
          for (const r of rs) {
            const ename = String(r['开票主体全称'] || '').trim();
            const tax = normTax(r['开票主体税号'] ?? r['统一社会信用代码/税号']);
            if (!ename && !tax) continue;
            if (!TAX_ID.test(tax)) { report.errors.push(`第 ${r._row} 行：税号「${tax}」格式不对`); continue; }
            const e = db.prepare('SELECT * FROM entities WHERE tax_id = ?').get(tax);
            if (!e) { saveEntity(null, { name: ename || tax, tax_id: tax, supplier_ids: [id] }, req.user.id); report.entities_created++; }
            else if (!db.prepare('SELECT 1 FROM entity_suppliers WHERE entity_id = ? AND supplier_id = ?').get(e.id, id)) {
              db.prepare('INSERT INTO entity_suppliers(entity_id, supplier_id) VALUES (?,?)').run(e.id, id); report.entities_linked++;
            }
          }
        } catch (err) {
          if (err.statusCode === 400) report.errors.push(`「${name}」：${err.message}`); else throw err;
        }
      }
      if (dry) throw Object.assign(new Error('dry'), { dry: true });
    });
    try { run(); } catch (e) { if (!e.dry) throw e; }
    if (!dry) audit(db, req.user.id, 'import', null, '导入供应商资料', report);
    return { dry, ...report };
  });
}
