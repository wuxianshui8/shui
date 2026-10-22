// 单元测试：upload/uploads.service.ts（base64 上传的校验、落盘、读取与目录穿越防护）
// 用临时目录做真实读写，不碰仓库 data/；不需要数据库与 Redis。
process.env.AUTH_SECRET = "unit-test-secret-0123456789abcdef";

import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config 在 import 期读 env，所以先设好临时上传目录
const TMP = mkdtempSync(join(tmpdir(), "jiajiao-upload-"));
process.env.UPLOAD_DIR = TMP;

const { UploadsService, MAX_UPLOAD_BYTES } = await import("../../dist/upload/uploads.service.js");
const { config } = await import("../../dist/config.js");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const dataUrl = (mime, buf) => "data:" + mime + ";base64," + buf.toString("base64");

before(() => {
  assert.equal(config.uploadDir, TMP, "UPLOAD_DIR 环境变量应生效（绝对路径分支）");
});

after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

test("saveDataUrl：正常保存并返回 /uploads 地址、大小与 sha256", () => {
  const svc = new UploadsService();
  const saved = svc.saveDataUrl(dataUrl("image/png", PNG), "身份证正面.png");
  assert.match(saved.url, /^\/uploads\/[a-z0-9]+_[0-9a-f]+\.png$/);
  assert.equal(saved.size, PNG.length);
  assert.equal(saved.filename, "身份证正面.png", "原始文件名原样返回");
  assert.match(saved.sha256, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(join(TMP, saved.url.replace("/uploads/", ""))), "文件真的落盘了");
});

test("saveDataUrl：MIME 决定扩展名，jpg/jpeg/webp 都收", () => {
  const svc = new UploadsService();
  assert.match(svc.saveDataUrl(dataUrl("image/jpeg", PNG)).url, /\.jpg$/);
  assert.match(svc.saveDataUrl(dataUrl("image/webp", PNG)).url, /\.webp$/);
});
test("saveDataUrl：非 dataURL / 非图片 / 空内容 / 超限 各自报明确错误", () => {
  const svc = new UploadsService();
  assert.throws(() => svc.saveDataUrl("http://x/a.png"), /图片格式不正确/);
  assert.throws(() => svc.saveDataUrl(""), /图片格式不正确/);
  assert.throws(() => svc.saveDataUrl("data:image/png;base64,"), /图片格式不正确/, "载荷为空时归入格式错误");
  assert.throws(() => svc.saveDataUrl("data:text/plain;base64,SGVsbG8="), /只支持 PNG/);
  assert.throws(() => svc.saveDataUrl("data:image/png;base64,===="), /图片内容为空/);
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_BYTES + 10, 0)]);
  assert.throws(() => svc.saveDataUrl(dataUrl("image/png", big)), /不能超过 2MB/);
});

test("readByUrl：读回原字节，并优先返回上传时的原始文件名（mock 识别要用）", () => {
  const svc = new UploadsService();
  const saved = svc.saveDataUrl(dataUrl("image/png", PNG), "张三_330106199001011234.png");
  const back = svc.readByUrl(saved.url);
  assert.ok(back.buffer.equals(PNG));
  assert.equal(back.filename, "张三_330106199001011234.png", "原始文件名（含姓名与号码）只在内存里回传给识别通道");
});

test("readByUrl：无原始文件名记录时回落到磁盘文件名", () => {
  const svc = new UploadsService();
  const saved = svc.saveDataUrl(dataUrl("image/png", PNG));
  const other = new UploadsService(); // 另一个实例没有内存映射
  assert.equal(other.readByUrl(saved.url).filename, saved.url.replace("/uploads/", ""));
});

test("readByUrl：拒绝非 /uploads 前缀、目录穿越、多层路径、不存在的文件", () => {
  const svc = new UploadsService();
  assert.throws(() => svc.readByUrl("/etc/passwd"), /地址不合法/);
  assert.throws(() => svc.readByUrl(""), /地址不合法/);
  assert.throws(() => svc.readByUrl("/uploads/../package.json"), /地址不合法/);
  assert.throws(() => svc.readByUrl("/uploads/a/b.png"), /地址不合法/);
  assert.throws(() => svc.readByUrl("/uploads/not-exist.png"), /不存在/);
});

test("上传目录被删掉后会自动重建（容器首次启动/卷挂载晚于进程的场景）", () => {
  const svc = new UploadsService();
  rmSync(TMP, { recursive: true, force: true });
  assert.equal(existsSync(TMP), false);
  const saved = svc.saveDataUrl(dataUrl("image/png", PNG));
  const file = join(TMP, saved.url.replace("/uploads/", ""));
  assert.ok(existsSync(file), "目录被重建且文件写入成功");
  assert.ok(readFileSync(file).length > 0);
});

test("selfCheck / status：目录可写时 ok=true；不可写时报出原因而不是抛异常", async () => {
  const svc = new UploadsService();
  const okCheck = svc.selfCheck();
  assert.equal(okCheck.ok, true);
  assert.equal(okCheck.dir, TMP);
  assert.deepEqual(svc.status(), { writable: true, dir: TMP, lastError: null });
  // 把上传目录指向「父级是个文件」的路径 → 必然写不进去，验证失败分支与错误码
  const blocker = join(TMP, "blocker.bin");
  writeFileSync(blocker, "x");
  const badDir = join(blocker, "uploads");
  const cfg = (await import("../../dist/config.js")).config;
  const saved = cfg.uploadDir;
  cfg.uploadDir = badDir;
  try {
    const bad = svc.selfCheck();
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /ENOTDIR|EACCES|EPERM|EEXIST|ENOENT/);
    assert.equal(svc.status().writable, false);
    assert.throws(() => svc.saveDataUrl(dataUrl("image/png", PNG)), /图片存储暂时不可用/);
  } finally {
    cfg.uploadDir = saved;
  }
  assert.equal(svc.selfCheck().ok, true, "切回可用目录后自检恢复");
});
