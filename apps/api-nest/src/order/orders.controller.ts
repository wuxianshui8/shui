import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req } from "@nestjs/common";
import { OrdersService } from "./orders.service";
import { Roles } from "../common/access";
import { ok } from "../common/reply";

@Controller()
export class OrdersController {
  constructor(private readonly svc: OrdersService) {}

  /* ---------------- 下单 ---------------- */
  @Post("orders/from-service")
  @HttpCode(200)
  @Roles("parent")
  async fromService(@Body() body: any, @Req() req: any) {
    return ok(await this.svc.fromService(Number(req.user.uid), body));
  }

  /* ---------------- 详情 ---------------- */
  @Get("orders/:id")
  async detail(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.detail(req.user, Number(id)));
  }

  /* ---------------- 担保支付（幂等：X-Idem-Key）---------------- */
  @Post("orders/:id/pay")
  @HttpCode(200)
  @Roles("parent")
  async pay(@Param("id") id: string, @Body() body: any, @Headers("x-idem-key") idem: string, @Req() req: any) {
    return ok(await this.svc.pay(Number(req.user.uid), Number(id), idem, body?.channel));
  }

  /* ---------------- 上门打卡 ---------------- */
  @Post("orders/:id/checkin")
  @HttpCode(200)
  @Roles("teacher")
  async checkin(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.checkin(Number(req.user.uid), Number(id), body?.lat, body?.lng));
  }

  /* ---------------- 结束授课 ---------------- */
  @Post("orders/:id/finish")
  @HttpCode(200)
  @Roles("teacher")
  async finish(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.finish(Number(req.user.uid), Number(id)));
  }

  /* ---------------- 家长确认完成 ---------------- */
  @Post("orders/:id/confirm")
  @HttpCode(200)
  @Roles("parent")
  async confirm(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.confirmComplete(Number(req.user.uid), Number(id)));
  }

  /* ---------------- 取消 ---------------- */
  @Post("orders/:id/cancel")
  @HttpCode(200)
  async cancel(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.cancelOrder(Number(req.user.uid), req.user.role, Number(id), body?.reason || ""));
  }

  /* ---------------- 申请退款 ---------------- */
  @Post("orders/:id/refund")
  @HttpCode(200)
  @Roles("parent")
  async refund(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.applyRefund(Number(req.user.uid), Number(id), body?.reason));
  }

  /* ---------------- 紧急求助（家长 / 教员）---------------- */
  @Post("orders/:id/sos")
  @HttpCode(200)
  async sos(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    const r = await this.svc.raiseSos(Number(req.user.uid), req.user.role, Number(id), body || {});
    return ok({
      ...r,
      message: r.duplicated
        ? "该订单已有进行中的求助工单，平台正在处理，无需重复提交"
        : "求助已提交，平台客服与片区负责人将立即介入",
    });
  }

  /* ---------------- 评价 ---------------- */
  @Post("orders/:id/review")
  @HttpCode(200)
  @Roles("parent")
  async review(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.submitReview(Number(req.user.uid), Number(id), body));
  }
}
