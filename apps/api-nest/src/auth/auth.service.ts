import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { randomInt } from "node:crypto";
import { hashPassword, verifyPassword } from "../common/password";
import { signToken } from "../common/token";
import { bad, biz, forbidden, tooMany, unauthorized } from "../common/errors";
import { nowIso } from "../common/reply";
import { audit } from "../common/audit";
import { RuleConfigService } from "../rules/rule-config.service";
import { maskPhone, resolveRegion } from "../common/geo";
import { getSmsSender } from "../integrations/sms/sms.service";
import { getWechatProvider } from "../integrations/wechat/wechat.service";

// 进程内验证码 / 登录失败计数：带 TTL 与容量上限，避免被随机手机号灌爆内存
// （多实例部署时应迁移到 Redis，见 docs/SECURITY.md「已知偏离」）
const smsCodes = new Map<string, { code: string; exp: number }>();
const smsSentAt = new Map<string, number>();
const loginFails = new Map<string, { count: number; until: number }>();
const MEM_MAX = 5000;

/** 过期清理 + 超限按插入顺序淘汰 */
function purge(map: Map<string, any>, expired: (v: any) => boolean) {
  for (const [k, v] of map) if (expired(v)) map.delete(k);
  while (map.size > MEM_MAX) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
}

/**
 * 是否处于「开发/演示」模式：只有该模式才回显验证码、才跳过发码冷却。
 * 生产部署必须设置 NODE_ENV=production（config.ts 同时会强制要求 AUTH_SECRET），
 * 亦可用 DEV_SMS=0 显式关闭回显。
 */
const devSms = () => process.env.DEV_SMS !== "0" && process.env.NODE_ENV !== "production";

@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RuleConfigService,
  ) {}

  async sendCode(phone: string) {
    if (!/^1\d{10}$/.test(phone)) throw bad("请输入正确的手机号");
    purge(smsCodes, (v) => v.exp < Date.now());
    purge(smsSentAt, (t) => Date.now() - t > 3600_000);
    // 同号发送间隔 60s（DEV_SMS=1 的本地演示/自动化场景不限，否则用例无法连续换号注册）
    if (!devSms()) {
      const last = smsSentAt.get(phone);
      if (last && Date.now() - last < 60_000) throw tooMany("SMS_TOO_FREQUENT", "验证码发送过于频繁，请 60 秒后再试");
    }
    const code = String(randomInt(100000, 999999));
    const ttl = 300;
    // 先下发、后落码：网关失败时不能留下一个「可用但用户没收到」的验证码
    try {
      await getSmsSender().sendCode(phone, code, ttl);
    } catch (e: any) {
      // 不把网关错误细节透给调用方（可能含密钥/签名/模板号线索），只留服务端日志
      console.error("[sms] 下发失败：" + (e?.message || e));
      throw biz("SMS_SEND_FAILED", "验证码发送失败，请稍后重试");
    }
    smsCodes.set(phone, { code, exp: Date.now() + ttl * 1000 });
    smsSentAt.set(phone, Date.now());
    // 生产环境绝不回显验证码；devCode 仅在 DEV_SMS=1 时返回（供本地演示与自动化用例）
    return { phone: maskPhone(phone), ttl, ...(devSms() ? { devCode: code } : {}) };
  }

  /** 登录失败锁定阈值：由规则配置中心 risk 组驱动 */
  private async guardCfg() {
    const cfg: any = await this.rules.get("risk");
    return {
      limit: Math.max(1, Number(cfg?.login_fail_limit ?? 5)),
      lockMin: Math.max(1, Number(cfg?.lock_minutes ?? 15)),
    };
  }
  private fail(g: { key: string; limit: number; lockMin: number }) {
    const rec = loginFails.get(g.key) || { count: 0, until: 0 };
    rec.count += 1;
    if (rec.count >= g.limit) rec.until = Date.now() + g.lockMin * 60000;
    loginFails.set(g.key, rec);
  }
  private pass(key: string) {
    loginFails.delete(key);
  }

  /** 验证码登录：手机号不存在时自动注册为家长（需求 4.1.1） */
  async loginByCode(phone: string, code: string, ip: string, inviteToken?: string, deviceFp?: string) {
    if (!/^1\d{10}$/.test(phone)) throw bad("请输入正确的手机号");
    purge(loginFails, (v) => v.until > 0 && v.until < Date.now());
    const { limit, lockMin } = await this.guardCfg();
    const g = { key: (ip || "-") + ":" + phone, limit, lockMin };
    const rec = loginFails.get(g.key);
    if (rec && rec.count >= limit && rec.until > Date.now()) {
      const mins = Math.max(1, Math.ceil((rec.until - Date.now()) / 60000));
      throw tooMany("LOGIN_LOCKED", "登录失败次数过多，请 " + mins + " 分钟后再试");
    }
    const saved = smsCodes.get(phone);
    if (!saved || saved.code !== code) {
      this.fail(g);
      throw bad("验证码错误或已过期");
    }
    if (saved.exp < Date.now()) {
      this.fail(g);
      smsCodes.delete(phone);
      throw bad("验证码已过期");
    }
    // 验证码一次性使用：校验通过即失效，避免被日志/共享设备泄露后重放
    smsCodes.delete(phone);
    this.pass(g.key);
    let user = (await this.ds.query("SELECT * FROM `users` WHERE `phone` = ? LIMIT 1", [phone]))[0];
    if (!user) {
      // 第 8 章反作弊：同设备 / 同 IP 注册频次限制（阈值来自规则配置中心）
      await this.assertRegisterAllowed(ip, deviceFp);
      const region = await resolveRegion(this.ds, 30.2741, 120.1551);
      const r = await this.ds.query(
        "INSERT INTO `users` (`phone`,`nickname`,`role`,`status`,`region_id`,`reg_ip`,`device_fp`,`created_at`) VALUES (?,?,?,?,?,?,?,?)",
        [phone, "用户" + phone.slice(-4), "parent", "active", region?.id ?? null, ip || null, deviceFp || null, nowIso()],
      );
      const uid = r.insertId;
      await this.ds.query("INSERT IGNORE INTO `parent_profiles` (`user_id`,`credit_score`,`credit_level`) VALUES (?,100,'L0')", [uid]);
      await this.ds.query("INSERT IGNORE INTO `wallets` (`user_id`,`updated_at`) VALUES (?,?)", [uid, nowIso()]);
      user = (await this.ds.query("SELECT * FROM `users` WHERE `id` = ? LIMIT 1", [uid]))[0];
      if (inviteToken) await this.bindByInvite(uid, inviteToken);
    }
    if (user.status === "disabled") throw forbidden("账号已被禁用");
    await this.ds.query("UPDATE `users` SET `last_login_at` = ? WHERE `id` = ?", [nowIso(), user.id]);
    return { token: signToken(user.id, user.role, Number(user.token_version || 0)), user: this.publicUser(user) };
  }

  /**
   * 微信一键登录（需求 4.1.1）：首次微信登录自动注册为家长。
   * code → openid 的兑换交给微信通道（未配 appid/secret 时走 mock：同 code 稳定映射同一账号）。
   */
  async loginByWechat(code: string, ip: string, inviteToken?: string, deviceFp?: string) {
    const c = String(code || "").trim();
    if (!c) throw bad("缺少微信登录 code");
    const session = await getWechatProvider().exchange(c);
    let user = (await this.ds.query("SELECT * FROM `users` WHERE `wx_openid` = ? LIMIT 1", [session.openid]))[0];
    if (!user) {
      // 与验证码注册同一套反作弊阈值：微信登录也不能绕过设备/IP 频次限制
      await this.assertRegisterAllowed(ip, deviceFp);
      const region = await resolveRegion(this.ds, 30.2741, 120.1551);
      const r = await this.ds.query(
        "INSERT INTO `users` (`wx_openid`,`nickname`,`role`,`status`,`region_id`,`reg_ip`,`device_fp`,`created_at`) VALUES (?,?,?,?,?,?,?,?)",
        [session.openid, "微信用户" + randomInt(1000, 9999), "parent", "active", region?.id ?? null, ip || null, deviceFp || null, nowIso()],
      );
      const uid = r.insertId;
      await this.ds.query("INSERT IGNORE INTO `parent_profiles` (`user_id`,`credit_score`,`credit_level`) VALUES (?,100,'L0')", [uid]);
      await this.ds.query("INSERT IGNORE INTO `wallets` (`user_id`,`updated_at`) VALUES (?,?)", [uid, nowIso()]);
      if (inviteToken) await this.bindByInvite(uid, inviteToken);
      user = (await this.ds.query("SELECT * FROM `users` WHERE `id` = ? LIMIT 1", [uid]))[0];
    }
    if (user.status === "disabled") throw forbidden("账号已被禁用");
    await this.ds.query("UPDATE `users` SET `last_login_at` = ? WHERE `id` = ?", [nowIso(), user.id]);
    return {
      token: signToken(user.id, user.role, Number(user.token_version || 0)),
      user: this.publicUser(user),
      // 便于前端/门禁区分真实微信通道与 mock（不泄露 appid/secret）
      wechatChannel: session.channel,
    };
  }

  private async bindByInvite(uid: number, token: string) {
    const pc = (await this.ds.query("SELECT * FROM `promotion_codes` WHERE `token` = ? LIMIT 1", [token]))[0];
    if (!pc) return;
    const sp = (await this.ds.query("SELECT * FROM `sales_profiles` WHERE `user_id` = ? LIMIT 1", [pc.sales_id]))[0];
    if (!sp || sp.status !== "active") return;
    await this.ds.query(
      "INSERT IGNORE INTO `bindings` (`user_id`,`sales_id`,`agent_id`,`region_id`,`source`,`bound_at`) VALUES (?,?,?,?,?,?)",
      [uid, sp.user_id, sp.agent_id, sp.region_id, "scan", nowIso()],
    );
  }

  /** 口令登录：失败次数锁定由规则配置中心驱动（risk.login_fail_limit），429 + LOGIN_LOCKED */
  async loginByPassword(phone: string, password: string, ip = "") {
    const cfg = (await this.rules.get("risk")) as any;
    const limit = Math.max(1, Number(cfg?.login_fail_limit ?? 5));
    const lockMin = Math.max(1, Number(cfg?.lock_minutes ?? 15));
    const key = (ip || "-") + ":" + phone;
    const rec = loginFails.get(key);
    if (rec && rec.count >= limit && rec.until > Date.now()) {
      const mins = Math.max(1, Math.ceil((rec.until - Date.now()) / 60000));
      throw tooMany("LOGIN_LOCKED", "登录失败次数过多，请 " + mins + " 分钟后再试");
    }
    const user: any = (await this.ds.query("SELECT * FROM `users` WHERE `phone` = ? LIMIT 1", [phone]))[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      const cur = loginFails.get(key) || { count: 0, until: 0 };
      cur.count += 1;
      if (cur.count >= limit) cur.until = Date.now() + lockMin * 60000;
      loginFails.set(key, cur);
      throw bad("手机号或密码错误");
    }
    if (user.status === "disabled") throw forbidden("账号已被禁用");
    loginFails.delete(key);
    await this.ds.query("UPDATE `users` SET `last_login_at` = ? WHERE `id` = ?", [nowIso(), user.id]);
    return { token: signToken(user.id, user.role, Number(user.token_version || 0)), user: this.publicUser(user) };
  }
  /**
   * 修改口令（需求 4.1 账号安全）：
   *  - 已设置过口令的账号必须校验原口令；纯验证码注册的账号首次设置口令可不填原口令；
   *  - 新口令 ≥ 8 位且同时含字母与数字，且不能与原口令相同；
   *  - 成功后写审计日志，并自增 token_version（旧令牌立即失效），返回新令牌供当前会话继续使用。
   */
  async changePassword(uid: number, oldPassword: string, newPassword: string) {
    const user: any = (await this.ds.query("SELECT * FROM `users` WHERE `id` = ? LIMIT 1", [uid]))[0];
    if (!user) throw unauthorized("账号不存在");
    if (user.password_hash && !verifyPassword(String(oldPassword || ""), user.password_hash)) {
      throw bad("原口令错误");
    }
    const pwd = String(newPassword || "");
    if (pwd.length < 8) throw bad("新口令至少 8 位");
    if (!/[A-Za-z]/.test(pwd) || !/[0-9]/.test(pwd)) throw bad("新口令需同时包含字母与数字");
    if (user.password_hash && verifyPassword(pwd, user.password_hash)) throw bad("新口令不能与原口令相同");
    // 改密后旧令牌立即失效：token_version 自增，并返回新令牌让当前会话继续可用
    await this.ds.query(
      "UPDATE `users` SET `password_hash` = ?, `token_version` = `token_version` + 1, `must_change_password` = 0 WHERE `id` = ?",
      [hashPassword(pwd), uid],
    );
    await audit(this.ds, { user: { uid, role: user.role }, ip: "" }, "auth.changePassword", "users:" + uid);
    return {
      ok: true,
      token: signToken(uid, user.role, Number(user.token_version || 0) + 1),
      mustChangePassword: false,
    };
  }

  async me(uid: number) {
    const rows = await this.ds.query("SELECT * FROM `users` WHERE `id` = ? LIMIT 1", [uid]);
    if (!rows.length) throw unauthorized("账号不存在");
    return this.publicUser(rows[0]);
  }
  publicUser(u: any) {
    return {
      id: Number(u.id),
      phone: u.phone,
      nickname: u.nickname,
      avatar: u.avatar,
      role: u.role,
      status: u.status,
      regionId: u.region_id == null ? null : Number(u.region_id),
      createdAt: u.created_at,
      // 后台开通的账号首次登录必须先改初始口令（前端据此进入改密页）
      mustChangePassword: Number(u.must_change_password || 0) === 1,
    };
  }

  /** 账号注销（需求第 8 章）：匿名化个人信息，订单与资金流水按合规要求留存 */
  async deactivate(ctx: any) {
    const uid = Number(ctx.user.uid);
    const u = (await this.ds.query("SELECT * FROM `users` WHERE `id` = ? LIMIT 1", [uid]))[0];
    if (!u) throw unauthorized("账号不存在");
    if (u.role === "admin") throw forbidden("管理员账号不可自助注销");

    const active = Number((await this.ds.query(
      "SELECT COUNT(*) AS c FROM `orders` WHERE (`parent_id` = ? OR `teacher_id` = ?) AND `status` IN ('awaiting_payment','pending_class','in_class','awaiting_parent_confirm','refunding')",
      [uid, uid],
    ))[0].c);
    if (active > 0) throw biz("HAS_ACTIVE_ORDER", "您还有 " + active + " 笔订单未完结，请完结或取消后再注销账号");

    const w = (await this.ds.query("SELECT `frozen` FROM `wallets` WHERE `user_id` = ? LIMIT 1", [uid]))[0];
    if (w && Number(w.frozen) > 0) {
      throw biz("HAS_FROZEN", "账户还有 ¥" + (Number(w.frozen) / 100).toFixed(2) + " 冻结金额待结算，暂不可注销");
    }

    await this.ds.transaction(async (m) => {
      await m.query(
        "UPDATE `users` SET `status` = 'disabled', `phone` = NULL, `wx_openid` = NULL, `nickname` = '已注销用户', `avatar` = NULL, `real_name` = NULL, `id_card` = NULL, `device_fp` = NULL, `reg_ip` = NULL WHERE `id` = ?",
        [uid],
      );
      await m.query("DELETE FROM `addresses` WHERE `user_id` = ?", [uid]);
      await m.query("UPDATE `teacher_profiles` SET `online` = 0 WHERE `user_id` = ?", [uid]);
      await m.query("UPDATE `teacher_services` SET `status` = 'off' WHERE `teacher_id` = ?", [uid]);
      await m.query("UPDATE `demands` SET `status` = 'revoked' WHERE `parent_id` = ? AND `status` IN ('published','paused')", [uid]);
      await m.query("UPDATE `sales_profiles` SET `status` = 'disabled' WHERE `user_id` = ?", [uid]);
      await m.query("UPDATE `agent_profiles` SET `status` = 'disabled' WHERE `user_id` = ?", [uid]);
      await m.query("DELETE FROM `favorites` WHERE `user_id` = ?", [uid]);
      await audit(m, ctx, "user.deactivate", "users:" + uid, { role: u.role });
    });
    return { ok: true, message: "账号已注销，个人身份信息已清除，订单与资金流水按合规要求留存" };
  }

  /** 第 8 章反作弊：同设备 24h / 同 IP 1h 注册频次限制；超限写风控事件并拒绝 */
  private async assertRegisterAllowed(ip: string, deviceFp?: string) {
    const cfg = (await this.rules.get("risk")) as any;
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const region = await resolveRegion(this.ds, 30.2741, 120.1551);
    const regionId = region?.id ?? null;

    const deviceLimit = Number(cfg?.register_per_device_day ?? 2);
    if (deviceFp) {
      const deviceCount = Number((await this.ds.query(
        "SELECT COUNT(*) AS c FROM `users` WHERE `device_fp` = ? AND `created_at` >= ?", [deviceFp, dayAgo],
      ))[0].c);
      if (deviceCount >= deviceLimit) {
        await this.ds.query(
          "INSERT INTO `risk_events` (`user_id`,`region_id`,`type`,`level`,`reason`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?)",
          [null, regionId, "brush", "high", "同一设备 24 小时内注册 " + (deviceCount + 1) + " 个账号，超过阈值 " + deviceLimit + " 个，已拦截（设备 " + deviceFp + "）", "open", nowIso()],
        );
        throw biz("RISK_BLOCKED", "风控拦截：同一设备 24 小时内最多注册 " + deviceLimit + " 个账号，请稍后再试");
      }
    }
    const ipLimit = Number(cfg?.register_per_ip_hour ?? 20);
    if (ip) {
      const ipCount = Number((await this.ds.query(
        "SELECT COUNT(*) AS c FROM `users` WHERE `reg_ip` = ? AND `created_at` >= ?", [ip, hourAgo],
      ))[0].c);
      if (ipCount >= ipLimit) {
        await this.ds.query(
          "INSERT INTO `risk_events` (`user_id`,`region_id`,`type`,`level`,`reason`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?)",
          [null, regionId, "brush", "mid", "同一 IP 1 小时内注册 " + (ipCount + 1) + " 个账号，超过阈值 " + ipLimit + " 个，已拦截（IP " + ip + "）", "open", nowIso()],
        );
        throw biz("RISK_BLOCKED", "风控拦截：同一网络 1 小时内最多注册 " + ipLimit + " 个账号，请稍后再试");
      }
    }
  }
}