import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { REDIS } from "../redis/redis.module";
import { Inject } from "@nestjs/common";
import type Redis from "ioredis";

/**
 * 规则配置中心（对应需求 4.5.4）
 * MySQL 为权威源；Redis 做一层读缓存，改配置即时失效。
 */
@Injectable()
export class RuleConfigService {
  private mem = new Map<string, { v: any; exp: number }>();
  private readonly cacheKey = "jiajiao:rules";
  private readonly memTtlMs = 300_000; // 与 Redis 缓存 TTL 对齐，避免多实例读到永久旧值

  private memSet(key: string, value: any) {
    if (this.mem.size > 500) this.mem.clear();
    this.mem.set(key, { v: value, exp: Date.now() + this.memTtlMs });
  }

  private memGet(key: string): any {
    const hit = this.mem.get(key);
    if (!hit) return undefined;
    if (hit.exp <= Date.now()) {
      this.mem.delete(key);
      return undefined;
    }
    return hit.v;
  }

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async all(): Promise<Array<{ key: string; grp: string; label: string; value: any; updated_at: string }>> {
    const rows = await this.ds.query(
      "SELECT `key`, `grp`, `label`, `value`, `updated_at` FROM `rule_configs` ORDER BY `grp`, `key`",
    );
    const list = rows.map((r: any) => ({ ...r, value: JSON.parse(r.value) }));
    // 预热缓存：与 get() 共用同一份 Redis key，避免两套读路径不一致
    for (const r of list) {
      this.memSet(r.key, r.value);
      await this.redis.set(this.cacheKey + ":" + r.key, JSON.stringify(r.value), "EX", 300);
    }
    return list;
  }

  async get<T = any>(key: string): Promise<T> {
    const cachedLocal = this.memGet(key);
    if (cachedLocal !== undefined) return cachedLocal;
    const cached = await this.redis.get(this.cacheKey + ":" + key);
    if (cached) {
      const parsed = JSON.parse(cached);
      this.memSet(key, parsed);
      await this.redis.expire(this.cacheKey + ":" + key, 300);
      return parsed;
    }
    const rows = await this.ds.query("SELECT `value` FROM `rule_configs` WHERE `key` = ?", [key]);
    if (!rows.length) return null;
    const value = JSON.parse(rows[0].value);
    this.memSet(key, value);
    await this.redis.set(this.cacheKey + ":" + key, JSON.stringify(value), "EX", 300);
    return value;
  }

  async set(key: string, value: any, actorId: number | null = null): Promise<any> {
    await this.ds.query(
      "UPDATE `rule_configs` SET `value` = ?, `updated_by` = ?, `updated_at` = ? WHERE `key` = ?",
      [JSON.stringify(value), actorId, new Date().toISOString(), key],
    );
    this.mem.delete(key);
    await this.redis.del(this.cacheKey + ":" + key);
    return value;
  }

  async invalidate(key?: string) {
    if (key) {
      this.mem.delete(key);
      await this.redis.del(this.cacheKey + ":" + key);
      return;
    }
    this.mem.clear();
    const keys = await this.redis.keys(this.cacheKey + ":*");
    if (keys.length) await this.redis.del(...keys);
  }
}