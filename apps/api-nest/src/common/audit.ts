// 全链路操作留痕 + 站内消息（与参考实现 core/audit.js 行为一致）
import { EntityManager } from "typeorm";
import { nowIso } from "./reply";

/** 资金操作、规则变更、权限操作必须留痕；写日志失败不影响主流程 */
export async function audit(
  m: EntityManager | any,
  ctx: any,
  action: string,
  target: string | null = null,
  detail: any = null,
) {
  try {
    await m.query(
      "INSERT INTO `audit_logs` (`actor_id`,`actor_role`,`action`,`target`,`detail`,`ip`,`created_at`) VALUES (?,?,?,?,?,?,?)",
      [ctx?.user?.uid ?? null, ctx?.user?.role ?? null, action, target, detail ? JSON.stringify(detail) : null, ctx?.ip ?? null, nowIso()],
    );
  } catch (err: any) {
    console.error("[audit-fail]", action, err?.message);
  }
}

export async function notify(
  m: EntityManager | any,
  userId: number,
  title: string,
  content: string,
  type = "system",
  link: string | null = null,
) {
  if (!userId) return;
  await m.query(
    "INSERT INTO `messages` (`user_id`,`title`,`content`,`type`,`read`,`link`,`created_at`) VALUES (?,?,?,?,0,?,?)",
    [userId, title, content, type, link, nowIso()],
  );
}
