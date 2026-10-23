import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { haversineKm, maskPhone, resolveRegion } from "../common/geo";
import { RuleConfigService } from "../rules/rule-config.service";
import { RuleEngineService } from "../rules/rule-engine.service";
import { notFound } from "../common/errors";

@Injectable()
export class ParentService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RuleConfigService,
    private readonly engine: RuleEngineService,
  ) {}

  private async creditInfo(parentId: number) {
    const pp: any = (await this.ds.query("SELECT * FROM `parent_profiles` WHERE `user_id` = ? LIMIT 1", [parentId]))[0];
    if (!pp) return null;
    const levels = (await this.rules.get("parent_credit")) as any[];
    const lv = levels.find((l) => l.level === pp.credit_level) || levels[0];
    return {
      creditScore: pp.credit_score,
      creditLevel: pp.credit_level,
      creditLevelName: lv.name,
      reviewWeight: lv.weight,
      completedOrders: pp.completed_orders,
      cancelCount: pp.cancel_count,
      restricted: !!pp.restricted,
      nextLevel: levels.find((l) => l.min > pp.credit_score) || null,
    };
  }

  private card(row: any, levels: any[]): any {
    const lv = levels.find((l) => l.level === row.level) || levels[0];
    return {
      id: Number(row.user_id),
      nickname: row.nickname,
      avatar: row.avatar,
      phone: maskPhone(row.phone),
      identityType: row.identity_type,
      subjects: (row.subjects || "").split(",").filter(Boolean),
      stages: (row.stages || "").split(",").filter(Boolean),
      hourlyPrice: Number(row.hourly_price),
      serviceRadiusKm: Number(row.service_radius_km),
      coverArea: row.cover_area,
      intro: row.intro,
      level: row.level,
      levelName: lv.name,
      levelWeight: lv.weight,
      commission: lv.commission,
      growthScore: row.growth_score,
      ratingAvg: Number(Number(row.rating_avg).toFixed(2)),
      ratingCount: row.rating_count,
      completedLessons: row.completed_lessons,
      responseFactor: Number(row.response_factor),
      online: !!row.online,
      auditStatus: row.audit_status,
      // 广场只下发模糊坐标（2 位小数），精确住址在成交后通过订单详情提供
      baseLat: row.base_lat == null ? null : Number(Number(row.base_lat).toFixed(2)),
      baseLng: row.base_lng == null ? null : Number(Number(row.base_lng).toFixed(2)),
      status: row.status,
    };
  }

  /** 教员广场：距离 + 六维筛选 + 派单优先级排序（需求 4.1.4） */
  async teachers(parentId: number, q: any) {
    const lat = Number(q.lat ?? 30.2741);
    const lng = Number(q.lng ?? 120.1551);
    const dispatch = (await this.rules.get("dispatch")) as any;
    const levels = (await this.rules.get("teacher_levels")) as any[];

    const rows = await this.ds.query(
      "SELECT tp.*, u.nickname, u.avatar, u.phone, u.status FROM `teacher_profiles` tp JOIN `users` u ON u.id = tp.user_id WHERE tp.audit_status = 'approved' AND u.status = 'active'",
    );
    const favs = await this.ds.query("SELECT `teacher_id` FROM `favorites` WHERE `user_id` = ?", [parentId]);
    const favSet = new Set(favs.map((f: any) => Number(f.teacher_id)));

    const list: any[] = [];
    for (const row of rows) {
      const tLat = row.base_lat == null ? 30.2741 : Number(row.base_lat);
      const tLng = row.base_lng == null ? 120.1551 : Number(row.base_lng);
      const distance = Number(haversineKm(lat, lng, tLat, tLng).toFixed(2));
      const radius = Number(q.radiusKm || row.service_radius_km);
      if (distance > radius) continue;
      if (q.subject && !(row.subjects || "").includes(q.subject)) continue;
      if (q.stage && !(row.stages || "").includes(q.stage)) continue;
      if (q.level && row.level !== q.level) continue;
      if (q.priceMin && Number(row.hourly_price) < Number(q.priceMin)) continue;
      if (q.priceMax && Number(row.hourly_price) > Number(q.priceMax)) continue;
      if (q.online === "1" && !row.online) continue;
      const card = this.card(row, levels);
      card.distanceKm = distance;
      card.priority = await this.engine.dispatchPriority({
        distanceKm: distance,
        levelWeight: card.levelWeight,
        responseFactor: card.responseFactor,
        urgent: false,
      });
      card.favorited = favSet.has(Number(row.user_id));
      list.push(card);
    }
    const sort = q.sort || "priority";
    list.sort((a, b) => {
      if (sort === "price") return a.hourlyPrice - b.hourlyPrice;
      if (sort === "rating") return b.ratingAvg - a.ratingAvg;
      if (sort === "distance") return a.distanceKm - b.distanceKm;
      return b.priority - a.priority;
    });
    const page = Math.max(1, Number(q.page || 1));
    const size = Math.min(50, Number(q.pageSize || 20));
    return { list: list.slice((page - 1) * size, page * size), total: list.length, center: { lat, lng }, maxRadius: dispatch.max_radius_km };
  }

  /** 教员详情（需求 4.1.4） */
  async teacherDetail(parentId: number, id: number, lat: number, lng: number) {
    const rows = await this.ds.query(
      "SELECT tp.*, u.nickname, u.avatar, u.phone, u.status FROM `teacher_profiles` tp JOIN `users` u ON u.id = tp.user_id WHERE tp.user_id = ? AND tp.audit_status = 'approved' LIMIT 1",
      [id],
    );
    if (!rows.length) throw notFound("教员不存在");
    const levels = (await this.rules.get("teacher_levels")) as any[];
    const card = this.card(rows[0], levels);
    card.distanceKm = Number(
      haversineKm(lat, lng, card.baseLat ?? 30.2741, card.baseLng ?? 120.1551).toFixed(2),
    );
    card.services = await this.ds.query(
      "SELECT * FROM `teacher_services` WHERE `teacher_id` = ? AND `status` = 'on'",
      [id],
    );
    const reviews = await this.ds.query(
      "SELECT r.*, u.nickname AS parentName, u.avatar AS parentAvatar FROM `reviews` r JOIN `users` u ON u.id = r.parent_id WHERE r.teacher_id = ? AND r.status = 'public' ORDER BY r.created_at DESC LIMIT 20",
      [id],
    );
    card.reviews = reviews.map((r: any) => ({
      id: r.id,
      score: r.score,
      content: r.content,
      tags: r.tags ? JSON.parse(r.tags) : [],
      weight: Number(r.weight),
      parentName: r.parentName,
      parentAvatar: r.parentAvatar,
      createdAt: r.created_at,
      appealStatus: r.appeal_status,
    }));
    const dist: Record<string, number> = {};
    for (const r of card.reviews) dist[r.score] = (dist[r.score] || 0) + 1;
    card.scoreDist = dist;
    const fav = await this.ds.query("SELECT `id` FROM `favorites` WHERE `user_id` = ? AND `teacher_id` = ?", [parentId, id]);
    card.favorited = fav.length > 0;
    card.levelTable = levels;
    return card;
  }

  /** 家长端首页聚合（需求 4.1.2） */
  async home(parentId: number, lat: number, lng: number) {
    // 首页是高频聚合接口：各块互不依赖，统一并发取数（MySQL 连接池 40，串行改并行后 p95 明显下降）
    const [region, banners, notices, near, addr, coupons, ongoing, unread, platforms, urgent, credit] = await Promise.all([
      resolveRegion(this.ds, lat, lng),
      this.ds.query("SELECT * FROM `banners` WHERE `status` = 'on' ORDER BY `sort` LIMIT 5"),
      this.ds.query(
        "SELECT * FROM `announcements` WHERE `status` = 'on' AND (`audience` = 'all' OR `audience` = 'parent') ORDER BY `pinned` DESC, `created_at` DESC LIMIT 3",
      ),
      this.teachers(parentId, { lat, lng, pageSize: 6, online: "1" }),
      this.ds.query(
        "SELECT * FROM `addresses` WHERE `user_id` = ? ORDER BY `is_default` DESC, `id` DESC LIMIT 1",
        [parentId],
      ),
      this.ds.query("SELECT COUNT(*) AS c FROM `user_coupons` WHERE `user_id` = ? AND used = 0", [parentId]),
      this.ds.query(
        "SELECT COUNT(*) AS c FROM `orders` WHERE `parent_id` = ? AND `status` IN ('pending_class','in_class')",
        [parentId],
      ),
      this.ds.query("SELECT COUNT(*) AS c FROM `messages` WHERE `user_id` = ? AND `read` = 0", [parentId]),
      this.rules.get("platforms"),
      this.rules.get("urgent"),
      this.creditInfo(parentId),
    ]);
    const platformCfg = platforms as any;
    const urgentCfg = urgent as any;
    return {
      region: region ? { id: Number(region.id), name: region.name } : null,
      location: { lat, lng },
      banners,
      notices,
      teachers: near.list,
      couponCount: Number(coupons[0].c),
      stats: { onlineTeachers: near.total, ongoingOrders: Number(ongoing[0].c), unread: Number(unread[0].c) },
      credit,
      compliance: platformCfg.compliance_notice,
      urgentFee: urgentCfg.fee,
      // 家长可自填加急费的区间（最低 = 平台标准价，最高 = 规则上限）
      urgentMaxFee: Math.max(Number(urgentCfg.fee) || 0, Number(urgentCfg.max_fee) || (Number(urgentCfg.fee) || 0) * 10),
      urgentEnabled: urgentCfg.enabled !== false,
    };
  }

  /**
   * 游客首页（需求 4.1：未登录也能看到「发布家教需求」页）。
   * 与 home 同源同字段，但去掉一切与「我」相关的数据（地址/优惠券/订单/未读/信用），
   * 这样前端同一份渲染逻辑既能给游客看，也能登录后无缝换回个人数据。
   */
  async guestHome(lat: number, lng: number) {
    const [region, banners, notices, near, platforms, urgent] = await Promise.all([
      resolveRegion(this.ds, lat, lng),
      this.ds.query("SELECT * FROM `banners` WHERE `status` = 'on' ORDER BY `sort` LIMIT 5"),
      this.ds.query(
        "SELECT * FROM `announcements` WHERE `status` = 'on' AND (`audience` = 'all' OR `audience` = 'parent') ORDER BY `pinned` DESC, `created_at` DESC LIMIT 3",
      ),
      this.teachers(0, { lat, lng, pageSize: 6, online: "1" }),
      this.rules.get("platforms"),
      this.rules.get("urgent"),
    ]);
    const platformCfg = platforms as any;
    const urgentCfg = urgent as any;
    return {
      guest: true,
      region: region ? { id: Number(region.id), name: region.name } : null,
      location: { lat, lng },
      banners,
      notices,
      teachers: near.list,
      defaultAddress: null,
      couponCount: 0,
      stats: { onlineTeachers: near.total, ongoingOrders: 0, unread: 0 },
      credit: null,
      compliance: platformCfg.compliance_notice,
      urgentFee: urgentCfg.fee,
      urgentMaxFee: Math.max(Number(urgentCfg.fee) || 0, Number(urgentCfg.max_fee) || (Number(urgentCfg.fee) || 0) * 10),
      urgentEnabled: urgentCfg.enabled !== false,
    };
  }

  async profile(parentId: number) {
    const u = (await this.ds.query("SELECT * FROM `users` WHERE `id` = ? LIMIT 1", [parentId]))[0];
    const credit = await this.creditInfo(parentId);
    const stats = {
      orders: Number((await this.ds.query("SELECT COUNT(*) AS c FROM `orders` WHERE `parent_id` = ?", [parentId]))[0].c),
      favorites: Number((await this.ds.query("SELECT COUNT(*) AS c FROM `favorites` WHERE `user_id` = ?", [parentId]))[0].c),
      addresses: Number((await this.ds.query("SELECT COUNT(*) AS c FROM `addresses` WHERE `user_id` = ?", [parentId]))[0].c),
    };
    return {
      user: { id: Number(u.id), nickname: u.nickname, avatar: u.avatar, phone: mask(u.phone), role: u.role, realName: u.real_name },
      credit,
      creditRules: await this.rules.get("credit_rules"),
      creditLevels: await this.rules.get("parent_credit"),
      stats,
      creditLogs: await this.ds.query("SELECT * FROM `credit_logs` WHERE `user_id` = ? ORDER BY `id` DESC LIMIT 30", [parentId]),
      restricted: !!credit?.restricted,
    };
  }
}

function mask(phone?: string | null) {
  if (!phone) return "";
  return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}