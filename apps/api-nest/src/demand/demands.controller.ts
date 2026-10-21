import { Body, Controller, Get, Param, Post, Put, Req, HttpCode } from "@nestjs/common";
import { DemandsService } from "./demands.service";
import { OrdersService } from "../order/orders.service";
import { Roles } from "../common/access";
import { ok } from "../common/reply";
@Controller()
export class DemandsController {
  constructor(
    private readonly svc: DemandsService,
    private readonly orders: OrdersService,
  ) {}
  @HttpCode(200)

  @Post("demands")
  @Roles("parent")
  async create(@Body() body: any, @Req() req: any) {
    return ok(await this.svc.create(req.user.uid, body));
  }

  @Get("demands/mine")
  @Roles("parent")
  async mine(@Req() req: any) {
    return ok(await this.svc.mine(req.user.uid));
  }

  @Get("demands/:id")
  async detail(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.detail(req.user, Number(id)));
  }

  @Put("demands/:id")
  @Roles("parent")
  async update(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.update(req.user.uid, Number(id), body));
  }

  @HttpCode(200)

  @Post("demands/:id/action")
  @Roles("parent")
  async action(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.action(req.user.uid, Number(id), String(body.action)));
  }

  @HttpCode(200)

  @Post("demands/:id/apply")
  @Roles("teacher")
  async apply(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.apply(req.user.uid, Number(id)));
  }

  @Get("teacher/nearby-demands")
  @Roles("teacher")
  async nearby(@Req() req: any) {
    return ok(await this.svc.nearbyForTeacher(req.user.uid));
  }

  /** 家长确认教员接单 → 生成订单（并发安全，仅 1 次成功） */
  @HttpCode(200)
  @Post("demands/:id/confirm")
  @Roles("parent")
  async confirm(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.orders.confirmDemand(req.user.uid, Number(id), Number(body?.applicationId)));
  }
}