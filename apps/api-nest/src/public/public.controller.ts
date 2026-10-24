// 公开运营接口（无需登录，需求 4.1：Banner / 公告 / 领券 / 游客浏览与发需求页）
import { Controller, Get, Param, Query } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { Public } from "../public.decorator";
import { ok } from "../common/reply";
import { notFound } from "../common/errors";
import { ParentService } from "../parent/parent.service";

@Controller("public")
@Public()
export class PublicController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly parent: ParentService,
  ) {}

  /** 与家长端 home 同口径的坐标回退：无定位时按默认地址坐标算片区 */
  private coords(q: any) {
    const lat = Number(q?.lat);
    const lng = Number(q?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0) return { lat, lng };
    return { lat: 30.262, lng: 120.133 };
  }

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

  /**
   * 协议文案（P75）：用户服务协议 / 隐私政策 / 退款规则。
   * 列表只给 key+title+更新时间（游客不需要正文），正文按 key 取，后台可维护。
   */
  @Get("agreements")
  async agreements() {
    return ok(await this.ds.query(
      "SELECT `key`, `title`, `updated_at` AS updatedAt FROM `agreements` " +
        "ORDER BY FIELD(`key`, 'user', 'privacy', 'refund'), `key`",
    ));
  }

  @Get("agreements/:key")
  async agreement(@Param("key") key: string) {
    const a = (await this.ds.query(
      "SELECT `key`, `title`, `content`, `updated_at` AS updatedAt FROM `agreements` WHERE `key` = ? LIMIT 1",
      [String(key)],
    ))[0];
    if (!a) throw notFound("协议不存在");
    return ok(a);
  }

  /** 游客首页：未登录也能看到「发布家教需求」表单（片区 / 轮播 / 公告 / 附近在线教员 / 加急费区间） */
  @Get("home")
  async home(@Query() q: any) {
    const { lat, lng } = this.coords(q);
    return ok(await this.parent.guestHome(lat, lng));
  }

  /** 游客可浏览教员广场（收藏状态恒为 false，手机号仍按平台规则脱敏） */
  @Get("teachers")
  async teachers(@Query() q: any) {
    const { lat, lng } = this.coords(q);
    return ok(await this.parent.teachers(0, { ...q, lat, lng }));
  }

  @Get("teachers/:id")
  async teacherDetail(@Param("id") id: string, @Query() q: any) {
    const { lat, lng } = this.coords(q);
    return ok(await this.parent.teacherDetail(0, Number(id), lat, lng));
  }
}
