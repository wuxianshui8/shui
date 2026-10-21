// 公开运营接口（无需登录，需求 4.1：Banner / 公告 / 领券）
import { Controller, Get, Query } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { Public } from "../public.decorator";
import { ok } from "../common/reply";

@Controller("public")
@Public()
export class PublicController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Get("banners")
  async banners() {
    return ok(await this.ds.query("SELECT * FROM `banners` WHERE `status` = 'on' ORDER BY `sort` ASC"));
  }

  @Get("announcements")
  async announcements(@Query("audience") audience: string) {
    return ok(await this.ds.query(
      "SELECT * FROM `announcements` WHERE `status` = 'on' AND (`audience` = 'all' OR `audience` = ?) ORDER BY `pinned` DESC, `created_at` DESC LIMIT 20",
      [audience || "all"],
    ));
  }

  @Get("coupons")
  async coupons() {
    return ok(await this.ds.query("SELECT * FROM `coupons` WHERE `status` = 'on' ORDER BY `amount` DESC"));
  }
}
