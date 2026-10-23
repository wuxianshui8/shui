import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(process.cwd());
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, "app.db");

export const db = new DatabaseSync(DB_FILE);

export function run(sql, ...params) {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
}
export function get(sql, ...params) {
  return db.prepare(sql).get(...params) || null;
}
export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
export function pluck(sql, ...params) {
  const row = get(sql, ...params);
  if (!row) return null;
  return row[Object.keys(row)[0]];
}

let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  depth++;
  try {
    const out = fn();
    db.exec("COMMIT");
    depth--;
    return out;
  } catch (err) {
    depth--;
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }
}

/** 轻量列迁移：为已存在的表补齐新增字段（SQLite 无 ADD COLUMN IF NOT EXISTS） */
export function ensureColumn(table, column, type) {
  const cols = db.prepare("PRAGMA table_info(" + table + ")").all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + type);
    return true;
  }
  return false;
}

export function migrate() {
  const sql = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  db.exec(sql);
  ensureColumn("users", "reg_ip", "TEXT");
  ensureColumn("users", "device_fp", "TEXT");
  ensureColumn("orders", "remind_sent", "INTEGER NOT NULL DEFAULT 0");
  // 身份证正反面上传与识别（老库自动补列，不破坏已有数据）
  ensureColumn("teacher_profiles", "id_card_front_url", "TEXT");
  ensureColumn("teacher_profiles", "id_card_back_url", "TEXT");
  ensureColumn("teacher_profiles", "id_card_name", "TEXT");
  ensureColumn("teacher_profiles", "id_card_verified", "INTEGER NOT NULL DEFAULT 0");
  // 按行政区设置片区（老库自动补列）
  ensureColumn("regions", "admin_codes", "TEXT");
  // 用户软删除标记（删除 = 打标记 + 匿名化，业务台账保留）
  ensureColumn("users", "deleted_at", "TEXT");
}
export { DATA_DIR, DB_FILE, ROOT };