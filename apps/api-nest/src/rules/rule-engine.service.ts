import { Injectable } from "@nestjs/common";
import { RuleConfigService } from "./rule-config.service";

const R = 6371.0088;

/** 业务规则引擎（需求第 5 章）：计算全部取自规则配置中心，改配置即时生效 */
@Injectable()
export class RuleEngineService {
  constructor(private readonly rules: RuleConfigService) {}

  haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  distanceFactor(distanceKm: number, maxRadiusKm: number, minFactor = 0.05): number {
    if (distanceKm == null) return minFactor;
    if (distanceKm >= maxRadiusKm) return minFactor;
    return Math.max(minFactor, Number((1 - distanceKm / maxRadiusKm).toFixed(4)));
  }

  /** 5.1 推送优先级 = 距离系数 × 等级权重 × 响应速度系数 */
  async dispatchPriority(p: {
    distanceKm: number;
    levelWeight: number;
    responseFactor: number;
    urgent?: boolean;
  }): Promise<number> {
    const cfg = await this.rules.get("dispatch");
    const df = this.distanceFactor(p.distanceKm, cfg.max_radius_km, cfg.distance_factor_min);
    let v = df * p.levelWeight * (p.responseFactor || 1);
    if (p.urgent) v *= cfg.urgent_boost;
    return Number(v.toFixed(4));
  }

  async levelByScore(score: number): Promise<any> {
    const levels = await this.rules.get("teacher_levels");
    return levels.find((l: any) => score >= l.min && score <= l.max) || levels[levels.length - 1];
  }

  async creditByScore(score: number): Promise<any> {
    const levels = await this.rules.get("parent_credit");
    return levels.find((l: any) => score >= l.min && score <= l.max) || levels[0];
  }

  /** 5.4 分账：服务费 / 教员实收 / 代理分成 / 业务员提成 / 平台净收入（全整数分） */
  async calcSplit(p: {
    amount: number;
    commissionRate: number;
    feeShareRate?: number;
    mgmtRate?: number;
    salesRate?: number;
  }) {
    const apply = (c: number, r: number) => Math.round(c * r);
    const serviceFee = apply(p.amount, p.commissionRate);
    const teacherIncome = p.amount - serviceFee;
    // 服务费是「代理分成 + 业务员提成 + 平台净收入」的唯一来源：
    // 规则配置超额时按「代理 → 业务员」顺序截断，保证恒等式 serviceFee = agentShare + salesCommission + platformRevenue
    // 永远成立（历史实现用 Math.max(0, …) 会把赤字吞进平台收入，导致逐单分账不守恒）。
    const rawAgentShare = apply(serviceFee, p.feeShareRate || 0) + apply(p.amount, p.mgmtRate || 0);
    const rawSalesCommission = apply(p.amount, p.salesRate || 0);
    const agentShare = Math.max(0, Math.min(rawAgentShare, serviceFee));
    const salesCommission = Math.max(0, Math.min(rawSalesCommission, serviceFee - agentShare));
    const platformRevenue = serviceFee - agentShare - salesCommission;
    return { serviceFee, teacherIncome, agentShare, salesCommission, platformRevenue };
  }
}