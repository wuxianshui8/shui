/**
 * 可信客户端 IP。
 * 直连部署时只认 TCP 源地址；只有显式声明 TRUST_PROXY=1（前面确实有反向代理）时才采信 X-Forwarded-For，
 * 否则攻击者可通过轮换 XFF 绕过「登录失败锁定」与「注册频次限制」。
 */
function clientIp(req: any): string {
  if (process.env.TRUST_PROXY === "1") {
    const xff = (req.headers?.["x-forwarded-for"] || "").toString().split(",")[0].trim();
    if (xff) return xff;
  }
  return (req.socket?.remoteAddress || "").toString();
}
import { Body, Controller, Get, Post, Query, Req, HttpCode } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { Public } from "../public.decorator";
import { ok } from "../common/reply";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @HttpCode(200)
  @Post("send-code")
  sendCode(@Body() body: { phone?: string }) {
    return this.auth.sendCode(String(body.phone || "").trim()).then((data) => ok(data));
  }

  @Public()
  @HttpCode(200)
  @Post("login")
  async login(@Body() body: { phone?: string; code?: string; inviteToken?: string }, @Req() req: any) {
    const ip = clientIp(req);
    const fp = (req.headers["x-device-fp"] || "").toString().slice(0, 128) || undefined;
    return ok(await this.auth.loginByCode(String(body.phone || "").trim(), String(body.code || "").trim(), ip, body.inviteToken, fp));
  }

  /** 公众号网页授权链接：H5 端「微信一键登录」需要跳转到微信授权页时向服务端要（未配置返回 400 WECHAT_NOT_CONFIGURED） */
  @Public()
  @Get("wechat/authorize-url")
  async wechatAuthorizeUrl(@Query("redirect") redirect: string, @Query("state") state: string) {
    return ok(await this.auth.wechatAuthorizeUrl(redirect, state));
  }

  /** 微信一键登录（需求 4.1.1）：首次登录自动注册家长，返回与短信登录一致的 token/user */
  @Public()
  @HttpCode(200)
  @Post("wechat")
  async wechat(@Body() body: { code?: string; inviteToken?: string }, @Req() req: any) {
    const ip = clientIp(req);
    const fp = (req.headers["x-device-fp"] || "").toString().slice(0, 128) || undefined;
    return ok(await this.auth.loginByWechat(String(body?.code || "").trim(), ip, body?.inviteToken, fp));
  }

  @Public()
  @HttpCode(200)
  @Post("login-password")
  async loginPassword(@Body() body: { phone?: string; password?: string }, @Req() req: any) {
    const ip = clientIp(req);
    return ok(await this.auth.loginByPassword(String(body.phone || "").trim(), String(body.password || ""), ip));
  }

  @Get("me")
  async me(@Req() req: any) {
    return ok({ user: await this.auth.me(req.user.uid) });
  }

  /** 账号注销（需求第 8 章）：匿名化个人信息，保留订单与资金流水 */
  @HttpCode(200)
  @Post("deactivate")
  async deactivate(@Req() req: any) {
    const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim();
    return ok(await this.auth.deactivate({ user: req.user, ip }));
  }

  /** 修改口令（登录态；需要原口令） */
  @HttpCode(200)
  @Post("change-password")
  async changePassword(@Body() body: { oldPassword?: string; newPassword?: string }, @Req() req: any) {
    return ok(await this.auth.changePassword(Number(req.user.uid), String(body?.oldPassword || ""), String(body?.newPassword || "")));
  }
}