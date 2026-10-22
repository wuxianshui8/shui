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
