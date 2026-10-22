import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { config } from "./config";
import { RedisModule } from "./redis/redis.module";
import { RulesModule } from "./rules/rules.module";
import { HealthController } from "./health/health.controller";
import { MetaController } from "./meta/meta.controller";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { AuthGuard } from "./auth/auth.guard";
import { ParentController } from "./parent/parent.controller";
import { ParentService } from "./parent/parent.service";
import { AddressesController } from "./common/addresses.controller";
import { AddressesService } from "./common/addresses.service";
import { DemandsController } from "./demand/demands.controller";
import { DemandsService } from "./demand/demands.service";
import { AdminController } from "./admin/admin.controller";
import { AgentController } from "./agent/agent.controller";
import { TeacherController } from "./teacher/teacher.controller";
import { WalletController } from "./wallet/wallet.controller";
import { OrdersController } from "./order/orders.controller";
import { OrdersService } from "./order/orders.service";
import { WalletService } from "./wallet/wallet.service";
import { SalesController } from "./sales/sales.controller";
import { PayNotifyController } from "./pay/pay-notify.controller";
import { JobsService } from "./jobs/jobs.service";
import { AdminOpsController } from "./admin/admin-ops.controller";
import { AdminOpsService } from "./admin/admin-ops.service";
import { PublicController } from "./public/public.controller";
import { MessageController } from "./message/message.controller";
import { ComplaintController } from "./complaint/complaint.controller";

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "mysql",
      host: config.mysql.host,
      port: config.mysql.port,
      username: config.mysql.username,
      password: config.mysql.password,
      database: config.mysql.database,
      charset: "utf8mb4",
      synchronize: false,
      autoLoadEntities: false,
      extra: {
        decimalNumbers: true,
        // BIGINT 在安全整数范围内以 number 返回，避免 id 变字符串导致严格比较失败
        supportBigNumbers: true,
        bigNumberStrings: false,
        connectionLimit: Number(process.env.MYSQL_POOL || 40),
      },
    }),
    RedisModule,
    RulesModule,
  ],
  controllers: [
    HealthController, MetaController, AuthController,
    ParentController, AddressesController, DemandsController,
    AdminController, AgentController,
    TeacherController, WalletController, OrdersController, SalesController,
    AdminOpsController, PublicController, MessageController, ComplaintController,
    PayNotifyController,
  ],
  providers: [
    AuthService, ParentService, AddressesService, DemandsService, OrdersService, WalletService, JobsService, AdminOpsService,
    // 全局鉴权：@Public() 之外的接口都要令牌（健康检查与 meta、登录为公开）
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}