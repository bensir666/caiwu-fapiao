// Online backup of the database: node src/backup.js  (keeps the newest 30 copies in DATA_DIR/backups)
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(here, '..', 'data'));
const dir = path.join(dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const target = path.join(dir, `invoice-${stamp}.db`);
const db = new Database(path.join(dataDir, 'invoice.db'), { readonly: true });
await db.backup(target);
db.close();
const old = fs.readdirSync(dir).filter((f) => /^invoice-.*\.db$/.test(f)).sort().reverse().slice(30);
for (const f of old) fs.unlinkSync(path.join(dir, f));
console.log('备份完成：' + target);
