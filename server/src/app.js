import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, audit, getSetting, setSetting, ROLES } from './db.js';
import { setupAuth, hashPassword, passwordProblem } from './auth.js';
import { today } from './money.js';
import masterRoutes from './routes/master.js';
import statementRoutes from './routes/statements.js';
import invoiceRoutes from './routes/invoices.js';
import reportRoutes from './routes/reports.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.statusCode = status; }
}
export const bad = (msg) => new HttpError(400, msg);
export const forbidden = (msg = '没有权限') => new HttpError(403, msg);
export const notFound = (msg = '找不到这条记录') => new HttpError(404, msg);

export { hashPassword };

/**
 * Build the Fastify app. Options:
 *  dataDir     where invoice.db and uploads/ live (default ./data)
 *  dbFile      override database path (':memory:' in tests)
 *  webDir      built frontend to serve (optional)
 *  adminUser / adminPassword   first administrator, created only when no user exists
 *  cookieSecure  set Secure on the session cookie and send HSTS (behind HTTPS)
 *  trustProxy    take the client IP from X-Forwarded-For (only when behind Nginx/Caddy)
 *  sessionDays / idleHours   longest session, and how long without activity before signing out (default 7 days / 12 hours)
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
    // the first password always has to be changed at first login, even when it came from the environment
    db.prepare("INSERT INTO users(username, name, password_hash, role, must_change_password) VALUES (?, '管理员', ?, '管理员', 1)")
      .run(username, hashPassword(initialPassword));
  }

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024, trustProxy: !!opts.trustProxy });
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

  const { startSession } = setupAuth(app, db, {
    cookieSecure: !!opts.cookieSecure,
    sessionDays: Number(opts.sessionDays) || 7,
    idleHours: Number(opts.idleHours) || 12,
  });
  void startSession;

  // ---- users (管理员) ----
  app.get('/api/users', { preHandler: app.auth() }, async (req) => {
    const all = db.prepare(`SELECT id, username, name, role, active, created_at, last_login_at, last_login_ip, locked_until, must_change_password,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = users.id) AS sessions FROM users ORDER BY id`).all();
    // everyone may see names (to show owners); only admins see usernames and status
    return req.user.role === '管理员' ? all : all.filter((u) => u.active).map(({ id, name, role }) => ({ id, name, role }));
  });
  app.post('/api/users', { preHandler: app.auth('管理员') }, async (req) => {
    const { username, name, role, password } = req.body || {};
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username || '')) throw bad('用户名只能用字母、数字、下划线，2-32 位');
    if (!name) throw bad('请填写姓名');
    if (!ROLES.includes(role)) throw bad('角色不对');
    const problem = passwordProblem(password, username);
    if (problem) throw bad('初始' + problem);
    if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) throw bad('用户名已被占用');
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
    if (password) {
      const problem = passwordProblem(password, u.username);
      if (problem) throw bad(problem);
    }
    db.prepare('UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), active = COALESCE(?, active) WHERE id = ?')
      .run(name ?? null, role ?? null, active === undefined ? null : (active ? 1 : 0), id);
    if (password) {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, failed_count = 0, locked_until = NULL WHERE id = ?').run(hashPassword(password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (active === false) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit(db, req.user.id, 'user', id, '修改用户', { name, role, active, password_reset: !!password });
    return { ok: true };
  });
  app.post('/api/users/:id/logout', { preHandler: app.auth('管理员') }, async (req) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound();
    const r = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(id, req.sessionToken || '');
    db.prepare('UPDATE users SET failed_count = 0, locked_until = NULL WHERE id = ?').run(id);
    audit(db, req.user.id, 'user', id, '强制下线并解锁', { count: r.changes });
    return { ok: true, count: r.changes };
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
