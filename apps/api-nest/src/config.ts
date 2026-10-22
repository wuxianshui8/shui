import { join } from "node:path";

/** 运行时配置：全部来自环境变量，默认值面向本地开发 */
const DEV_SECRET = "jiajiao-dev-secret-please-change-in-prod";
if (process.env.NODE_ENV === "production" && !process.env.AUTH_SECRET) {
  // 生产环境禁止以内置默认密钥启动：否则任何人都能用仓库里的字符串自签管理员令牌
  throw new Error("生产环境必须配置 AUTH_SECRET（建议 >= 32 字符随机串），拒绝使用内置默认密钥启动");
}
if (!process.env.AUTH_SECRET) {
  console.warn("[安全提示] 未配置 AUTH_SECRET，正在使用内置开发密钥（仅限本地演示，生产必须覆盖）");
}

export const config = {
  port: Number(process.env.PORT || 4300),
  authSecret: process.env.AUTH_SECRET || DEV_SECRET,
  tokenTtlSeconds: 7 * 24 * 3600,
  mysql: {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3307),
    username: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "jiajiao",
  },
  redis: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6380),
    db: Number(process.env.REDIS_DB || 0),
  },
  webDir: process.env.WEB_DIR || "web",
  /**
   * 上传图片落盘目录（默认仓库 data/uploads，容器内是 /app/data/uploads 挂载卷）。
   * 用绝对路径兜底：容器的工作目录是 /app/apps/api-nest，相对路径容易写飞。
   */
  uploadDir: process.env.UPLOAD_DIR
    ? String(process.env.UPLOAD_DIR)
    : join(process.cwd(), "..", "..", "data", "uploads"),
  /** 证件识别通道：mock（默认，从文件名解析）| tencent（腾讯云 IDCardOCR） */
  ocrProvider: String(process.env.OCR_PROVIDER || "mock").toLowerCase(),
};