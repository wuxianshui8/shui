import { Controller, Get } from "@nestjs/common";
import { RuleConfigService } from "../rules/rule-config.service";
import { Public } from "../public.decorator";

const DICTIONARY = {
  stages: ["小学", "初中", "高中", "成人", "兴趣类"],
  subjects: ["语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理", "美术", "钢琴", "吉他", "小提琴", "编程", "书法", "围棋"],
  identityTypes: [
    { value: "student", label: "在校大学生" },
    { value: "in_service", label: "在职教师" },
    { value: "part_time", label: "社会兼职教员" },
  ],
  orderStatus: [
    { value: "awaiting_payment", label: "待付款" },
    { value: "pending_class", label: "待上课" },
    { value: "in_class", label: "进行中" },
    { value: "awaiting_parent_confirm", label: "待确认完成" },
    { value: "completed", label: "已完成" },
    { value: "settled", label: "已结算" },
    { value: "cancelled", label: "已取消" },
    { value: "refunding", label: "退款中" },
    { value: "refunded", label: "已退款" },
  ],
};

const PUBLIC_KEYS = [
  "teacher_levels", "parent_credit", "credit_rules", "growth_rules", "review_scoring",
  "settlement", "agent_commission", "sales_rewards", "platforms", "dispatch", "checkin",
];

@Public()
@Controller("meta")
export class MetaController {
  constructor(private readonly rules: RuleConfigService) {}

  @Get("dictionary")
  dictionary() {
    return { code: 0, message: "ok", data: DICTIONARY };
  }

  @Get("rules-public")
  async rulesPublic() {
    const all = await this.rules.all();
    return { code: 0, message: "ok", data: all.filter((r) => PUBLIC_KEYS.includes(r.key)) };
  }
}