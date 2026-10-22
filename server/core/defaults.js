// 规则配置中心默认值（后台可改，无需改代码）
export const DEFAULT_RULES = {
  dispatch: {
    grp: "派单规则",
    label: "派单匹配规则",
    value: {
      max_radius_km: 5,
      push_batch: 5,
      grab_confirm_timeout_hours: 24,
      distance_factor_min: 0.05,
      urgent_boost: 1.3,
    },
  },
  teacher_levels: {
    grp: "教员等级规则",
    label: "等级 / 抽佣 / 派单权重",
    value: [
      { level: "Lv1", name: "见习教员", min: 0, max: 200, commission: 0.18, weight: 0.6 },
      { level: "Lv2", name: "普通教员", min: 201, max: 600, commission: 0.15, weight: 1.0 },
      { level: "Lv3", name: "优选教员", min: 601, max: 1200, commission: 0.12, weight: 1.4 },
      { level: "Lv4", name: "金牌教员", min: 1201, max: 2000, commission: 0.09, weight: 1.8 },
      { level: "Lv5", name: "名师", min: 2001, max: 9999999, commission: 0.06, weight: 2.2 },
    ],
  },
  parent_credit: {
    grp: "家长信用规则",
    label: "信用等级 / 评价权重",
    value: [
      { level: "L0", name: "新用户", min: 0, max: 100, weight: 0.6 },
      { level: "L1", name: "普通家长", min: 101, max: 250, weight: 1.0 },
      { level: "L2", name: "优质家长", min: 251, max: 450, weight: 1.3 },
      { level: "L3", name: "高信用家长", min: 451, max: 9999999, weight: 1.6 },
    ],
  },
  credit_rules: {
    grp: "家长信用规则",
    label: "信用加减分项",
    value: {
      order_completed: 3,
      review_given: 2,
      monthly_no_cancel: 5,
      cancel_within_4h: -8,
      no_show: -12,
      malicious_review: -15,
      restrict_below: 0,
    },
  },
  growth_rules: {
    grp: "教员等级规则",
    label: "成长分加减项",
    value: {
      per_lesson: 2,
      good_review_base: 5,
      bad_review_base: 5,
      violation: { no_show: -50, fake_checkin: -100, private_deal: -200 },
      private_deal_ban: true,
    },
  },
  review_scoring: {
    grp: "评价计分规则",
    label: "评价计分 / 标签 / 时效",
    value: {
      lesson_points: 2,
      good_base: 5,
      bad_base: 5,
      good_threshold: 4,
      bad_threshold: 2,
      window_hours: 72,
      positive_tags: ["准时", "耐心", "专业", "讲解清晰", "提分明显", "有责任心"],
      negative_tags: ["迟到", "敷衍", "讲不清", "频繁改时间", "态度差"],
    },
  },
  sales_rewards: {
    grp: "业务员奖励方案",
    label: "注册奖 / 留资奖 / 阶梯提成 / 日周奖",
    value: {
      register: 1000,
      lead: 500,
      newbie_first: 3000,
      daily_champ: 5000,
      weekly_champ: 20000,
      deal_tiers: [
        { min: 0, max: 500000, rate: 0.02 },
        { min: 500001, max: 2000000, rate: 0.03 },
        { min: 2000001, max: null, rate: 0.04 },
      ],
      settle_period: "weekly",
    },
  },
  agent_commission: {
    grp: "代理分成规则",
    label: "服务费分成 / 管理提成",
    value: { fee_share_rate: 0.25, mgmt_rate: 0.01, settle_period: "monthly", bill_day: 5 },
  },
  settlement: {
    grp: "结算规则",
    label: "冻结天数 / 提现额度 / 手续费",
    value: {
      freeze_days: 7,
      min_withdraw: 10000,
      withdraw_fee_rate: 0.006,
      free_cancel_hours: 4,
      cancel_penalty_rate: 0.2,
    },
  },
  checkin: {
    grp: "派单规则",
    label: "上门打卡定位阈值",
    value: { max_distance_m: 500 },
  },
  urgent: {
    grp: "派单规则",
    label: "加急费配置",
    value: { fee: 2000, enabled: true },
  },
  risk: {
    grp: "风控规则",
    label: "风控阈值（高频取消 / 批量注册 / 刷单）",
    value: {
      high_cancel_count: 3,
      brush_same_device: 2,
      checkin_fail_block: true,
      register_per_device_day: 2,
      register_per_ip_hour: 20,
      order_per_parent_day: 10,
      login_fail_limit: 5,
      login_lock_minutes: 15,
    },
  },
  notify: {
    grp: "通知规则",
    label: "消息提醒策略",
    value: {
      enabled: true,
      lesson_remind_minutes: 60,
      remind_on_checkin: true,
      remind_confirm_days: 3,
    },
  },
  agent_assessment: {
    grp: "代理分成规则",
    label: "代理考核指标",
    value: {
      monthly_gmv_target: 1000000,
      monthly_orders_target: 30,
      active_sales_target: 4,
      pass_score: 80,
    },
  },
  platforms: {
    grp: "基础参数",
    label: "平台基础参数",
    value: {
      name: "家教上门撮合平台",
      city: "杭州",
      compliance_notice: "平台仅提供家教信息撮合服务，教员资质由平台人工核验",
      service_fee_note: "资金由平台担保账户托管，课程确认完成后 T+7 结算",
    },
  },

  // 运营字典：家长发单、教员服务与市场筛选的下拉选项（后台「运营工具 → 学段 / 科目」可维护）
  // 说明：这里只决定「新库首次灌种子」的默认值；已在跑的库以数据库中 `rule_configs.catalog` 为准。
  catalog: {
    grp: "运营字典",
    label: "学段 / 科目（发单与筛选项）",
    value: {
      stages: ["小学", "初中", "高中", "成人", "兴趣类"],
      subjects: [
        "语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理",
        "美术", "钢琴", "吉他", "小提琴", "编程", "书法", "围棋",
      ],
    },
  },
};

export const DEMO_PASSWORD = "a123456";