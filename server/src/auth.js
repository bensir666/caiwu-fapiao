import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { audit, getSetting } from './db.js';

/**
 * Login, sessions and the security headers that make the site safe to put on the public internet.
 *
 * - Passwords: bcrypt; at least 8 characters with letters and digits, not the username, not a common password.
 * - Sessions: random token in an httpOnly SameSite cookie; only its SHA-256 is stored. A session ends after
 *   `idleHours` without activity or `sessionDays` in total, on logout, on password change, and when an admin
 *   disables the user or resets the password.
 * - Brute force: an account locks for 15 minutes after 10 wrong passwords in a row (kept in the database, so a
 *   restart does not reset it); one IP is limited to 30 failed logins per 15 minutes across all usernames.
 *   Unknown usernames take the same time and get the same message as wrong passwords.
 * - Requests that change data must come from this site (Origin / Referer check) as a second line against CSRF.
 */

export const LOCK_AFTER = 10;
export const LOCK_MINUTES = 15;
const IP_LIMIT = 30;
const IP_WINDOW_MS = 15 * 60e3;
const COMMON = new Set(['12345678', '123456789', '1234567890', '11111111', '88888888', '66666666', '00000000', 'password', 'password1',
  'password123', 'qwerty123', 'abc12345', 'abcd1234', 'a1234567', 'admin123', 'admin888', 'admin1234', 'qwer1234', '1qaz2wsx', 'aa123456',
  'iloveyou', 'woaini1314', 'zxcvbnm123', 'p@ssw0rd', 'passw0rd']);

export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export function hashPassword(pw) { return bcrypt.hashSync(String(pw), 10); }
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(pw, username) {
  const p = String(pw || '');
  if (p.length < 8) return '密码至少 8 位';
  if (p.length > 72) return '密码不能超过 72 位';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return '密码要同时包含字母和数字';
  if (username && p.toLowerCase().includes(String(username).toLowerCase())) return '密码不能包含用户名';
  if (COMMON.has(p.toLowerCase())) return '这个密码太常见了，换一个';
  return null;
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
  + "connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

export function setupAuth(app, db, { cookieSecure = false, sessionDays = 7, idleHours = 12 } = {}) {
  const sessionMs = sessionDays * 86400e3;
  const idleMs = idleHours * 3600e3;
  const now = () => new Date();
  const iso = (d) => d.toISOString().replace('T', ' ').slice(0, 19); // same format as SQLite datetime('now')
  const ipFails = new Map(); // ip -> [timestamps]

  // ---- security headers on every response ----
  app.addHook('onSend', async (req, reply, payload) => {
    for (const [k, v] of Object.entries(SEC_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', PAGE_CSP);
    if (cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (req.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // ---- who is calling ----
  const bySession = db.prepare(`SELECT s.token, s.created_at, s.last_seen, s.expires_at,
      u.id, u.username, u.name, u.role, u.active, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`);
  const touch = db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?');
  const drop = db.prepare('DELETE FROM sessions WHERE token = ?');
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);
  app.addHook('onRequest', async (req) => {
    // CSRF: a request that changes data must come from our own pages
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.url.startsWith('/api/')) {
      const src = req.headers.origin || req.headers.referer;
      if (src) {
        let host = null;
        try { host = new URL(src).host; } catch { /* bad header */ }
        const ours = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map((h) => String(h).replace(/:(80|443)$/, ''));
        if (!ours.includes(host)) {
          const e = new Error('请求来源不对，请刷新页面后再试'); e.statusCode = 403; throw e;
        }
      }
    }
    const raw = req.cookies.sid;
    if (!raw) return;
    const t = hashToken(raw);
    const s = bySession.get(t);
    if (!s) return;
    const n = now();
    const last = Date.parse((s.last_seen || s.created_at || s.expires_at).replace(' ', 'T') + 'Z');
    if (!s.active || Date.parse(s.expires_at.replace(' ', 'T') + 'Z') <= n.getTime() || n.getTime() - last > idleMs) {
      drop.run(t);
      return;
    }
    if (n.getTime() - last > 60e3) touch.run(iso(n), t);
    req.sessionToken = t;
    req.user = { id: s.id, username: s.username, name: s.name, role: s.role, active: s.active, must_change_password: s.must_change_password };
  });

  app.decorate('auth', (...roles) => async (req) => {
    const err = (code, msg) => { const e = new Error(msg); e.statusCode = code; return e; };
    if (!req.user) throw err(401, '请先登录');
    // until the first password change, only the password page works
    if (req.user.must_change_password && !['/api/me', '/api/me/password', '/api/logout'].includes(req.routeOptions.url)) throw err(403, '请先修改初始密码');
    if (roles.length && !roles.includes(req.user.role)) throw err(403, '没有权限');
  });

  const startSession = (req, reply, userId) => {
    const raw = crypto.randomBytes(32).toString('base64url');
    const n = now();
    db.prepare('INSERT INTO sessions(token, user_id, expires_at, created_at, last_seen, ip, user_agent) VALUES (?,?,?,?,?,?,?)')
      .run(hashToken(raw), userId, iso(new Date(n.getTime() + sessionMs)), iso(n), iso(n), req.ip, String(req.headers['user-agent'] || '').slice(0, 300));
    db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now') OR last_seen <= ?").run(iso(new Date(n.getTime() - idleMs)));
    reply.setCookie('sid', raw, { path: '/', httpOnly: true, sameSite: 'lax', secure: cookieSecure, maxAge: sessionDays * 86400 });
  };

  // ---- login / logout ----
  app.post('/api/login', async (req, reply) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const ip = req.ip;
    const t = Date.now();
    const recent = (ipFails.get(ip) || []).filter((x) => t - x < IP_WINDOW_MS);
    const tooMany = () => { const e = new Error(`尝试次数太多，请 ${LOCK_MINUTES} 分钟后再试`); e.statusCode = 429; return e; };
    if (recent.length >= IP_LIMIT) throw tooMany();

    const u = username ? db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) : null;
    if (u && u.locked_until && Date.parse(u.locked_until.replace(' ', 'T') + 'Z') > t) throw tooMany();
    const ok = bcrypt.compareSync(password, u ? u.password_hash : DUMMY_HASH) && !!u && !!u.active;
    if (!ok) {
      recent.push(t); ipFails.set(ip, recent);
      if (u) {
        const n = (u.failed_count || 0) + 1;
        const lock = n >= LOCK_AFTER ? iso(new Date(t + LOCK_MINUTES * 60e3)) : null;
        db.prepare('UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : n, lock, u.id);
        audit(db, u.id, 'login', u.id, lock ? '登录失败，账号锁定 15 分钟' : '登录失败', { ip, active: !!u.active });
      } else {
        audit(db, null, 'login', null, '登录失败（用户名不存在）', { username: username.slice(0, 40), ip });
      }
      const e = new Error('用户名或密码不对'); e.statusCode = 401; throw e;
    }
    db.prepare('UPDATE users SET failed_count = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ? WHERE id = ?').run(iso(now()), ip, u.id);
    startSession(req, reply, u.id);
    audit(db, u.id, 'login', u.id, '登录', { ip });
    return { ok: true, must_change_password: !!u.must_change_password };
  });

  app.post('/api/logout', async (req, reply) => {
    if (req.sessionToken) drop.run(req.sessionToken);
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  // ---- the signed-in user ----
  app.get('/api/me', { preHandler: app.auth() }, async (req) => ({
    user: req.user,
    settings: { company_name: getSetting(db, 'company_name'), opening_date: getSetting(db, 'opening_date') },
    security: { idle_hours: idleHours, session_days: sessionDays },
  }));

  app.post('/api/me/password', { preHandler: app.auth() }, async (req, reply) => {
    const { old_password, new_password } = req.body || {};
    const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const bad = (m) => { const e = new Error(m); e.statusCode = 400; return e; };
    if (!bcrypt.compareSync(String(old_password || ''), u.password_hash)) throw bad('原密码不对');
    const problem = passwordProblem(new_password, req.user.username);
    if (problem) throw bad(problem);
    if (bcrypt.compareSync(String(new_password), u.password_hash)) throw bad('新密码不能和原密码一样');
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = datetime('now') WHERE id = ?").run(hashPassword(new_password), req.user.id);
    // sign out every device, then give this one a fresh session
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
    startSession(req, reply, req.user.id);
    audit(db, req.user.id, 'user', req.user.id, '修改密码', { ip: req.ip });
    return { ok: true };
  });

  app.get('/api/me/sessions', { preHandler: app.auth() }, async (req) => db.prepare(
    'SELECT token, created_at, last_seen, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen DESC',
  ).all(req.user.id).map((s) => ({ id: s.token.slice(0, 12), current: s.token === req.sessionToken, created_at: s.created_at, last_seen: s.last_seen, ip: s.ip, user_agent: s.user_agent })));

  app.post('/api/me/sessions/logout-others', { preHandler: app.auth() }, async (req) => {
    const r = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
    audit(db, req.user.id, 'user', req.user.id, '退出其他设备', { count: r.changes });
    return { ok: true, count: r.changes };
  });

  return { startSession };
}
