import { Global, Module } from "@nestjs/common";
import { RuleConfigService } from "./rule-config.service";
import { RuleEngineService } from "./rule-engine.service";

@Global()
@Module({
  providers: [RuleConfigService, RuleEngineService],
  exports: [RuleConfigService, RuleEngineService],
})
export class RulesModule {}