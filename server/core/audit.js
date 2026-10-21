import { run } from "./db.js";
import { nowIso } from "./ids.js";

/** 全链路操作留痕：资金操作、规则变更、权限操作必须记录 */
export function audit(ctx, action, target = null, detail = null) {
  try {
    run(
      "INSERT INTO audit_logs (actor_id, actor_role, action, target, detail, ip, created_at) VALUES (?,?,?,?,?,?,?)",
      ctx?.user?.id ?? null,
      ctx?.user?.role ?? null,
      action,
      target,
      detail ? JSON.stringify(detail) : null,
      ctx?.ip ?? null,
      nowIso()
    );
  } catch (err) {
    console.error("[audit-fail]", action, err.message);
  }
}

export function notify(userId, title, content, type = "system", link = null) {
  if (!userId) return;
  run(
    "INSERT INTO messages (user_id, title, content, type, read, link, created_at) VALUES (?,?,?,?,0,?,?)",
    userId,
    title,
    content,
    type,
    link,
    nowIso()
  );
}