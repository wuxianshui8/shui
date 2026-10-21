// Redis 分布式锁（需求 6.2）：SET NX PX 抢占 + Lua 校验持有者后释放
// 设计取舍：抢锁采用「有限自旋等待」而非立即失败——抢单是并发热点，立即失败会让正常报名误报失败；
// 自旋超时后降级为「无锁执行」，仍由数据库唯一索引兜底，保证不重复接单。
import { randomUUID } from "node:crypto";
import type Redis from "ioredis";

const RELEASE_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export async function acquireLock(redis: Redis, key: string, ttlMs = 3000, waitMs = 2000): Promise<{ token: string | null; waited: number }> {
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  let waited = 0;
  while (Date.now() < deadline) {
    const ok = await redis.set(key, token, "PX", ttlMs, "NX");
    if (ok) return { token, waited };
    await new Promise((r) => setTimeout(r, 10));
    waited += 10;
  }
  return { token: null, waited };
}

export async function releaseLock(redis: Redis, key: string, token: string) {
  try {
    await redis.eval(RELEASE_LUA, 1, key, token);
  } catch {
    /* 释放失败由 TTL 兜底，不影响业务结果 */
  }
}

/** 临界区执行：抢到锁走锁内，抢不到降级执行（由唯一索引兜底） */
export async function withLock<T>(redis: Redis, key: string, fn: () => Promise<T>, ttlMs = 3000): Promise<{ value: T; locked: boolean; waited: number }> {
  const { token, waited } = await acquireLock(redis, key, ttlMs);
  try {
    const value = await fn();
    return { value, locked: !!token, waited };
  } finally {
    if (token) await releaseLock(redis, key, token);
  }
}
