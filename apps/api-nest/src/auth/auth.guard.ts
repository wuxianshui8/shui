import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { DataSource } from "typeorm";
import { InjectDataSource } from "@nestjs/typeorm";
import { verifyToken } from "../common/token";
import { forbidden, unauthorized } from "../common/errors";
import { IS_PUBLIC } from "../public.decorator";
import { PERM_KEY, ROLES_KEY } from "../common/access";

/** 「必须改初始口令」状态下仍可访问的路由（否则用户无法自救） */
const PASSWORD_CHANGE_ALLOWLIST = [
  "/api/auth/change-password",
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/deactivate",
];

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers["authorization"] || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const payload = token ? verifyToken(token) : null;
    if (payload) req.user = payload;
    if (isPublic) return true;
    if (!payload) throw unauthorized();

    // 每次请求回查账号状态与令牌版本：禁用、角色变更、改密/注销后旧令牌立即失效
    const rows = await this.ds.query(
      "SELECT `id`,`role`,`status`,`token_version`,`must_change_password` FROM `users` WHERE `id` = ? LIMIT 1",
      [payload.uid],
    );
    if (!rows.length) throw unauthorized("账号不存在");
    if (rows[0].status === "disabled") throw forbidden("账号已被禁用，请联系平台客服");
    if (Number(rows[0].token_version || 0) !== Number(payload.v || 0)) {
      throw unauthorized("登录状态已失效，请重新登录");
    }
    req.user.role = rows[0].role;

    // 后台开通的账号：必须先改初始口令，才能使用其它接口
    if (Number(rows[0].must_change_password || 0) === 1) {
      const path = String(req.originalUrl || req.url || "").split("?")[0];
      if (!PASSWORD_CHANGE_ALLOWLIST.includes(path)) {
        throw forbidden("首次登录请先修改初始口令");
      }
    }

    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles && roles.length && !roles.includes(rows[0].role)) throw forbidden();

    // 细粒度权限点（需求 4.5.9）：以规则 `permissions`（权限点 → 角色列表）为准。
    // 注意：@Perm 只会在 @Roles 通过之后再判断，两者同时存在时等价于「角色 ∩ 权限矩阵」。
    const perms = this.reflector.getAllAndOverride<string[]>(PERM_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (perms && perms.length) {
      const cfg = await this.ds.query("SELECT `value` FROM `rule_configs` WHERE `key` = 'permissions' LIMIT 1");
      let matrix: Record<string, string[]> = {};
      try {
        matrix = cfg.length ? JSON.parse(cfg[0].value) : {};
      } catch {
        matrix = {};
      }
      const role = rows[0].role;
      const missing = perms.filter((k) => !Array.isArray(matrix[k]) || !matrix[k].includes(role));
      if (missing.length) throw forbidden("当前角色无「" + missing.join("、") + "」权限，请联系管理员在权限矩阵中授予");
    }
    return true;
  }
}
