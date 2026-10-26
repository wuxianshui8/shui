import { Global, Module, OnModuleDestroy, Inject } from "@nestjs/common";
import Redis from "ioredis";
import { config } from "../config";

export const REDIS = "REDIS_CLIENT";

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () =>
        new Redis({
          host: config.redis.host,
          port: config.redis.port,
          db: config.redis.db,
          // 生产环境 redis 设了 requirepass（compose 强制）；本地/门禁不设则不传，避免 AUTH 报错
          ...(config.redis.password ? { password: config.redis.password } : {}),
          lazyConnect: false,
          maxRetriesPerRequest: 2,
          retryStrategy: (times) => Math.min(times * 200, 2000),
        }),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch {
      /* ignore */
    }
  }
}