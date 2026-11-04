import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, audit, getSetting, setSetting, ROLES } from './db.js';
import { today } from './money.js';
import masterRoutes from './routes/master.js';
import statementRoutes from './routes/statements.js';
import invoiceRoutes from './routes/invoices.js';
import reportRoutes from './routes/reports.js';

const SESSION_DAYS = 30;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.statusCode = status; }
}
export const bad = (msg) => new HttpError(400, msg);
export const forbidden = (msg = '没有权限') => new HttpError(403, msg);
export const notFound = (msg = '找不到这条记录') => new HttpError(404, msg);

export function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }

/**
 * Build the Fastify app. Options:
 *  dataDir     where invoice.db and uploads/ live (default ./data)
 *  dbFile      override database path (':memory:' in tests)
 *  webDir      built frontend to serve (optional)
 *  adminUser / adminPassword   first administrator, created only when no user exists
 *  cookieSecure  set Secure on the session cookie (behind HTTPS)
 */
export async function buildApp(opts = {}) {
  const dataDir = path.resolve(opts.dataDir || './data');
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(path.join(uploadDir, 'tmp'), { recursive: true });
  const db = openDb(opts.dbFile || path.join(dataDir, 'invoice.db'));

  // first run
  if (!getSetting(db, 'opening_date')) setSetting(db, 'opening_date', today());
  if (!getSetting(db, 'company_name')) setSetting(db, 'company_name', '供应商发票跟踪');
  let initialPassword = null;
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    const username = opts.adminUser || 'admin';
    initialPassword = opts.adminPassword || crypto.randomBytes(9).toString('base64url');
    db.prepare("INSERT INTO users(username, name, password_hash, role, must_change_password) VALUES (?, '管理员', ?, '管理员', ?)")
      .run(username, hashPassword(initialPassword), opts.adminPassword ? 0 : 1);
  }

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  app.decorate('db', db);
  app.decorate('uploadDir', uploadDir);
  app.decorate('initialPassword', initialPassword);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    const message = status >= 500 ? '服务器出错了，请稍后再试' : (err.code === 'FST_REQ_FILE_TOO_LARGE' ? '文件太大，最大 20MB' : err.message);
    reply.status(status).send({ error: message });
  });

  // ---- sessions ----
  const userBySession = db.prepare(`SELECT u.id, u.username, u.name, u.role, u.active, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')`);
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    const token = req.cookies.sid;
    if (token) {
      const u = userBySession.get(token);
      if (u && u.active) req.user = u;
    }
  });
  app.decorate('auth', (...roles) => async (req) => {
    if (!req.user) throw new HttpError(401, '请先登录');
    if (roles.length && !roles.includes(req.user.role)) throw forbidden();
  });

  const failures = new Map(); // key -> {n, until}
  app.post('/api/login', async (req, reply) => {
    const { username, password } = req.body || {};
    const key = `${req.ip}|${String(username || '').toLowerCase()}`;
    const f = failures.get(key);
    if (f && f.n >= 8 && f.until > Date.now()) throw new HttpError(429, '尝试次数太多，请 15 分钟后再试');
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
    if (!u || !u.active || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
      failures.set(key, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60e3 });
      throw new HttpError(401, '用户名或密码不对');
    }
    failures.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare(`INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`).run(token, u.id);
    db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
    reply.setCookie('sid', token, { path: '/', httpOnly: true, sameSite: 'lax', secure: !!opts.cookieSecure, maxAge: SESSION_DAYS * 86400 });
    audit(db, u.id, 'user', u.id, '登录');
    return { ok: true };
  });
  app.post('/api/logout', async (req, reply) => {
    if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', { preHandler: app.auth() }, async (req) => ({
    user: req.user,
    settings: { company_name: getSetting(db, 'company_name'), opening_date: getSetting(db, 'opening_date') },
  }));
  app.post('/api/me/password', { preHandler: app.auth() }, async (req) => {
    const { old_password, new_password } = req.body || {};
    const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(String(old_password || ''), u.password_hash)) throw bad('原密码不对');
    if (String(new_password || '').length < 8) throw bad('新密码至少 8 位');
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(new_password), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.cookies.sid);
    audit(db, req.user.id, 'user', req.user.id, '修改密码');
    return { ok: true };
  });

  // ---- users (管理员) ----
  app.get('/api/users', { preHandler: app.auth() }, async (req) => {
    const all = db.prepare('SELECT id, username, name, role, active, created_at FROM users ORDER BY id').all();
    // everyone may see names (to show owners); only admins see usernames and status
    return req.user.role === '管理员' ? all : all.filter((u) => u.active).map(({ id, name, role }) => ({ id, name, role }));
  });
  app.post('/api/users', { preHandler: app.auth('管理员') }, async (req) => {
    const { username, name, role, password } = req.body || {};
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username || '')) throw bad('用户名只能用字母、数字、下划线，2-32 位');
    if (!name) throw bad('请填写姓名');
    if (!ROLES.includes(role)) throw bad('角色不对');
    if (String(password || '').length < 8) throw bad('初始密码至少 8 位');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('用户名已被占用');
    const r = db.prepare('INSERT INTO users(username, name, password_hash, role, must_change_password) VALUES (?,?,?,?,1)')
      .run(username, name, hashPassword(password), role);
    audit(db, req.user.id, 'user', r.lastInsertRowid, '新建用户', { username, name, role });
    return { id: r.lastInsertRowid };
  });
  app.patch('/api/users/:id', { preHandler: app.auth('管理员') }, async (req) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw notFound();
    const { name, role, active, password } = req.body || {};
    if (role !== undefined && !ROLES.includes(role)) throw bad('角色不对');
    if (id === req.user.id && (active === false || (role && role !== '管理员'))) throw bad('不能停用自己或取消自己的管理员身份');
    db.prepare('UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), active = COALESCE(?, active) WHERE id = ?')
      .run(name ?? null, role ?? null, active === undefined ? null : (active ? 1 : 0), id);
    if (password) {
      if (String(password).length < 8) throw bad('密码至少 8 位');
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (active === false) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit(db, req.user.id, 'user', id, '修改用户', { name, role, active, password_reset: !!password });
    return { ok: true };
  });

  // ---- settings ----
  app.put('/api/settings', { preHandler: app.auth('管理员') }, async (req) => {
    const { company_name, opening_date } = req.body || {};
    if (company_name) setSetting(db, 'company_name', String(company_name).slice(0, 60));
    if (opening_date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(opening_date)) throw bad('日期格式应为 YYYY-MM-DD');
      setSetting(db, 'opening_date', opening_date);
    }
    audit(db, req.user.id, 'settings', null, '修改设置', req.body);
    return { ok: true };
  });

  app.get('/api/audit', { preHandler: app.auth('管理员', '财务') }, async (req) => {
    const { target, target_id, limit } = req.query;
    const rows = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE (? IS NULL OR a.target = ?) AND (? IS NULL OR a.target_id = ?) ORDER BY a.id DESC LIMIT ?`)
      .all(target ?? null, target ?? null, target_id ?? null, target_id ?? null, Math.min(Number(limit) || 200, 1000));
    return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  });

  await app.register(masterRoutes);
  await app.register(statementRoutes);
  await app.register(invoiceRoutes);
  await app.register(reportRoutes);

  app.get('/api/health', async () => ({ ok: true }));

  if (opts.webDir && fs.existsSync(opts.webDir)) {
    await app.register(fastifyStatic, { root: path.resolve(opts.webDir), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: '接口不存在' });
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => db.close());
  return app;
}
