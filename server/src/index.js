import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const app = await buildApp({
  dataDir: env.DATA_DIR || path.join(here, '..', 'data'),
  webDir: env.WEB_DIR || path.join(here, '..', '..', 'web', 'dist'),
  adminUser: env.ADMIN_USERNAME,
  adminPassword: env.ADMIN_PASSWORD,
  cookieSecure: env.COOKIE_SECURE === '1' || env.COOKIE_SECURE === 'true',
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  sessionDays: env.SESSION_DAYS,
  idleHours: env.IDLE_HOURS,
  logger: { level: env.LOG_LEVEL || 'info' },
});

if (app.initialPassword) {
  const user = env.ADMIN_USERNAME || 'admin';
  const msg = env.ADMIN_PASSWORD
    ? `已创建管理员账号 ${user}（初始密码为 ADMIN_PASSWORD，首次登录必须修改）`
    : `已创建管理员账号 ${user}，初始密码：${app.initialPassword}（首次登录必须修改）`;
  console.log('\n==============================\n' + msg + '\n==============================\n');
}

const port = Number(env.PORT) || 3000;
await app.listen({ port, host: env.HOST || '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); process.exit(0); });
