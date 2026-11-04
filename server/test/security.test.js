import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { passwordProblem, hashToken } from '../src/auth.js';

const ADMIN_PW = 'Start-pass-77';
const NEW_PW = 'Nw8k2pQ7x';

async function setup(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const app = await buildApp({ dataDir, dbFile: ':memory:', adminUser: 'admin', adminPassword: ADMIN_PW, ...opts });
  const req = async (method, url, { sid, payload, headers } = {}) => {
    const r = await app.inject({ method, url, payload, headers, cookies: sid ? { sid } : {} });
    let json = null; try { json = r.json(); } catch { /* not json */ }
    return { status: r.statusCode, json, r, sid: r.cookies.find((c) => c.name === 'sid')?.value };
  };
  const login = async (username, password) => req('POST', '/api/login', { payload: { username, password } });
  const cleanup = async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { app, req, login, cleanup };
}
async function adminReady(s) {
  const l = await s.login('admin', ADMIN_PW);
  const c = await s.req('POST', '/api/me/password', { sid: l.sid, payload: { old_password: ADMIN_PW, new_password: NEW_PW } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  return c.sid;
}

test('password rules', () => {
  assert.match(passwordProblem('short1'), /8 位/);
  assert.match(passwordProblem('onlyletters'), /字母和数字/);
  assert.match(passwordProblem('12345678'), /字母和数字/);
  assert.match(passwordProblem('wanglei2026', 'wanglei'), /用户名/);
  assert.match(passwordProblem('admin123'), /常见/);
  assert.equal(passwordProblem('Hm7-cup-ledger'), null);
});

test('first login must change the password before using anything', async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const l = await s.login('admin', ADMIN_PW);
  assert.equal(l.json.must_change_password, true);
  assert.equal((await s.req('GET', '/api/overview', { sid: l.sid })).status, 403);
  assert.equal((await s.req('GET', '/api/me', { sid: l.sid })).status, 200);
  assert.equal((await s.req('POST', '/api/me/password', { sid: l.sid, payload: { old_password: ADMIN_PW, new_password: 'admin123' } })).status, 400);
  const c = await s.req('POST', '/api/me/password', { sid: l.sid, payload: { old_password: ADMIN_PW, new_password: NEW_PW } });
  assert.equal(c.status, 200);
  assert.equal((await s.req('GET', '/api/overview', { sid: l.sid })).status, 401, 'old session ends when the password changes');
  assert.equal((await s.req('GET', '/api/overview', { sid: c.sid })).status, 200, 'the device that changed it gets a new session');
});

test('sessions: stored hashed, idle timeout, sign out other devices', async (t) => {
  const s = await setup({ idleHours: 1 / 3600 }); t.after(s.cleanup); // 1 second idle limit
  const a = await adminReady(s);
  const rows = s.app.db.prepare('SELECT token FROM sessions').all().map((r) => r.token);
  assert.ok(!rows.includes(a) && rows.includes(hashToken(a)), 'only the hash is stored');
  assert.equal((await s.req('GET', '/api/me', { sid: a })).status, 200);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal((await s.req('GET', '/api/me', { sid: a })).status, 401, 'idle session expired');

  const s2 = await setup(); t.after(s2.cleanup);
  const one = await adminReady(s2);
  const two = (await s2.login('admin', NEW_PW)).sid;
  const list = (await s2.req('GET', '/api/me/sessions', { sid: one })).json;
  assert.equal(list.length, 2);
  assert.equal(list.filter((x) => x.current).length, 1);
  assert.equal((await s2.req('POST', '/api/me/sessions/logout-others', { sid: one, payload: {} })).json.count, 1);
  assert.equal((await s2.req('GET', '/api/me', { sid: two })).status, 401);
  assert.equal((await s2.req('GET', '/api/me', { sid: one })).status, 200);
});

test('brute force: account lock, unknown users, admin unlock, disabled users', async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const admin = await adminReady(s);
  await s.req('POST', '/api/users', { sid: admin, payload: { username: 'cw', name: '财务', role: '财务', password: 'Fin-pass-31' } });
  const u = (await s.login('nobody', 'whatever1')).json;
  assert.equal(u.error, '用户名或密码不对');
  for (let i = 0; i < 10; i++) await s.login('CW', 'wrong-pass-1'); // username is not case sensitive
  assert.equal((await s.login('cw', 'Fin-pass-31')).status, 429);
  const users = (await s.req('GET', '/api/users', { sid: admin })).json;
  const cw = users.find((x) => x.username === 'cw');
  assert.ok(cw.locked_until);
  await s.req('POST', `/api/users/${cw.id}/logout`, { sid: admin, payload: {} });
  const ok = await s.login('cw', 'Fin-pass-31');
  assert.equal(ok.status, 200);
  await s.req('PATCH', `/api/users/${cw.id}`, { sid: admin, payload: { active: false } });
  assert.equal((await s.req('GET', '/api/me', { sid: ok.sid })).status, 401, 'disabling ends sessions');
  assert.equal((await s.login('cw', 'Fin-pass-31')).status, 401);
  const log = (await s.req('GET', '/api/audit?target=login', { sid: admin })).json;
  assert.ok(log.some((a) => a.action.includes('锁定')));
});

test('too many failures from one IP are blocked across usernames', async (t) => {
  const s = await setup(); t.after(s.cleanup);
  for (let i = 0; i < 30; i++) await s.login('user' + i, 'wrong-pass-1');
  assert.equal((await s.login('admin', ADMIN_PW)).status, 429);
});

test('cross-site requests and response headers', async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const admin = await adminReady(s);
  const evil = await s.req('POST', '/api/buyers', { sid: admin, payload: { name: 'x', tax_id: '91440300MA5FTEST01', board: '工厂' }, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const same = await s.req('POST', '/api/buyers', { sid: admin, payload: { name: '某某工厂', tax_id: '91440300MA5FTEST01', board: '工厂' }, headers: { origin: 'http://localhost:80', host: 'localhost:80' } });
  assert.equal(same.status, 200, JSON.stringify(same.json));
  const h = (await s.req('GET', '/api/health')).r.headers;
  assert.equal(h['x-frame-options'], 'DENY');
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.match(h['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(h['cache-control'], 'no-store');
});

test('uploaded XML originals download sandboxed instead of rendering', async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const admin = await adminReady(s);
  const xml = Buffer.from('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script><InvoiceNumber>26332000000123456789</InvoiceNumber></html>');
  const boundary = '----x';
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.xml"\r\n\r\n`), xml, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const p = await s.req('POST', '/api/invoices/parse', { sid: admin, payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  const fields = { ...p.json.fields, net: 100, tax: 13, total: 113 };
  const inv = await s.req('POST', '/api/invoices', { sid: admin, payload: { fields, token: p.json.token, source: 'xml' } });
  const f = await s.req('GET', `/api/invoices/${inv.json.id}/file`, { sid: admin });
  assert.equal(f.status, 200);
  assert.match(f.r.headers['content-disposition'], /^attachment/);
  assert.equal(f.r.headers['content-type'], 'application/octet-stream');
  assert.match(f.r.headers['content-security-policy'], /sandbox/);
});
