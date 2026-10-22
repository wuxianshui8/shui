// 平台后台路由（需求 4.5）：与 admin.controller.ts 共用 /api/admin 前缀
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import { Perm, Roles } from "../common/access";
import { ok } from "../common/reply";
import { audit } from "../common/audit";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { AdminOpsService } from "./admin-ops.service";
import { JobsService } from "../jobs/jobs.service";
import { RuleConfigService } from "../rules/rule-config.service";

@Controller("admin")
@Roles("admin")
export class AdminOpsController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly svc: AdminOpsService,
    private readonly jobs: JobsService,
    private readonly rules: RuleConfigService,
  ) {}

  /* ---------------- 规则配置中心 ---------------- */
  @Get("rules")
  async rulesList() {
    return ok(await this.svc.rulesList());
  }

  @Put("rules/:key")
  async updateRule(@Param("key") key: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.updateRule(req, key, body?.value));
  }

  /* ---------------- 用户 / 教员审核 ---------------- */
  @Get("users")
  async users(@Query() q: any) {
    return ok(await this.svc.users(q));
  }

  @Post("users/:id/toggle")
  @HttpCode(200)
  async toggleUser(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    req.body = body;
    return ok(await this.svc.toggleUser(req, Number(id)));
  }

  @Get("teachers/pending")
  async pendingTeachers() {
    return ok(await this.svc.pendingTeachers());
  }

  @Post("teachers/:id/audit")
  @HttpCode(200)
  async auditTeacher(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.auditTeacher(req, Number(id), !!body?.approve, body?.reason));
  }

  @Post("teachers/:id/level")
  @HttpCode(200)
  async setTeacherLevel(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.setTeacherLevel(req, Number(id), String(body?.level || "")));
  }

  /* ---------------- 订单 ---------------- */
  @Get("orders")
  async orders(@Query() q: any) {
    return ok(await this.svc.ordersList(q));
  }

  @Get("orders/export")
  async ordersExport(@Query() q: any, @Req() req: any, @Res() res: any) {
    const { csv } = await this.svc.ordersExportCsv(req, q);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="platform-orders.csv"');
    res.end(csv);
  }

  @Roles("admin", "agent")
  @Perm("order.price")
  @Post("orders/:id/price")
  @HttpCode(200)
  async priceOrder(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.priceOrder(req, Number(id), body));
  }

  @Roles("admin", "agent")
  @Perm("order.close")
  @Post("orders/:id/close")
  @HttpCode(200)
  async closeOrder(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.closeOrder(req, Number(id), body?.reason));
  }

  /** 抢单超时清理（5.1） */
  @Post("applications/expire")
  @HttpCode(200)
  async expireApplications(@Req() req: any) {
    const expired = await this.jobs.expireApplications();
    await audit(this.ds, req, "admin.applications.expire", null, { count: expired });
    return ok({ expired, timeoutHours: Number(((await this.rules.get("dispatch")) as any)?.grab_confirm_timeout_hours ?? 24) });
  }

  /**
   * 超时未支付关单（A2）：与定时任务同一函数，便于运维手动补跑。
   * `olderThanMinutes` 传 0/不传走规则配置（payment.pay_timeout_minutes，默认 15）。
   */
  @Post("orders/close-expired")
  @HttpCode(200)
  async closeExpiredOrders(@Req() req: any, @Body() body: any) {
    const r = await this.svc.closeExpiredOrders(body?.olderThanMinutes != null ? Number(body.olderThanMinutes) : undefined);
    await audit(this.ds, req, "admin.orders.close_expired", null, { closed: r.closed, timeoutMinutes: r.timeoutMinutes });
    return ok(r);
  }

  /* ---------------- 代理管理 ---------------- */
  @Get("agents")
  async agents() {
    return ok(await this.svc.agents());
  }

  @Post("agents")
  @HttpCode(200)
  async createAgent(@Body() body: any, @Req() req: any) {
    return ok(await this.svc.createAgent(req, body));
  }

  @Get("agents/:id")
  async agentDetail(@Param("id") id: string) {
    return ok(await this.svc.agentDetail(Number(id)));
  }

  @Put("agents/:id")
  async updateAgent(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.updateAgent(req, Number(id), body));
  }

  @Post("agents/:id/toggle")
  @HttpCode(200)
  async toggleAgent(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.toggleAgent(req, Number(id)));
  }

  @Post("agents/:id/deposit")
  @HttpCode(200)
  async agentDeposit(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.agentDeposit(req, Number(id), body));
  }

  /* ---------------- 风控与仲裁 ---------------- */
  @Get("risks")
  async risks() {
    return ok(await this.svc.risks());
  }

  @Post("risks/:id/handle")
  @HttpCode(200)
  async handleRisk(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.handleRisk(req, Number(id), String(body?.action || ""), body?.note));
  }

  @Post("appeals/:id/arbitrate")
  @HttpCode(200)
  async arbitrate(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.arbitrateAppeal(req, Number(id), !!body?.accept, body?.reason));
  }

  @Post("complaints/:id/close")
  @HttpCode(200)
  async closeComplaint(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.closeComplaint(req, Number(id), body?.note));
  }

  /* ---------------- 运营工具 ---------------- */
  @Get("banners")
  async banners() {
    return ok(await this.svc.banners());
  }

  @Post("banners")
  @HttpCode(200)
  async createBanner(@Body() body: any, @Req() req: any) {
    return ok(await this.svc.createBanner(req, body));
  }

  @Put("banners/:id")
  async updateBanner(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.updateBanner(req, Number(id), body));
  }

  @Post("banners/:id/toggle")
  @HttpCode(200)
  async toggleBanner(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.toggleBanner(req, Number(id)));
  }

  @Delete("banners/:id")
  async deleteBanner(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.deleteBanner(req, Number(id)));
  }

  @Get("announcements")
  async announcements() {
    return ok(await this.svc.announcements());
  }

  @Post("announcements")
  @HttpCode(200)
  async createAnnouncement(@Body() body: any, @Req() req: any) {
    return ok(await this.svc.createAnnouncement(req, body));
  }

  @Put("announcements/:id")
  async updateAnnouncement(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.updateAnnouncement(req, Number(id), body));
  }

  @Post("announcements/:id/toggle")
  @HttpCode(200)
  async toggleAnnouncement(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.toggleAnnouncement(req, Number(id)));
  }

  @Post("announcements/:id/pin")
  @HttpCode(200)
  async pinAnnouncement(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.pinAnnouncement(req, Number(id)));
  }

  @Delete("announcements/:id")
  async deleteAnnouncement(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.deleteAnnouncement(req, Number(id)));
  }

  @Get("coupons")
  async coupons() {
    return ok(await this.svc.coupons());
  }

  @Post("coupons")
  @HttpCode(200)
  async createCoupon(@Body() body: any, @Req() req: any) {
    return ok(await this.svc.createCoupon(req, body));
  }

  @Put("coupons/:id")
  async updateCoupon(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.updateCoupon(req, Number(id), body));
  }

  @Post("coupons/:id/toggle")
  @HttpCode(200)
  async toggleCoupon(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.toggleCoupon(req, Number(id)));
  }

  /* ---------------- 审计日志 ---------------- */
  @Get("audit-logs")
  async auditLogs(@Query() q: any) {
    return ok(await this.svc.auditLogs(q));
  }

  /* ---------------- 区域 ---------------- */
  /** 行政区搜索：?q=张北 按地名找；?codes=130722,330106 按 adcode 取边界（含 rings） */
  @Get("regions/areas")
  async regionAreas(@Query() q: any) {
    return ok(this.svc.searchAreas(q?.q, q?.codes));
  }

  @Get("regions")
  async regions() {
    return ok(await this.svc.regions());
  }

  @Post("regions")
  @HttpCode(200)
  async createRegion(@Body() body: any, @Req() req: any) {
    return ok(await this.svc.createRegion(req, body));
  }

  /* ---------------- 细粒度权限矩阵（需求 4.5.9）---------------- */
  @Get("permissions")
  async permissions() {
    return ok(await this.svc.permissions());
  }

  @Put("permissions")
  async updatePermissions(@Body() body: any, @Req() req: any) {
    return ok(await this.svc.updatePermissions(req, body));
  }

  /* ---------------- 需求池（需求 4.5.3）---------------- */
  @Get("demands")
  async demands(@Query() q: any) {
    return ok(await this.svc.demands(q));
  }

  /* ---------------- 管理员账号（需求 4.5.9）---------------- */
  @Get("admins")
  async admins() {
    return ok(await this.svc.admins());
  }

  @Post("admins")
  @HttpCode(200)
  async createAdmin(@Body() body: any, @Req() req: any) {
    return ok(await this.svc.createAdmin(req, body));
  }

  @Post("admins/:id/toggle")
  @HttpCode(200)
  async toggleAdmin(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.toggleAdmin(req, Number(id)));
  }
}
