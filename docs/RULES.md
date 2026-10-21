# 业务规则引擎说明（需求说明书第 5 章）

所有规则的**数值**都存放在 `rule_configs` 表（规则配置中心），后台修改后立即生效，不重启、不改代码。
实现位置：`server/core/rules.js`（计算）、`server/core/config.js`（读写与缓存）、`server/core/defaults.js`（默认值）。

---

## 1. 派单匹配规则（5.1）

配置键 `dispatch`：

```json
{ "max_radius_km": 5, "push_batch": 5, "grab_confirm_timeout_hours": 24,
  "distance_factor_min": 0.05, "urgent_boost": 1.3 }
```

**推送优先级 = 距离系数 × 教员等级权重 × 响应速度系数**（加急订单再 × `urgent_boost`）

```
距离系数 distance_factor = max(0.05, 1 − 实际距离 / max_radius_km)
```

| 项 | 取值 |
| --- | --- |
| 距离系数 | 0.05 ~~ 1.00（越近越高） |
| 等级权重 | 从 `teacher_levels` 取该教员等级的 `weight`（0.6 / 1.0 / 1.4 / 1.8 / 2.2） |
| 响应速度系数 | `teacher_profiles.response_factor`（默认 1.0，由历史响应速度维护） |

示例：距离 1 km、Lv4（权重 1.8）、响应系数 1.02 → `0.8 × 1.8 × 1.02 = 1.469`
同样距离下 Lv1（0.6）只有 `0.49`，即等级带来的曝光差距接近 3 倍。

- 推送范围：`teacher_profiles.service_radius_km` 与 `max_radius_km` 取小值；
- 先到先得：唯一索引 + `INSERT OR IGNORE` 保证同一教员不重复报名；
- 家长确认后其余报名自动置为 `rejected`；
- **抢单超时（已落地执行）**：教员报名后超过 `grab_confirm_timeout_hours`（默认 24 小时）家长仍未确认，
  服务端每分钟执行一次 `expireApplications()`，把该报名置为 `expired` 并通知双方；
  失效报名不可再被确认（确认接口返回 400）。也可由后台「订单与需求 → 需求池 → 清理超时报名」手动触发，
  或调用 `POST /api/admin/applications/expire`。

---

## 2. 教员等级成长规则（5.2）

配置键 `teacher_levels`：

| 等级 | 名称 | 成长分区间 | 平台抽佣 | 派单权重 |
| --- | --- | --- | --- | --- |
| Lv1 | 见习教员 | 0 – 200 | 18% | 0.6 |
| Lv2 | 普通教员 | 201 – 600 | 15% | 1.0 |
| Lv3 | 优选教员 | 601 – 1200 | 12% | 1.4 |
| Lv4 | 金牌教员 | 1201 – 2000 | 9% | 1.8 |
| Lv5 | 名师 | 2001+ | 6% | 2.2 |

配置键 `growth_rules`：

```json
{ "per_lesson": 2, "good_review_base": 5, "bad_review_base": 5,
  "violation": { "no_show": -50, "fake_checkin": -100, "private_deal": -200 },
  "private_deal_ban": true }
```

**成长分 = 有效课时数 × 2 + Σ(加权好评分) − Σ(加权差评分) − 违规扣分**

- 有效课时：家长确认完成一单 `+2`；
- 加权评分：`score ≥ 4` 加 `5 × 家长评价权重`；`score ≤ 2` 减 `5 × 家长评价权重`；`score = 3` 不加不减；
- 违规扣分：爽约 `−50`、虚假打卡 `−100`、引导私单 `−200` 并自动封禁；
- **自动升降级**：每次成长分变动后按区间重新定级，变更写入 `level_logs`；低于当前等级下限即降级。

示例：家长 L2（权重 1.3）给出 5 星 → 教员成长分 `+round(5 × 1.3) = +7`（另有完成课时的 +2）。

---

## 3. 家长信用等级规则（5.3）

配置键 `parent_credit`：

| 等级 | 名称 | 信用分区间 | 评价权重 |
| --- | --- | --- | --- |
| L0 | 新用户 | 0 – 100 | 0.6 |
| L1 | 普通家长 | 101 – 250 | 1.0 |
| L2 | 优质家长 | 251 – 450 | 1.3 |
| L3 | 高信用家长 | 451+ | 1.6 |

配置键 `credit_rules`：

```json
{ "order_completed": 3, "review_given": 2, "monthly_no_cancel": 5,
  "cancel_within_4h": -8, "no_show": -12, "malicious_review": -15, "restrict_below": 0 }
```

- 完成订单 `+3`、主动评价 `+2`、无取消记录月度 `+5`；
- 课前 4 小时内取消 `−8`、爽约不上课 `−12`、恶意差评 `−15`；
- 信用分 ≤ `restrict_below`(0) 进入限制名单：禁止发布加急需求（`parent_profiles.restricted`）。

**评价权重如何影响教员**：差评扣分基数 5 分乘以该家长的权重 —— L0 家长的差评只扣 3 分，L3 家长的差评扣 8 分，实现「高信用家长话语权更大」。

---

## 4. 分佣与结算规则（5.4）

配置键 `settlement` / `agent_commission` / `sales_rewards`：

```json
settlement:      { "freeze_days": 7, "min_withdraw": 10000, "withdraw_fee_rate": 0.006,
                   "free_cancel_hours": 4, "cancel_penalty_rate": 0.2 }
agent_commission:{ "fee_share_rate": 0.25, "mgmt_rate": 0.01, "settle_period": "monthly", "bill_day": 5 }
sales_rewards:   { "register": 1000, "lead": 500, "newbie_first": 3000,
                   "daily_champ": 5000, "weekly_champ": 20000,
                   "deal_tiers": [ { "min": 0, "max": 500000, "rate": 0.02 },
                                   { "min": 500001, "max": 2000000, "rate": 0.03 },
                                   { "min": 2000001, "max": null, "rate": 0.04 } ] }
```

### 4.1 资金流向

```
家长支付 → 平台担保账户 (escrow_ledger: in)
   ↓ 家长确认完成（订单 completed）
教员课时费进入「冻结中」(wallets.frozen)，settle_at = 确认时间 + freeze_days
   ↓ T+7 到期（定时任务 / 后台手动结算）
escrow_ledger: out → 教员可用余额、代理分成余额、平台净收入
```

### 4.2 分账公式（`calcSplit()`）

```
平台服务费   service_fee      = round(实付 × 教员等级抽佣比例)
教员实收     teacher_income   = 实付 − 平台服务费
代理收益     agent_share      = round(服务费 × 服务费分成比例) + round(实付 × 管理提成比例)
业务员提成   sales_commission = round(实付 × 阶梯提成比例)
平台净收入   platform_revenue = 服务费 − 代理收益 − 业务员提成
```

**恒等式（测试逐单校验）**
1. `实付 = 教员实收 + 平台服务费`
2. `平台服务费 = 代理分成 + 业务员提成 + 平台净收入`

示例（实付 ¥200.00，教员 Lv3 抽佣 12%，代理分成 25% + 管理提成 1%，业务员阶梯 2%）：

| 项目 | 计算 | 金额 |
| --- | --- | --- |
| 实付 | — | ¥200.00 |
| 平台服务费 | 20000 × 12% | ¥24.00 |
| 教员实收 | 20000 − 2400 | ¥176.00 |
| 代理分成 | 2400 × 25% + 20000 × 1% | ¥6.00 + ¥2.00 = ¥8.00 |
| 业务员提成 | 20000 × 2% | ¥4.00 |
| 平台净收入 | 24 − 8 − 4 | ¥12.00 |

校验：`176 + 24 = 200` ✓；`8 + 4 + 12 = 24` ✓

### 4.3 结算周期
| 对象 | 周期 | 实现 |
| --- | --- | --- |
| 业务员奖励 | 周结 | `rewards` 状态 `pending → settled`，后台「批量结算」或周任务执行后入钱包 |
| 教员收入 | T+7 冻结后可提现 | `wallets.frozen` → `settled` 后转可用余额 |
| 代理分成 | 月结，次月 5 日出账单 | 订单结算时即时入账，月度账单页按 `bill_day` 汇总 |

### 4.4 提现
- 最低提现额 `min_withdraw`（默认 ¥100），手续费 `withdraw_fee_rate`（0.6%）；
- 流程：申请（扣减可用余额，状态 `pending`）→ 平台审核（`paid` / `rejected`）；
- 驳回自动退回余额并写 `wallet_txns(type='withdraw_refund')`；
- 带 `X-Idem-Key` 幂等，防止重复扣款。

### 4.5 取消与退款
| 场景 | 处理 |
| --- | --- |
| `awaiting_payment` 取消 | 直接关闭，无资金流动 |
| 课前 > `free_cancel_hours`（4 小时）取消 | 全额退款，担保台账 out |
| 课前 ≤ 4 小时取消 | 扣 `cancel_penalty_rate`（20%）违约金，违约金赔付给教员，余款退回；家长信用 `−8` |
| 教员爽约/拒单 | 全额退款 + 教员成长分 `−50` |
| 课程进行中 | 不可直接取消，转客诉/退款工单由平台仲裁 |
| 家长申请退款 | 订单转 `refunding` 并生成投诉工单 → 平台审批 → `refunded` |

---

## 5. 区域归属判定（5.5）

| 用户来源 | 归属规则 | 实现 |
| --- | --- | --- |
| 扫码注册 | 归属推广业务员 → 归属其片区代理 | `bindUser()` 写入 `bindings(source='scan')`，用户 `region_id` 同步 |
| 自然注册 | 按首次发布订单的上课地址定位归属片区 | `resolveRegion(lat,lng)` 先做点在多边形判定，再退化为中心点半径判定 |
| 跨区订单 | 收益归属**需求发布地址**所在片区代理 | 订单 `region_id` 取 `demands.region_id` 而非教员所属片区 |

片区电子围栏存于 `regions.polygon`（JSON 顶点数组），后台可为每个片区配置矩形或多边形围栏。

---

## 6. 风控规则

配置键 `risk`：

```json
{ "high_cancel_count": 3, "brush_same_device": 2, "checkin_fail_block": true }
```

| 事件类型 | 触发条件 | 处理 |
| --- | --- | --- |
| `abnormal_location` | 打卡距离 > 阈值 | 拦截打卡 + 写风控事件（>3 倍阈值判 high） |
| `fake_checkin` | 连续多单打卡坐标异常 | 人工复核，扣 100 成长分，可封禁 |
| `brush` | 同设备/同 IP 批量注册下单 | 冻结结算 + 可封禁账号 |
| `high_cancel` | 同一家长取消次数 ≥ 阈值 | 进入代理端高风险名单 |
| `sos` | 家长或教员在订单内点击「紧急求助」 | 生成 high 级工单，通知全体管理员 + 片区代理 + 订单另一方，后台/代理端风控列表优先展示，处置后关闭 |

`risk_events.settlement_hold = 1` 时，结算批处理会**跳过**该订单，直到后台解除冻结。

---

## 7. 反作弊规则（需求第 8 章）

配置键 `risk`：

```json
{ "high_cancel_count": 3, "brush_same_device": 2, "checkin_fail_block": true,
  "register_per_device_day": 2, "register_per_ip_hour": 20, "order_per_parent_day": 10,
  "login_fail_limit": 5, "login_lock_minutes": 15 }
```

| 场景 | 判定 | 处理 |
| --- | --- | --- |
| 批量注册（同设备） | 同一 `device_fp` 24 小时内已注册账号数 ≥ `register_per_device_day` | **拦截注册**（400 `FREQUENT_REGISTER`）+ 写 `risk_events(type='brush', level='high')` |
| 批量注册（同 IP） | 同一注册 IP 1 小时内已注册账号数 ≥ `register_per_ip_hour` | 同上 |
| 刷单刷量 | 同一家长 24 小时内下单数 ≥ `order_per_parent_day` | 下单照常放行但写入 `risk_events(type='brush')` 并置 `settlement_hold=1`，该订单结算被冻结，待平台人工复核 |
| 暴力破解登录 | 同一「IP + 账号」连续失败 ≥ `login_fail_limit` | 返回 `429 LOGIN_LOCKED`，锁定 `login_lock_minutes` 分钟；成功登录即清零 |

设备指纹通过注册接口的 `X-Device-Fp` 请求头（或 body 中的 `deviceFp`）传入，注册时记录到 `users.device_fp`；
注册 IP 记录在 `users.reg_ip`。两者都可在后台「风控与审核 → 异常订单」中查看与处理。

---

## 8. 评价规则

配置键 `review_scoring`：

```json
{ "lesson_points": 2, "good_base": 5, "bad_base": 5, "good_threshold": 4, "bad_threshold": 2,
  "window_hours": 72,
  "positive_tags": ["准时","耐心","专业","讲解清晰","提分明显","有责任心"],
  "negative_tags": ["迟到","敷衍","讲不清","频繁改时间","态度差"] }
```

- 触发时机：订单 `completed` 后，`window_hours`（72 小时）内可评价，超时拒绝；
- 一单一评（`reviews.order_id` 唯一索引）；
- 教员评分均值按**评价权重加权**：`Σ(score × weight) / Σ(weight)`；
- 教员可对差评申诉（`appeal_status='pending'`）→ 平台仲裁：
  - 撤销：评价置 `hidden`，回滚成长分，评分计数 −1；
  - 维持：仅记录仲裁结果。

---

## 8. 规则配置项清单（15 组）

| key | 分组 | 说明 |
| --- | --- | --- |
| `dispatch` | 派单规则 | 最大接单半径、推送批次、抢单超时、距离系数下限、加急加权 |
| `checkin` | 派单规则 | 上门打卡定位阈值（米） |
| `urgent` | 派单规则 | 加急费金额、是否启用 |
| `teacher_levels` | 教员等级规则 | 等级名称、成长分区间、抽佣比例、派单权重 |
| `growth_rules` | 教员等级规则 | 课时加分、好评/差评基数、违规扣分、引导私单封禁 |
| `parent_credit` | 家长信用规则 | 信用等级区间与评价权重 |
| `credit_rules` | 家长信用规则 | 信用加减分项与限制门槛 |
| `review_scoring` | 评价计分规则 | 评价基数、好差评阈值、时效、预设标签 |
| `sales_rewards` | 业务员奖励方案 | 注册奖、留资奖、新人首单奖、日/周冠军奖、阶梯提成 |
| `agent_commission` | 代理分成规则 | 服务费分成比例、管理提成比例、账单日 |
| `settlement` | 结算规则 | 冻结天数、最低提现额、手续费率、免费取消时长、违约金比例 |
| `risk` | 风控规则 | 高频取消阈值、刷单阈值、打卡拦截开关、注册与下单频次 |
| `agent_assessment` | 代理分成规则 | 代理考核指标：月度 GMV / 订单量 / 活跃业务员目标与达标线 |
| `notify` | 通知规则 | 上课提醒提前分钟数（默认 60）、是否启用、打卡提醒、确认催办间隔 |
| `platforms` | 基础参数 | 平台名称、城市、合规提示、担保说明 |

修改方式：后台「规则配置中心」→ `PUT /api/admin/rules/:key`，写入 `audit_logs` 并可追溯。