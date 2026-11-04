import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { buildApp } from '../src/app.js';

const XML = fs.readFileSync(new URL('./fixtures/sample-invoice.xml', import.meta.url));

function multipart(filename, buf) {
  const boundary = '----t' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-'));
  const app = await buildApp({ dataDir, dbFile: ':memory:', adminUser: 'admin', adminPassword: 'admin-pass-1' });
  const cookies = {};
  // logs in; a first login must change the password before anything else works, so do that too
  const login = async (who, username, password) => {
    const r = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
    assert.equal(r.statusCode, 200, r.body);
    cookies[who] = r.cookies.find((c) => c.name === 'sid').value;
    if (r.json().must_change_password) {
      const c = await app.inject({ method: 'POST', url: '/api/me/password', cookies: { sid: cookies[who] }, payload: { old_password: password, new_password: 'Nw8k2pQ7x' } });
      assert.equal(c.statusCode, 200, c.body);
      cookies[who] = c.cookies.find((x) => x.name === 'sid').value;
    }
  };
  const call = async (who, method, url, payload, extra = {}) => {
    const r = await app.inject({ method, url, payload, cookies: { sid: cookies[who] }, ...extra });
    let json = null;
    try { json = r.json(); } catch { /* binary */ }
    return { status: r.statusCode, json, raw: r };
  };
  const ok = async (...a) => {
    const r = await call(...a);
    assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  await login('admin', 'admin', 'admin-pass-1');
  return { app, dataDir, login, call, ok };
}

test('full flow: master data → statement → invoice → overview', async (t) => {
  const { app, dataDir, login, call, ok } = await setup();
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  assert.equal((await call(null, 'GET', '/api/overview')).status, 401);
  let setup0 = await ok('admin', 'GET', '/api/setup-status');
  assert.deepEqual([setup0.company, setup0.users, setup0.buyers, setup0.suppliers, setup0.statements, setup0.invoices], [false, 0, 0, 0, 0, 0]);

  // users
  const fin = await ok('admin', 'POST', '/api/users', { username: 'cw', name: '财务小李', role: '财务', password: 'fin-pass-1' });
  const gd = await ok('admin', 'POST', '/api/users', { username: 'wanglei', name: '王磊', role: '跟单员', password: 'gd-pass-11' });
  await ok('admin', 'POST', '/api/users', { username: 'other', name: '别人', role: '跟单员', password: 'xpass-991' });
  await login('fin', 'cw', 'fin-pass-1');
  await login('gd', 'wanglei', 'gd-pass-11');
  await login('other', 'other', 'xpass-991');
  assert.equal((await call('gd', 'POST', '/api/buyers', { name: 'x', tax_id: '91440300MA5FTEST01', board: '工厂' })).status, 403);

  // master data
  await ok('fin', 'POST', '/api/buyers', { name: '深圳某某工厂有限公司', tax_id: '91440300MA5FTEST01', board: '工厂' });
  await ok('fin', 'POST', '/api/buyers', { name: '深圳某某电商有限公司', tax_id: '91440300MA5FTEST02', board: '电商' });
  const sup = await ok('fin', 'POST', '/api/suppliers', { name: '华茂塑化', rate: '13%', tax_cost: true, owner_id: gd.id, boards: [{ board: '工厂', opening: 10000 }] });
  await ok('fin', 'POST', '/api/entities', { name: '浙江华茂塑化有限公司', tax_id: '91330421MA28B6XK2P', supplier_ids: [sup.id] });
  const master = await ok('gd', 'GET', '/api/master');
  assert.equal(master.suppliers.length, 1);
  assert.equal((await ok('other', 'GET', '/api/master')).suppliers.length, 0);

  // statement: 跟单员 creates, reviews and submits; 财务 approves
  const st = await ok('gd', 'POST', '/api/statements', { supplier_id: sup.id, board: '工厂', mode: '不含税', rate: 0.13, amount: 40000, period_from: '2026-10-01', period_to: '2026-10-31' });
  assert.equal(st.status, '草稿');
  assert.match(st.code, /^DZ2610-001$/);
  assert.equal((await call('other', 'POST', `/api/statements/${st.id}/submit`)).status, 403);
  await ok('gd', 'POST', `/api/statements/${st.id}/submit`);
  assert.equal((await call('gd', 'POST', `/api/statements/${st.id}/approve`)).status, 403);
  assert.equal((await call('fin', 'POST', `/api/statements/${st.id}/reject`, {})).status, 400);
  await ok('fin', 'POST', `/api/statements/${st.id}/reject`, { reason: '数量不对' });
  await ok('gd', 'PATCH', `/api/statements/${st.id}`, { amount: 40000, note: '已改' });
  await ok('gd', 'POST', `/api/statements/${st.id}/submit`);
  await ok('fin', 'POST', `/api/statements/${st.id}/approve`);
  assert.equal((await call('gd', 'POST', `/api/statements/${st.id}/void`)).status, 400);

  let ov = await ok('gd', 'GET', '/api/overview?board=工厂');
  assert.equal(ov.totals.should, 55200); // 10000 opening + 45200
  assert.equal(ov.totals.owe, 55200);

  // invoice via XML upload
  const up = multipart('发票.xml', XML);
  const parsed = await ok('gd', 'POST', '/api/invoices/parse', up.payload, { headers: up.headers });
  assert.equal(parsed.source, 'xml');
  assert.equal(parsed.fields.total, 45200);
  assert.equal(parsed.preview.status, '已入账');
  assert.equal(parsed.preview.supplier_name, '华茂塑化');
  const inv = await ok('gd', 'POST', '/api/invoices', { fields: parsed.fields, token: parsed.token, source: 'xml' });
  assert.equal(inv.status, '已入账');
  assert.equal(inv.tax_cost_reminder, true);
  assert.equal((await call('gd', 'POST', '/api/invoices', { fields: parsed.fields })).status, 409);
  const file = await call('gd', 'GET', `/api/invoices/${inv.id}/file`);
  assert.equal(file.status, 200);
  assert.equal((await call('other', 'GET', `/api/invoices/${inv.id}/file`)).status, 403);

  ov = await ok('gd', 'GET', '/api/overview?board=工厂');
  assert.equal(ov.totals.done, 45200);
  assert.equal(ov.totals.owe, 10000);

  // unregistered seller → pending → finance assigns and registers the entity
  const f2 = { ...parsed.fields, number: '26332000000123456790', seller_tax_id: '91330421MA28NEW001', seller_name: '华茂新公司', net: 1000, tax: 130, total: 1130 };
  const p2 = await ok('gd', 'POST', '/api/invoices', { fields: f2 });
  assert.equal(p2.status, '待处理');
  assert.equal(p2.pending_reason, '开票主体未登记');
  assert.equal((await ok('fin', 'GET', '/api/overview')).counts.invoices_pending, 1);
  await ok('fin', 'POST', `/api/invoices/${p2.id}/assign`, { supplier_id: sup.id, board: '工厂', register_entity: true });
  const ents = (await ok('fin', 'GET', '/api/master')).entities;
  assert.ok(ents.some((e) => e.tax_id === '91330421MA28NEW001'));

  // tax cost reminder → record
  const rem = await ok('fin', 'GET', '/api/tax-costs/reminders');
  assert.equal(rem.length, 2);
  await ok('fin', 'POST', '/api/tax-costs', { supplier_id: sup.id, board: '工厂', amount: 800, paid_at: '2026-11-01', invoice_number: parsed.fields.number });
  await ok('fin', 'POST', `/api/tax-costs/skip/${p2.id}`);
  assert.equal((await ok('fin', 'GET', '/api/tax-costs/reminders')).length, 0);

  // detail, dunning, exports
  const d = await ok('gd', 'GET', `/api/suppliers/${sup.id}/detail`);
  assert.equal(d.ledgers[0].owe, 8870);
  assert.equal(d.invoices.length, 2);
  assert.equal(d.tax_costs.length, 0); // 跟单员 does not see tax costs
  assert.match(d.dunning[0], /8,870\.00/);
  assert.equal((await call('other', 'GET', `/api/suppliers/${sup.id}/detail`)).status, 403);
  const dun = await ok('gd', 'GET', '/api/dunning');
  assert.equal(dun.length, 1);

  for (const url of ['/api/export/overview', '/api/export/invoices', '/api/export/tax-costs', '/api/templates/master', '/api/templates/statement']) {
    const r = await call('fin', 'GET', url);
    assert.equal(r.status, 200, url);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.raw.rawPayload);
    assert.ok(wb.worksheets.length >= 1, url);
  }
  assert.equal((await call('gd', 'GET', '/api/export/tax-costs')).status, 403);

  // cross-board move
  await ok('fin', 'POST', `/api/invoices/${inv.id}/move`, { board: '电商' });
  ov = await ok('fin', 'GET', '/api/overview');
  const fac = ov.rows.find((r) => r.board === '工厂');
  const ec = ov.rows.find((r) => r.board === '电商');
  assert.equal(fac.owe, 54070);
  assert.equal(ec.owe, -45200);

  // audit trail
  const log = await ok('fin', 'GET', '/api/audit?target=statement');
  assert.ok(log.some((a) => a.action === '终审通过'));

  // first-run checklist reflects what has been set up; 跟单员 cannot read it
  setup0 = await ok('fin', 'GET', '/api/setup-status');
  assert.equal(setup0.users, 3);
  assert.ok(setup0.buyers > 0 && setup0.suppliers > 0 && setup0.entities > 0 && setup0.statements > 0 && setup0.invoices > 0);
  assert.equal((await call('gd', 'GET', '/api/setup-status')).status, 403);
});

test('statement template import fills the form', async (t) => {
  const { app, dataDir, ok } = await setup();
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await ok('admin', 'POST', '/api/suppliers', { name: '华茂塑化', rate: 0.13, boards: [{ board: '工厂', opening: 0 }] });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(new URL('../assets/statement-template.xlsx', import.meta.url).pathname);
  const ws = wb.getWorksheet('对账单');
  ws.getCell('B3').value = '浙江华茂塑化有限公司';
  ws.getCell('B5').value = '工厂';
  ws.getCell('B7').value = new Date('2026-10-01');
  ws.getCell('B8').value = new Date('2026-10-31');
  ws.getCell('B9').value = '不含税';
  ws.getCell('B10').value = 13;
  ws.getCell('D19').value = 'PP颗粒'; ws.getCell('G19').value = 10; ws.getCell('H19').value = 4000;
  ws.getCell('D20').value = 'PE颗粒'; ws.getCell('G20').value = 2; ws.getCell('H20').value = 1500.5;
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const up = multipart('对账单.xlsx', buf);
  const r = await ok('admin', 'POST', '/api/statements/parse-xlsx', up.payload, { headers: up.headers });
  assert.equal(r.supplier_name, '浙江华茂塑化有限公司');
  assert.ok(r.supplier_id);
  assert.equal(r.board, '工厂');
  assert.equal(r.period_from, '2026-10-01');
  assert.equal(r.mode, '不含税');
  assert.equal(r.rate, 0.13);
  assert.equal(r.amount, 43001);
  assert.equal(r.lines, 2);
});

test('login throttle and password change', async (t) => {
  const { app, dataDir, call, ok } = await setup();
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  for (let i = 0; i < 10; i++) assert.equal((await call(null, 'POST', '/api/login', { username: 'admin', password: 'wrong1234' })).status, 401);
  assert.equal((await call(null, 'POST', '/api/login', { username: 'admin', password: 'Nw8k2pQ7x' })).status, 429, 'account locked even with the right password');
  // the existing session still works and can change the password
  assert.equal((await ok('admin', 'GET', '/api/me')).user.username, 'admin');
  void ok;
});
