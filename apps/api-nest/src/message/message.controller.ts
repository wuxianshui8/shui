// 站内消息（全角色共用）
import { Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { ok } from "../common/reply";

@Controller("messages")
export class MessageController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Get()
  async list(@Req() req: any) {
    const uid = Number(req.user.uid);
    return ok({
      list: await this.ds.query("SELECT * FROM `messages` WHERE `user_id` = ? ORDER BY `created_at` DESC LIMIT 100", [uid]),
      unread: Number((await this.ds.query("SELECT COUNT(*) AS c FROM `messages` WHERE `user_id` = ? AND `read` = 0", [uid]))[0].c),
    });
  }

  @Post(":id/read")
  @HttpCode(200)
  async read(@Param("id") id: string, @Req() req: any) {
    await this.ds.query("UPDATE `messages` SET `read` = 1 WHERE `id` = ? AND `user_id` = ?", [Number(id), Number(req.user.uid)]);
    return ok({ ok: true });
  }

  @Post("read-all")
  @HttpCode(200)
  async readAll(@Req() req: any) {
    await this.ds.query("UPDATE `messages` SET `read` = 1 WHERE `user_id` = ?", [Number(req.user.uid)]);
    return ok({ ok: true });
  }
}
