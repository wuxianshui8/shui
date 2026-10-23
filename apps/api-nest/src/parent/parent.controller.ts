import { Controller, Get, Param, Put, Body, Query, Req } from "@nestjs/common";
import { ParentService } from "./parent.service";
import { OrdersService } from "../order/orders.service";
import { Roles } from "../common/access";
import { ok } from "../common/reply";

@Controller("parent")
@Roles("parent")
export class ParentController {
  constructor(
    private readonly svc: ParentService,
    private readonly orders: OrdersService,
  ) {}

  private coords(q: any, req: any) {
    const lat = Number(q.lat);
    const lng = Number(q.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0) return { lat, lng };
    return { lat: 30.262, lng: 120.133 }; // 无定位时按默认地址坐标回退
  }

  @Get("home")
  async home(@Query() q: any, @Req() req: any) {
    const { lat, lng } = this.coords(q, req);
    return ok(await this.svc.home(req.user.uid, lat, lng));
  }

  @Get("teachers")
  async teachers(@Query() q: any, @Req() req: any) {
    return ok(await this.svc.teachers(req.user.uid, q));
  }

  @Get("teachers/:id")
  async teacherDetail(@Param("id") id: string, @Query() q: any, @Req() req: any) {
    const { lat, lng } = this.coords(q, req);
    return ok(await this.svc.teacherDetail(req.user.uid, Number(id), lat, lng));
  }

  @Get("profile")
  async profile(@Req() req: any) {
    return ok(await this.svc.profile(req.user.uid));
  }

  /** 设置/清除家长头像（先 POST /api/upload 拿 /uploads/xxx，再提交这里；avatar=null 恢复默认） */
  @Put("avatar")
  async setAvatar(@Body() body: { avatar?: string | null }, @Req() req: any) {
    return ok(await this.svc.setAvatar(Number(req.user.uid), body?.avatar ?? null));
  }

  /** 家长订单列表（按状态分组筛选） */
  @Get("orders")
  async ordersList(@Query("status") status: string, @Req() req: any) {
    return ok(await this.orders.listBy(Number(req.user.uid), "parent", status));
  }
}