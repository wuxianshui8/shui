# 接口文档

- 基础地址：`http://localhost:4173`
- 统一响应：`{ "code": 0, "message": "ok", "data": {...} }`；错误时 `code` 为业务码（如 `BAD_STATUS`）、`message` 为可直接展示的中文文案，HTTP 状态码同步（400/401/403/404/409/500）。
- 鉴权：除标注「公开」外，均需请求头 `Authorization: Bearer <token>`。
- 角色白名单：`roles` 不匹配返回 `403`；未登录/Token 失效返回 `401`。
- 幂等：资金类接口支持 `X-Idem-Key`，重复键回放上次响应。
- 金额：**全部为「分」(整数)**，例如 `20000` 表示 ¥200.00。

---

## 一、认证与公共

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 公开 | **健康检查**：`{status,version,uptime,db:{ok,users,orders,escrow,latencyMs}}`，DB 不可用时 503 |

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/auth/send-code` | 公开 | `{phone}` → `{devCode,ttl}` 开发环境回传验证码 |
| POST | `/api/auth/login` | 公开 | `{phone,code,inviteToken?}` → `{token,user}`，新号自动注册为家长；验证码连续错误达阈值后 429 |
| POST | `/api/auth/login-password` | 公开 | `{phone,password}` → `{token,user}`；连续失败达阈值后 429 |
| POST | `/api/auth/wechat` | 公开 | `{code}` 微信一键登录（演示按 openid 建档） |
| GET | `/api/auth/me` | 登录 | 当前用户 + 家长信用/教员档案摘要 |
| POST | `/api/auth/logout` | 登录 | 退出 |
| POST | `/api/auth/realname` | 登录 | `{realName,idCard}` 实名认证 |
| POST | `/api/auth/password` | 登录 | `{password}` 修改口令 |
| POST | `/api/auth/change-password` | 登录 | `{oldPassword,newPassword}` 自助改口令：校验旧口令 + 新口令 ≥8 位且含字母与数字 + 不得与原口令相同 → `{token,mustChangePassword:false}`；与正式实现 `POST /api/auth/change-password` 同契约 |
| POST | `/api/auth/deactivate` | 登录 | **注销账号**（需求第 8 章）：清除手机号/微信/姓名/身份证等身份信息，撤销在招需求与上架服务；有未完结订单或冻结资金时拒绝 |
| GET | `/api/meta/dictionary` | 公开 | 学段/科目/身份/订单状态/奖励类型字典 |
| GET | `/api/meta/rules-public` | 公开 | 可公开的规则（等级表、信用表、结算规则等） |
| GET | `/api/public/agreements` | 公开 | **协议列表**（P75）：`[{key,title,updatedAt}]`，顺序 user / privacy / refund；游客可读 |
| GET | `/api/public/agreements/:key` | 公开 | **协议正文**（P75）：`{key,title,content,updatedAt}`；未知 key → 404 |
| GET | `/api/public/banners` | 公开 | 首页 Banner |
| GET | `/api/public/announcements?audience=` | 公开 | 平台公告 |
| GET | `/api/public/coupons` | 公开 | 可领优惠券 |
| POST | `/api/public/promo/:token/scan` | 公开 | 推广码扫码计数 |
| GET | `/api/metrics` | 本机/令牌 | **Prometheus 文本指标**（P74）：默认只允许 127.0.0.1 抓取，跨机需配 `METRICS_TOKEN` 带 `?token=` 或 `Authorization: Bearer`。指标：`jiajiao_up`/`uptime_seconds`/`db_up`/`cache_up`/`orders{status}`/`escrow_yuan_total`/`risk_events_open`/`complaints_open`/`refunds_pending`/`withdrawals_pending`/`backup_last_success_timestamp` |

---

## 二、家长端

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/parent/home` | 首页聚合：片区、坐标、Banner、公告、附近在线教员、默认地址、未领券数、统计、信用信息、合规提示、加急费 |
| GET | `/api/parent/teachers` | 教员广场。query：`subject,stage,level,priceMin,priceMax,radiusKm,sort(priority|distance|price|rating),online,lat,lng,page,pageSize` |
| GET | `/api/parent/teachers/:id` | 教员详情：资质/科目/价格/覆盖/服务列表/评价/评分分布/等级权益表/是否收藏 |
| GET | `/api/parent/orders?status=` | `awaiting`(待接单) / `pending`(待上课/进行中) / `completed` / `cancelled` |
| GET | `/api/parent/profile` | 个人中心：信用等级、信用分、评价权重、规则、统计、信用流水 |
| POST | `/api/demands` | 发布需求 `{stage,subject,mode,address,lat,lng,budget,remark,urgent,times[],genderPref,addressId}`；`mode`=`home`（教员上门，默认）/`teacher_place`（家长到教员处） |
| GET | `/api/demands/mine` | 我的需求列表（含报名数） |
| GET | `/api/demands/:id` | 需求详情 + 报名教员列表 |
| PUT | `/api/demands/:id` | 编辑需求（仅未确认） |
| POST | `/api/demands/:id/action` | `{action:'pause'\|'resume'\|'revoke'}` 暂停/恢复/撤销 |
| POST | `/api/demands/:id/confirm` | `{applicationId}` 确认某位报名教员 → 生成订单（并发安全） |
| POST | `/api/orders/from-service` | 选购服务直接下单 `{serviceId,lessonTime,addressId,place,remark,couponId}`；`place`=`home`（默认）/`teacher_place`——后者**不需要 addressId**，订单上课地点自动取教员授课地址，教员未填则 400 `TEACHER_ADDRESS_REQUIRED` |

### 通用（登录用户）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/addresses` | 地址列表 / 新增（需 `lat,lng`） |
| PUT/DELETE | `/api/addresses/:id` | 编辑 / 删除 |
| POST | `/api/addresses/:id/default` | 设为默认 |
| GET | `/api/messages` | `{list,unread}` |
| POST | `/api/messages/:id/read`、`/api/messages/read-all` | 已读 |
| GET | `/api/my/coupons` | 我的优惠券 |
| POST | `/api/coupons/:id/claim` | 领取优惠券 |
| GET | `/api/parent/coupons` | **我的优惠券（Nest 侧，P71）**：`{list:[{id,couponId,name,amount,threshold,used,orderId,claimedAt,validFrom,validTo}], usable}` |
| POST | `/api/parent/coupons/:id/claim` | **领券（Nest 侧，P71）**：`coupons` 行锁防超发；已领 → 400 `COUPON_CLAIMED`、领完 → 400 `COUPON_EMPTY`；下单传 `couponId` 抵扣 |
| GET | `/api/my/favorites` | 收藏的教员 |
| POST | `/api/my/favorites/:teacherId` | 收藏 / 取消收藏（切换） |
| POST | `/api/complaints` | 发起客诉 `{orderId,title,content,againstUser}` |
| GET | `/api/my/complaints` | 我的客诉 |
| POST | `/api/upload` | `{filename,dataUrl}` base64 上传 → `{url}` |

---

## 三、教员端

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/teacher/apply` | 入驻提交 `{realName,idCard,identityType,subjects,stages,hourlyPrice,serviceRadiusKm,lat,lng,baseAddress,schedule,coverArea,intro,eduCertUrl,teacherCertUrl,skillCertUrl}` |
| GET | `/api/teacher/profile` | `{applied, profile}`（含脱敏身份证、驳回原因、授课地址 `baseAddress`） |
| PUT | `/api/teacher/profile` | 修改授课设置（含 `baseAddress`：教员授课地址，传空串表示关闭「家长到教员处上课」；P65） |
| POST | `/api/teacher/online` | `{online:true\|false}` 上线/下线（需审核通过） |
| GET | `/api/teacher/dashboard` | 接单首页：在线状态、今日单量/收入、评分、等级、下一等级、服务状态、待处理数、钱包、公告 |
| GET | `/api/teacher/nearby-demands` | 附近订单（按派单优先级排序，含距离/加急/已报名状态） |
| POST | `/api/demands/:id/apply` | 抢单报名（唯一索引防重复，返回优先级与距离） |
| GET | `/api/teacher/orders?status=` | `awaiting`(待确认) / `pending`(待上门/上课中) / `completed` / `cancelled` |
| GET/POST | `/api/teacher/services` | 服务列表 / 新增 `{title,subjects,stages,price,coverRadiusKm,description,places}`；`places` = 该服务支持的授课形式（`home` 上门 / `teacher_place` 在教员家，可多选），返回值为数组 + `placesText` |
| PUT/DELETE | `/api/teacher/services/:id` | 编辑（含 `places`）/ 删除 |
| POST | `/api/teacher/services/:id/toggle` | 上架 / 下架 |
| GET | `/api/teacher/level` | 等级权益：当前等级、成长分、进度、抽佣、派单权重、等级表、成长流水、等级变更记录 |
| GET | `/api/teacher/income` | 收入：钱包、本月收入、累计服务费、冻结订单、流水、结算规则 |
| GET | `/api/teacher/calendar?month=YYYY-MM` | 排课日历（已确认课程 + 可授课时间表） |
| GET | `/api/teacher/reviews` | 评价管理（含待处理申诉） |
| POST | `/api/teacher/reviews/:id/appeal` | `{reason}` 差评申诉 |
| GET | `/api/teacher/profile-page` | 个人中心聚合 |

---

## 四、订单生命周期

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/orders/:id` | 相关方/运营 | 订单详情（按角色返回状态文案与脱敏） |
| POST | `/api/orders/:id/pay` | 家长 | 担保支付（幂等，可带 `X-Idem-Key`）。**两种返回形态**：① mock 通道（`PAY_PROVIDER=mock`）→ 直接入账并返回**订单视图**（无 `mode` 字段，进入 `pending_class` 并生成分账）；② 真实通道（微信支付 v3）→ 返回 `{mode:"prepay", orderId, amount, prepayId, params}`，`params={appId,timeStamp,nonceStr,package,signType,paySign}` 交前端唤起收银台（小程序 `uni.requestPayment` / 微信内 H5 `WeixinJSBridge.getBrandWCPayRequest`），支付结果由 `/api/pay/wechat/notify` 回调确认。已支付订单再次调用幂等返回订单视图 |
| POST | `/api/orders/:id/checkin` | 教员 / 家长 | `{lat,lng}` 到场打卡，超出阈值（规则 `checkin.max_distance_m`，默认 500m）拦截并写风控事件。`place=home`：仅教员打卡，打完即 `in_class`；`place=teacher_place`：**双方各打一次卡**（家长证明带孩子到了教学点、教员确认在此开课），都到齐才 `in_class`，家长打卡会记 `parent_checkin_*`；`home` 订单家长打卡返回 400 `NOT_TEACHER_PLACE`，同一方重复打卡 400 `ALREADY_CHECKED_IN` |
| POST | `/api/orders/:id/finish` | 教员 | 结束授课 → `awaiting_parent_confirm` |
| POST | `/api/orders/:id/confirm` | 家长 | 确认完成 → `completed`，课时费进入冻结 |
| POST | `/api/orders/:id/cancel` | 家长/教员/管理员 | `{reason}` 取消（按时间窗计算违约金与信用扣分） |
| POST | `/api/orders/:id/refund` | 家长 | `{reason}` 申请退款 → `refunding` + 投诉工单 |
| POST | `/api/orders/:id/sos` | 家长/教员 | **紧急求助**（上门安全）：`{lat?,lng?,note?}` → 生成 high 级风控工单，通知全体管理员、片区代理与订单另一方；同单 10 分钟内重复触发只建 1 单 |
| POST | `/api/orders/:id/review` | 家长 | `{score(1-5),content,tags[]}` 评价 → 影响成长分与评分 |
| POST | `/api/admin/settlement/run` | 管理员 | `{force?:true}` 触发结算批处理 |
| POST | `/api/admin/reminders/run` | 管理员 | 立即执行上课前提醒推送（阈值取规则 `notify.lesson_remind_minutes`） |

**订单状态机**
```
awaiting_payment ──pay──> pending_class ──checkin──> in_class ──finish──> awaiting_parent_confirm
       │                        │                                                    │
       │                        └──refund──> refunding ──approve──> refunded          │
       │                        └──cancel──> cancelled / refunded                    │
       └──cancel──> cancelled                                                        │
                                                    confirm ──────────────────────────┘
                                                        ↓
                                                   completed ──T+N 结算──> settled
```

---

## 五、钱包与提现

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/wallet` | `{wallet:{balance,frozen,totalIncome,totalWithdraw}, rule, txns[], invoices[], invoiceable[]}`（发票申请单与可开票订单随该接口返回） |
| POST | `/api/invoices` | **家长申请开票**：`{orderId,titleType:'personal'\|'company',title,taxNo,email}`，同一订单只允许一张有效申请，驳回后可重提 |
| GET | `/api/wallet/txns?type=` | 资金流水 |
| GET | `/api/withdrawals` | 提现记录 + 钱包 + 规则 |
| POST | `/api/withdrawals` | `{amount,channel,account}` 申请提现（幂等，需 `X-Idem-Key`） |

---

## 六、业务员端

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/sales/dashboard` | 推广码（家长/教员分流）、今日/本周/本月业绩、待结算/已发放奖励、7 日趋势、奖励规则 |
| GET | `/api/sales/customers` | 客户列表（手机号脱敏）+ 状态汇总 |
| GET | `/api/sales/rewards?type=` | 奖励明细 + 按类型汇总 + 计算规则 |
| GET | `/api/sales/profile` | 账号、片区、推广码、钱包 |

---

## 七、区域代理端

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agent/dashboard` | 片区大盘：核心指标、7 日趋势、供需网格、钱包、公告、风险概览 |
| GET | `/api/agent/sales?keyword=&status=` | 业务员列表（脱敏）+ 团队汇总 |
| POST | `/api/agent/sales` | `{nickname,phone}` 新增业务员（返回初始密码） |
| POST | `/api/agent/sales/:id/toggle` | 启用 / 停用 |
| GET | `/api/agent/sales/:id` | 业务员明细（客户数、奖励、订单） |
| GET | `/api/agent/orders?status=&from=&to=` | 片区订单（地址脱敏） |
| GET | `/api/agent/orders/export` | 导出 CSV（需 Bearer Token） |
| GET | `/api/agent/earnings` | 收益：累计/待结算/已结算、收益构成、6 期账单、结算规则 |
| GET | `/api/agent/complaints` | 片区投诉工单 |
| POST | `/api/agent/complaints/:id/handle` | `{action:'handled'\|'escalate'\|'close', note}` |
| GET | `/api/agent/risks` | 风控：事件列表、统计、风险指数、高频取消名单 |
| POST | `/api/agent/risks/:id/escalate` | 上报平台复核（冻结结算） |
| GET | `/api/agent/announcements`、`/api/agent/profile` | 公告 / 账号信息 |

---

## 八、平台管理后台

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/overview` | 数据总览（指标、角色分布、区域排行、供需、14 日趋势、待办） |
| GET | `/api/admin/users?role=&status=&keyword=&page=&pageSize=` | 全量用户（`{list,total,page,pageSize,pages}`，默认每页 300） |
| POST | `/api/admin/users/:id/toggle` | `{reason}` 启用 / 禁用 |
| GET | `/api/admin/teachers/pending` | 待审核 / 被驳回教员（证件、脱敏身份信息） |
| POST | `/api/admin/teachers/:id/audit` | `{approve,reason}` 审核通过 / 驳回 |
| POST | `/api/admin/teachers/:id/level` | `{level,note}` 人工调级 |
| GET | `/api/admin/orders?status=&regionId=&keyword=&page=&pageSize=` | 全平台订单（分页同上） |
| GET | `/api/admin/orders/export?status=&regionId=&keyword=` | **导出订单 CSV**（含片区、分账五项金额、中文状态，最多 5000 行） |
| POST | `/api/admin/orders/:id/price` | `{amount,note}` 人工改价（仅未支付） |
| POST | `/api/admin/orders/:id/close` | `{reason}` 关闭订单 |
| GET | `/api/admin/demands?page=&pageSize=` | 需求池（分页） |
| GET | `/api/admin/refunds` | 退款工单 |
| POST | `/api/admin/refunds/:id/review` | `{approve,reason}` 退款审核 |
| GET | `/api/admin/rules` | 规则配置（按分组） |
| PUT | `/api/admin/rules/:key` | `{value}` 修改规则（立即热生效） |
| GET/POST | `/api/admin/regions` | 片区列表 / 新建（含电子围栏 polygon） |
| GET/POST | `/api/admin/agents` | 代理列表 / 签约新建 |
| GET | `/api/admin/agents/:id` | **代理详情**：档案 + 保证金台账 + 考核完成度 |
| PUT | `/api/admin/agents/:id` | **编辑代理**：片区 / 等级 / 服务费分成 / 管理提成 |
| POST | `/api/admin/agents/:id/toggle` | **启用 / 禁用代理**（禁用后代理端接口全部 403） |
| POST | `/api/admin/agents/:id/deposit` | **保证金台账**：`{direction:'in'\|'out',amount,remark}`，退还不可超过余额 |
| POST | `/api/admin/applications/expire` | **清理超时未确认的教员报名**（阈值取 `dispatch.grab_confirm_timeout_hours`） |
| GET | `/api/admin/finance` | 财务总览、提现、奖励、**发票受理列表**、担保台账、支付流水、对账 |
| POST | `/api/admin/withdrawals/:id/review` | `{approve,reason}` 提现审核打款 |
| POST | `/api/admin/invoices/:id/review` | **后台财务受理发票**：`{approve:true, invoiceUrl?}` 开票 / `{approve:false, rejectReason}` 驳回，均通知家长 |
| POST | `/api/admin/rewards/settle` | 业务员奖励批量结算 |
| GET | `/api/admin/risks` | `{events, appeals, complaints}` |
| POST | `/api/admin/risks/:id/handle` | `{action:'close'\|'hold'\|'release'\|'punish', note}` |
| POST | `/api/admin/appeals/:id/arbitrate` | `{accept,reason}` 差评申诉仲裁 |
| POST | `/api/admin/complaints/:id/close` | `{note}` 投诉终审 |
| GET | `/api/admin/complaints` | **投诉工单列表**（P72）：`?status=open|processing|replied|closed&type=&orderId=&page=&pageSize=` → `{list,total,openCount}`，含投诉人（手机号脱敏）/关联单号/片区/处理说明 |
| POST | `/api/admin/complaints/:id/handle` | **受理 / 回复工单**（P72）：`{status:'processing'\|'replied', note}`；`closed` 只能走上面的 `close`（避免绕过审计） |
| GET | `/api/admin/banners` | Banner 列表 |
| POST | `/api/admin/banners` | 新建 Banner `{title,image,link,sort,status}` |
| PUT | `/api/admin/banners/:id` | **编辑 Banner**（字段局部更新，`status` 仅 `on`/`off`） |
| POST | `/api/admin/banners/:id/toggle` | **上架 / 停用 Banner** |
| DELETE | `/api/admin/banners/:id` | 删除 Banner |
| GET | `/api/admin/announcements` | 公告列表 |
| POST | `/api/admin/announcements` | 新建公告 `{title,content,audience,pinned,push,status}` |
| PUT | `/api/admin/announcements/:id` | **编辑公告**（含接收人群、置顶、状态；`push:true` 时重新推送） |
| POST | `/api/admin/announcements/:id/toggle` | **上线 / 下线公告** |
| POST | `/api/admin/announcements/:id/pin` | **置顶 / 取消置顶** |
| DELETE | `/api/admin/announcements/:id` | 删除公告 |
| GET | `/api/admin/coupons` | 优惠券列表 |
| POST | `/api/admin/coupons` | 新建优惠券 `{name,amount,threshold,total,validFrom,validTo,status}` |
| PUT | `/api/admin/coupons/:id` | **编辑优惠券**（发行总量不得小于已领取数） |
| POST | `/api/admin/coupons/:id/toggle` | **启用 / 停用优惠券**（停用后家长端领券列表不再出现） |
| GET | `/api/admin/agreements` | **协议文案列表**（P75，带正文）：`[{key,title,content,updatedAt}]` |
| PUT | `/api/admin/agreements/:key` | **保存协议文案**（P75）：`{title?,content}`；正文少于 10 字 → 400、标题空 → 400、未知 key → 404；改动写审计日志 `admin.agreement.update` |
| GET | `/api/admin/audit-logs?page=&pageSize=` | 操作日志（分页） |
| GET / POST | `/api/admin/admins` | 管理员账号（列表已过滤软删除；新建时 `password` 可省，默认 `DEMO_PASSWORD`） |
| DELETE | `/api/admin/admins/:id` | **删除管理员**：有审计/提现审批/发票受理痕迹 → 软删除并匿名化（返回 `{mode:"soft",kept:[...]}`）；零痕迹 → 物理删除（`{mode:"hard"}`）。护栏：不能删自己（403）、至少保留一个启用管理员（`LAST_ADMIN`）、重复删除 404 |

---

## 九、错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | 未登录 / Token 失效 |
| `FORBIDDEN` | 403 | 角色或数据范围不允许 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `CONFLICT` | 409 | 并发冲突（如需求已被确认） |
| `BAD_REQUEST` | 400 | 参数错误 |
| `BAD_STATUS` | 400 | 当前状态不允许该操作 |
| `BAD_CODE` / `CODE_EXPIRED` | 400 | 验证码错误 / 过期 |
| `BAD_CREDENTIALS` | 400 | 账号或密码错误 |
| `ALREADY_APPLIED` | 400 | 已报名该需求 |
| `TOO_FAR` | 400 | 超出服务半径 |
| `CHECKIN_TOO_FAR` | 400 | 打卡定位超出阈值 |
| `TIME_CONFLICT` | 400 | 教员该时段已有课程 |
| `LOGIN_LOCKED` | 429 | 登录失败次数超阈值，已临时锁定（阈值见规则 `risk.login_fail_limit`） |
| `INSUFFICIENT_BALANCE` | 400 | 余额不足 |
| `BELOW_MIN` | 400 | 低于最低提现额 |
| `ALREADY_REVIEWED` / `REVIEW_EXPIRED` | 400 | 已评价 / 评价超时 |
| `ALREADY_INVOICED` / `NOT_INVOICEABLE` / `NOT_PAID` | 400 | 该订单已申请开票 / 状态不支持开票 / 未支付 |
| `NOT_APPROVED` / `OFFLINE` | 400 | 教员未通过审核 / 未上线 |
| `OUT_OF_SERVICE` | 400 | 地址不在服务片区 |