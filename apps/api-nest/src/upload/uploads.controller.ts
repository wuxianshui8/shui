/**
 * 涓婁紶鎺ュ彛锛歅OST /api/upload
 *   body: { dataUrl: "data:image/png;base64,...", filename?: "韬唤璇佹闈?png" }
 *   鈫?{ url: "/uploads/xxx.png", size, sha256 }
 *
 * 闇€瑕佺櫥褰曪紙榛樿鍏ㄥ眬閴存潈锛夛紝涓嶉檺瀹氳鑹诧細瀹堕暱鎻愪氦閫€娆惧嚟璇併€佹暀鍛樻彁浜よ瘉浠堕兘鍙兘鐢ㄥ埌銆? */
import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { audit } from "../common/audit";
import { ok } from "../common/reply";
import { UploadsService } from "./uploads.service";

// 注意：全局前缀是 `api`（main.ts 的 setGlobalPrefix），这里不要再写 "api"，否则会变成 /api/api/upload
@Controller()
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  @Post("upload")
  @HttpCode(200)
  async upload(@Body() b: any, @Req() req: any) {
    const saved = this.uploads.saveDataUrl(b?.dataUrl, b?.filename);
    // 瀹¤鍙鍏冧俊鎭紝涓嶆妸鍥剧墖鍐呭鍐欒繘鏃ュ織
    await audit(this.ds, req, "upload.image", null, {
      url: saved.url,
      size: saved.size,
      sha256: saved.sha256,
      filename: saved.filename,
    });
    return ok({ url: saved.url, size: saved.size, sha256: saved.sha256, filename: saved.filename });
  }
}
