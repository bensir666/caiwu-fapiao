import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const BOARDS = ['电商', '工厂'];
export const ROLES = ['管理员', '财务', '跟单员'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('管理员','财务','跟单员')),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- 我方受票主体（发票上的购买方）
CREATE TABLE IF NOT EXISTS buyers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tax_id TEXT NOT NULL UNIQUE,
  board TEXT NOT NULL CHECK (board IN ('电商','工厂')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  rate REAL NOT NULL DEFAULT 0.13,
  tax_cost INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  contact TEXT,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 供应商在哪些板块供货，以及每个板块的期初欠票（含税）
CREATE TABLE IF NOT EXISTS supplier_boards (
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  board TEXT NOT NULL CHECK (board IN ('电商','工厂')),
  opening REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (supplier_id, board)
);

-- 开票主体（发票上的销售方），按税号建档；一个主体可挂多个供应商
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tax_id TEXT NOT NULL UNIQUE,
  note TEXT
);
CREATE TABLE IF NOT EXISTS entity_suppliers (
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  PRIMARY KEY (entity_id, supplier_id)
);

CREATE TABLE IF NOT EXISTS statements (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT '对账单' CHECK (kind IN ('对账单','调整单')),
  parent_id INTEGER REFERENCES statements(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  board TEXT NOT NULL CHECK (board IN ('电商','工厂')),
  period_from TEXT,
  period_to TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('含税','不含税')),
  rate REAL NOT NULL,
  amount REAL NOT NULL,
  net REAL NOT NULL,
  tax REAL NOT NULL,
  gross REAL NOT NULL,
  tax_cost REAL,
  status TEXT NOT NULL CHECK (status IN ('草稿','待终审','已生效','已驳回','已作废')),
  reject_reason TEXT,
  supplier_ref TEXT,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  submitted_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_statements_sup ON statements(supplier_id, board, status);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  issue_date TEXT,
  type TEXT,
  seller_name TEXT,
  seller_tax_id TEXT,
  buyer_name TEXT,
  buyer_tax_id TEXT,
  net REAL NOT NULL,
  tax REAL NOT NULL,
  total REAL NOT NULL,
  rate REAL,
  remark TEXT,
  red_of TEXT,
  supplier_id INTEGER REFERENCES suppliers(id),
  board TEXT CHECK (board IS NULL OR board IN ('电商','工厂')),
  status TEXT NOT NULL CHECK (status IN ('已入账','待处理','已退回')),
  pending_reason TEXT,
  candidates TEXT,
  moved INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  file_path TEXT,
  file_name TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  booked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_sup ON invoices(supplier_id, board, status);

CREATE TABLE IF NOT EXISTS tax_costs (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  board TEXT NOT NULL CHECK (board IN ('电商','工厂')),
  amount REAL NOT NULL,
  paid_at TEXT NOT NULL,
  invoice_number TEXT,
  statement_id INTEGER REFERENCES statements(id),
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  target TEXT NOT NULL,
  target_id TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target, target_id);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function getSetting(db, key, fallback = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

export function audit(db, userId, target, targetId, action, detail) {
  db.prepare('INSERT INTO audit_log(user_id, target, target_id, action, detail) VALUES (?,?,?,?,?)')
    .run(userId ?? null, target, targetId == null ? null : String(targetId), action, detail == null ? null : JSON.stringify(detail));
}
