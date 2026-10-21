// ============================================================
// 数据备份脚本（需求 7.2：核心数据每日备份，支持灾备恢复）
//   用法：node scripts/backup.mjs [保留份数]
//   产物：data/backups/<时间戳>/{app.db, uploads/}
//   恢复：停服 → 把备份目录内容覆盖回 data/ → 启动
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { db, DB_FILE, DATA_DIR } from "../server/core/db.js";

const KEEP = Math.max(1, Number(process.argv[2] || 7));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const root = path.join(DATA_DIR, "backups");
const target = path.join(root, stamp);

fs.mkdirSync(target, { recursive: true });

// 1) 数据库一致性快照（VACUUM INTO 会做一次完整整理并落盘，等价于热备）
const dbCopy = path.join(target, "app.db");
db.exec("VACUUM INTO '" + dbCopy.replace(/'/g, "''") + "'");

// 2) 上传文件（证件、图片）整目录复制
const uploads = path.join(DATA_DIR, "uploads");
let fileCount = 0;
if (fs.existsSync(uploads)) {
  const dest = path.join(target, "uploads");
  fs.cpSync(uploads, dest, { recursive: true });
  fileCount = fs.readdirSync(dest).length;
}

// 3) 保留策略：仅保留最近 KEEP 份
const all = fs
  .readdirSync(root)
  .filter((n) => /^\d{8}-\d{6}$/.test(n))
  .sort();
let removed = 0;
while (all.length > KEEP) {
  const old = all.shift();
  fs.rmSync(path.join(root, old), { recursive: true, force: true });
  removed++;
}

const size = (fs.statSync(dbCopy).size / 1024).toFixed(1);
console.log("备份完成：" + target);
console.log("  数据库 " + size + " KB，上传文件 " + fileCount + " 个，清理旧备份 " + removed + " 份（保留 " + KEEP + " 份）");
console.log("  源库：" + DB_FILE);