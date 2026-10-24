import { DataSource } from "typeorm";

/**
 * 启动时的「幂等补列」：老库升级到新版本镜像时，新增字段不能靠「重建库」解决
 * （容器里的 MySQL 是命名卷，重建镜像不会重建卷），也不该让第一个请求 500。
 *
 * 做法：查 information_schema 判断列是否存在，缺了才 ALTER。只加列、不删列、不改类型，
 * 因此对已有数据零风险；加过的库再启动一次就是空操作。
 *
 * 与 SQLite 参考实现里的 `ensureColumn()` 是同一套思路，两边都保持「老库自动跟上」。
 */
const REQUIRED_COLUMNS: { table: string; column: string; ddl: string; why: string }[] = [
  {
    table: "regions",
    column: "admin_codes",
    ddl: "TEXT NULL",
    why: "按行政区设置片区（存 adcode 数组）",
  },
  {
    table: "users",
    column: "deleted_at",
    ddl: "VARCHAR(255) DEFAULT NULL",
    why: "用户软删除标记（删除=打标记+匿名化，业务台账保留）",
  },
  {
    table: "users",
    column: "username",
    ddl: "VARCHAR(64) DEFAULT NULL",
    why: "教员端「用户名 + 密码」登录（可空；唯一性由接口与种子保证）",
  },
  {
    table: "orders",
    column: "cancel_requested_at",
    ddl: "VARCHAR(255) DEFAULT NULL",
    why: "家长取消申请时间（教员端「退款 / 驳回」需要知道有申请在等他处理）",
  },
  {
    table: "orders",
    column: "cancel_rejected_at",
    ddl: "VARCHAR(255) DEFAULT NULL",
    why: "教员驳回取消的时间（家长端据此提示「教员已驳回」）",
  },
  {
    table: "orders",
    column: "cancel_reject_reason",
    ddl: "TEXT NULL",
    why: "教员驳回理由（回给家长看）",
  },
  {
    table: "teacher_profiles",
    column: "base_address",
    ddl: "TEXT NULL",
    why: "教员授课地址（家长「到教员处上课」时的实际上课地点，P65）",
  },
  {
    table: "orders",
    column: "place",
    ddl: "VARCHAR(32) NOT NULL DEFAULT 'home'",
    why: "授课地点：home=教员上门到家长地址 / teacher_place=家长到教员授课地址（P65）",
  },
  {
    table: "orders",
    column: "parent_checkin_at",
    ddl: "VARCHAR(255) DEFAULT NULL",
    why: "家长到场打卡时间（P66：家长到教员处上课时双方各打卡确认到场）",
  },
  {
    table: "orders",
    column: "parent_checkin_lat",
    ddl: "DOUBLE DEFAULT NULL",
    why: "家长打卡纬度（定位授权后上报，用于距离校验与风控取证）",
  },
  {
    table: "orders",
    column: "parent_checkin_lng",
    ddl: "DOUBLE DEFAULT NULL",
    why: "家长打卡经度",
  },
  {
    table: "orders",
    column: "parent_checkin_distance",
    ddl: "INT DEFAULT NULL",
    why: "家长打卡点距上课地点的米数（超阈值照样写 risk_events）",
  },
];

export async function ensureSchemaColumns(ds: DataSource): Promise<string[]> {
  const added: string[] = [];
  for (const c of REQUIRED_COLUMNS) {
    const rows = await ds.query(
      "SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
      [c.table, c.column],
    );
    if (Number(rows?.[0]?.c || 0) > 0) continue;
    await ds.query("ALTER TABLE `" + c.table + "` ADD COLUMN `" + c.column + "` " + c.ddl);
    added.push(c.table + "." + c.column);
    console.log("[schema] 老库补列 " + c.table + "." + c.column + "（" + c.why + "）");
  }
  return added;
}
