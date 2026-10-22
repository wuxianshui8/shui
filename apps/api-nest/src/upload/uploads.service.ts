/**
 * 图片上传（base64 → 落盘）。
 *
 * 为什么不用 multipart/multer：
 * ① 依赖审计把 `multer` 链的 2 个 high 判定为「不可达（全仓无文件上传中间件）」，
 *    一旦引入 `FileInterceptor`，那条结论就失效，要跟着做一次大版本升级，风险不划算；
 * ② 浏览器与 uni-app 都能把图片读成 dataURL，base64 + JSON 足够，链路更短；
 * ③ 服务端只需 fs + Buffer，零第三方依赖，`check-image-runtime` 的依赖扫描不受影响。
 *
 * 安全口径：只接受 image/png|jpeg|webp，单张 ≤ 2MB；文件名由服务端随机生成、扩展名由 MIME 决定；
 * 读取时再校验「url 必须是 /uploads/<单层文件名>」，杜绝目录穿越。
 */
import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { bad, biz } from "../common/errors";
import { config } from "../config";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

export interface SavedUpload {
  url: string;
  filename: string;
  size: number;
  sha256: string;
}

@Injectable()
export class UploadsService {
  /**
   * url → 原始文件名。只放内存，用于 mock 证件识别解析「姓名_身份证号」。
   * 不落盘也不进 URL：原始文件名常含姓名与身份证号，写进静态路径等于把 PII 公开。
   * 进程重启后映射丢失 → mock 识别返回「未识别到」（安全失败），真实通道不依赖它。
   */
  private readonly originalNames = new Map<string, string>();

  /** 最近一次写入是否成功（启动自检与 /api/health 诊断用） */
  private writable = true;
  private lastWriteError: string | null = null;

  /** 启动自检：真写一个探针文件，目录不可写时立刻在日志里报清楚，而不是等用户上传才发现 */
  selfCheck(): { ok: boolean; dir: string; error?: string } {
    try {
      const dir = this.ensureDir();
      const probe = join(dir, ".write-probe");
      writeFileSync(probe, String(Date.now()));
      rmSync(probe, { force: true });
      this.writable = true;
      this.lastWriteError = null;
      return { ok: true, dir };
    } catch (err: any) {
      this.writable = false;
      this.lastWriteError = String(err?.code || err?.message || err);
      return { ok: false, dir: this.dir(), error: this.lastWriteError };
    }
  }

  status(): { writable: boolean; dir: string; lastError: string | null } {
    return { writable: this.writable, dir: this.dir(), lastError: this.lastWriteError };
  }

  /** 上传目录（容器内是挂载卷，本地是仓库 data/uploads） */
  private dir(): string {
    return config.uploadDir;
  }

  private ensureDir(): string {
    const dir = this.dir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** dataURL → 文件；返回可公开访问的 /uploads/xxx 地址 */
  saveDataUrl(dataUrl: string, originalName?: string): SavedUpload {
    const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ""));
    if (!m) throw bad("图片格式不正确，请重新选择");
    const mime = m[1].toLowerCase();
    const ext = MIME_EXT[mime];
    if (!ext) throw bad("只支持 PNG / JPG / WEBP 图片");
    const buf = Buffer.from(m[2].replace(/\s/g, ""), "base64");
    if (!buf.length) throw bad("图片内容为空");
    if (buf.length > MAX_UPLOAD_BYTES) throw biz("FILE_TOO_LARGE", "图片不能超过 2MB，请压缩后重试");

    const name = Date.now().toString(36) + "_" + randomBytes(4).toString("hex") + "." + ext;
    try {
      // 建目录也要在 try 里：目录路径不可用（父级是文件、卷只读）时 mkdirSync 先抛，
      // 漏掉映射就会把 ENOTDIR 这类原始错误穿过异常过滤器变成「参数不合法」
      writeFileSync(join(this.ensureDir(), name), buf);
      this.writable = true;
    } catch (err: any) {
      this.writable = false;
      this.lastWriteError = String(err?.code || err?.message || err);
      throw biz("UPLOAD_UNAVAILABLE", "图片存储暂时不可用，请稍后重试或联系管理员");
    }

    const url = "/uploads/" + name;
    if (originalName) this.originalNames.set(url, String(originalName));
    return {
      url,
      filename: String(originalName || name),
      size: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  }

  /**
   * 按 /uploads/<name> 取回文件字节。只允许上传目录下的单层文件名；
   * 返回的 filename 优先用上传时的原始文件名（mock 识别需要），错误信息不含真实路径。
   */
  readByUrl(url: string): { buffer: Buffer; filename: string } {
    const s = String(url || "").trim();
    const prefix = "/uploads/";
    if (!s.startsWith(prefix)) throw bad("图片地址不合法");
    const rest = s.slice(prefix.length);
    const name = basename(rest);
    if (!name || name !== rest || name.includes("..")) throw bad("图片地址不合法");
    const file = join(this.dir(), name);
    if (!existsSync(file)) throw biz("UPLOAD_NOT_FOUND", "图片不存在，请重新上传");
    return { buffer: readFileSync(file), filename: this.originalNames.get(s) || name };
  }
}
