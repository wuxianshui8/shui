-- ============================================================
-- 家教上门撮合平台 · MySQL 8.0 建库脚本
-- 由 server/core/schema.sql 转换生成；类型映射见 docs/DATABASE.md §10
--   INTEGER(金额) -> BIGINT（单位：分） ｜ REAL -> DOUBLE ｜ TEXT(短) -> VARCHAR
--   *id 列统一 BIGINT UNSIGNED 以匹配外键；索引内联为 KEY
--   标识符统一反引号，规避 change / read / key 等保留字
-- 用法：mysql -u root -p jiajiao < schema.mysql.sql
-- ============================================================
SET NAMES utf8mb4;
CREATE TABLE IF NOT EXISTS `users` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `phone`           VARCHAR(191) UNIQUE,
  `username`        VARCHAR(64) UNIQUE,               -- 教员端「用户名 + 密码」登录用（可空，唯一，小写存储）
  `password_hash`   TEXT,
  `nickname`        VARCHAR(255) NOT NULL,
  `avatar`          VARCHAR(255),
  `role`            VARCHAR(255) NOT NULL,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'active',
  `real_name`       VARCHAR(255),
  `id_card`         VARCHAR(255),
  `wx_openid`       VARCHAR(255),
  `device_fp`       VARCHAR(255),
  `reg_ip`          VARCHAR(255),
  `region_id`       BIGINT UNSIGNED,
  `last_login_at`   VARCHAR(255),
  `created_at`      VARCHAR(255) NOT NULL,
  `token_version`   INT NOT NULL DEFAULT 0,           -- 改密/注销时自增，令旧令牌立即失效
  `must_change_password` TINYINT NOT NULL DEFAULT 0,  -- 后台开通的账号首次登录必须改密
  `deleted_at`      VARCHAR(255) DEFAULT NULL,        -- 软删除标记：非空=已删除（已匿名化，订单/资金台账保留）
  KEY `idx_users_role` (`role`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `regions` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `name`            VARCHAR(255) NOT NULL,
  `code`            VARCHAR(191) NOT NULL UNIQUE,
  `center_lat`      DOUBLE NOT NULL,
  `center_lng`      DOUBLE NOT NULL,
  `radius_km`       DOUBLE NOT NULL DEFAULT 6,
  `polygon`         TEXT,
  `admin_codes`     TEXT,                              -- JSON 数组：按行政区设置的 adcode（多边形 = 这些边界的并集）
  `created_at`      VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `addresses` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`         BIGINT UNSIGNED NOT NULL REFERENCES users(id),
  `label`           VARCHAR(255) NOT NULL,
  `contact`         VARCHAR(255) NOT NULL,
  `phone`           VARCHAR(191) NOT NULL,
  `region_id`       BIGINT UNSIGNED,
  `address`         TEXT NOT NULL,
  `lat`             DOUBLE NOT NULL,
  `lng`             DOUBLE NOT NULL,
  `is_default`      INT NOT NULL DEFAULT 0,
  `created_at`      VARCHAR(255) NOT NULL,
  KEY `idx_addr_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `parent_profiles` (
  `user_id`         BIGINT UNSIGNED PRIMARY KEY REFERENCES users(id),
  `credit_score`    INT NOT NULL DEFAULT 100,
  `credit_level`    VARCHAR(255) NOT NULL DEFAULT 'L0',
  `completed_orders` INT NOT NULL DEFAULT 0,
  `cancel_count`    INT NOT NULL DEFAULT 0,
  `last_month_bonus` VARCHAR(255),
  `restricted`      INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `teacher_profiles` (
  `user_id`         BIGINT UNSIGNED PRIMARY KEY REFERENCES users(id),
  `identity_type`   VARCHAR(255) NOT NULL,
  `real_name`       VARCHAR(255),
  `id_card`         VARCHAR(255),
  `edu_cert_url`    TEXT,
  `teacher_cert_url` TEXT,
  `skill_cert_url`  TEXT,
  -- 身份证正反面（上传后的图片地址）+ 识别结果：id_card_name/id_card_no_ocr 来自证件识别，
  -- id_card_verified=1 表示识别出的姓名与身份证号都和用户填写的一致（不一致会在提交时被拒）
  `id_card_front_url` TEXT,
  `id_card_back_url`  TEXT,
  `id_card_name`      VARCHAR(255),
  `id_card_verified`  INT NOT NULL DEFAULT 0,
  `intro`           TEXT,
  `subjects`        TEXT,
  `stages`          TEXT,
  `hourly_price`    BIGINT NOT NULL DEFAULT 0,
  `service_radius_km` DOUBLE NOT NULL DEFAULT 5,
  `base_lat`        DOUBLE,
  `base_lng`        DOUBLE,
  `schedule`        TEXT,
  `cover_area`      TEXT,
  `base_address`    TEXT,                               -- 教员授课地址（家长「到教员处上课」时的实际上课地点，P65）
  `audit_status`    VARCHAR(255) NOT NULL DEFAULT 'pending',
  `reject_reason`   TEXT,
  `online`          INT NOT NULL DEFAULT 0,
  `growth_score`    INT NOT NULL DEFAULT 0,
  `level`           VARCHAR(255) NOT NULL DEFAULT 'Lv1',
  `rating_avg`      DOUBLE NOT NULL DEFAULT 0,
  `rating_count`    INT NOT NULL DEFAULT 0,
  `completed_lessons` INT NOT NULL DEFAULT 0,
  `response_factor` DOUBLE NOT NULL DEFAULT 1.0,
  `frozen`          BIGINT NOT NULL DEFAULT 0,
  `created_at`      VARCHAR(255) NOT NULL,
  `updated_at`      VARCHAR(255),
  KEY `idx_tp_audit` (`audit_status`, `online`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `teacher_services` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `teacher_id`      BIGINT UNSIGNED NOT NULL REFERENCES users(id),
  `title`           TEXT NOT NULL,
  `subjects`        TEXT NOT NULL,
  `stages`          TEXT NOT NULL,
  `price`           BIGINT NOT NULL,
  `cover_radius_km` DOUBLE NOT NULL DEFAULT 5,
  `schedule`        TEXT,
  `description`     TEXT,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'on',
  `places`          VARCHAR(64) NOT NULL DEFAULT 'home',   -- 支持的授课形式（逗号分隔）：home=上门 / teacher_place=教员家（P67）
  `created_at`      VARCHAR(255) NOT NULL,
  `updated_at`      VARCHAR(255),
  KEY `idx_svc_teacher` (`teacher_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `demands` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `parent_id`       BIGINT UNSIGNED NOT NULL REFERENCES users(id),
  `stage`           VARCHAR(255) NOT NULL,
  `subject`         VARCHAR(255) NOT NULL,
  `mode`            VARCHAR(255) NOT NULL DEFAULT 'home',  -- home=教员上门（默认）| teacher_place=家长到教员处上课（P65）
  `address_id`      BIGINT UNSIGNED,
  `address`         TEXT NOT NULL,
  `lat`             DOUBLE NOT NULL,
  `lng`             DOUBLE NOT NULL,
  `region_id`       BIGINT UNSIGNED NOT NULL,
  `times`           TEXT,
  `budget`          BIGINT NOT NULL,
  `remark`          TEXT,
  `gender_pref`     VARCHAR(255),
  `urgent`          INT NOT NULL DEFAULT 0,
  `urgent_fee`      BIGINT NOT NULL DEFAULT 0,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'published',
  `confirm_app_id`  BIGINT UNSIGNED,
  `created_at`      VARCHAR(255) NOT NULL,
  `updated_at`      VARCHAR(255),
  KEY `idx_demand_status` (`status`, `region_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `applications` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `demand_id`       BIGINT UNSIGNED NOT NULL REFERENCES demands(id),
  `teacher_id`      BIGINT UNSIGNED NOT NULL REFERENCES users(id),
  `status`          VARCHAR(255) NOT NULL DEFAULT 'pending',
  `priority`        DOUBLE NOT NULL DEFAULT 0,
  `distance_km`     DOUBLE,
  `created_at`      VARCHAR(255) NOT NULL,
  UNIQUE KEY `uk_applications_demand_id_teacher_id` (`demand_id`, `teacher_id`),
  KEY `idx_app_demand` (`demand_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `orders` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_no`        VARCHAR(191) NOT NULL UNIQUE,
  `parent_id`       BIGINT UNSIGNED NOT NULL REFERENCES users(id),
  `teacher_id`      BIGINT UNSIGNED NOT NULL REFERENCES users(id),
  `demand_id`       BIGINT UNSIGNED,
  `service_id`      BIGINT UNSIGNED,
  `subject`         VARCHAR(255) NOT NULL,
  `stage`           VARCHAR(255) NOT NULL,
  `lesson_time`     VARCHAR(255) NOT NULL,
  `lesson_end`      VARCHAR(255),
  `address`         TEXT NOT NULL,
  `place`           VARCHAR(32) NOT NULL DEFAULT 'home',   -- 授课地点：home=教员上门 / teacher_place=家长到教员处（P65）
  `lat`             DOUBLE NOT NULL,
  `lng`             DOUBLE NOT NULL,
  `region_id`       BIGINT UNSIGNED NOT NULL,
  `sales_id`        BIGINT UNSIGNED,
  `agent_id`        BIGINT UNSIGNED,
  `amount`          BIGINT NOT NULL,
  `urgent_fee`      BIGINT NOT NULL DEFAULT 0,
  `status`          VARCHAR(255) NOT NULL,
  `commission_rate` DOUBLE NOT NULL DEFAULT 0.18,
  `service_fee`     BIGINT NOT NULL DEFAULT 0,
  `teacher_income`  BIGINT NOT NULL DEFAULT 0,
  `agent_share`     BIGINT NOT NULL DEFAULT 0,
  `sales_commission` INT NOT NULL DEFAULT 0,
  `platform_revenue` BIGINT NOT NULL DEFAULT 0,
  `paid_at`         VARCHAR(255),
  `checkin_at`      VARCHAR(255),
  `checkin_lat`     DOUBLE,
  `checkin_lng`     DOUBLE,
  `checkin_distance` INT,
  `parent_checkin_at`       VARCHAR(255),               -- 家长到场打卡时间（P66：仅「到教员处上课」）
  `parent_checkin_lat`      DOUBLE,
  `parent_checkin_lng`      DOUBLE,
  `parent_checkin_distance` INT,
  `finished_at`     VARCHAR(255),
  `confirm_at`      VARCHAR(255),
  `settle_at`       VARCHAR(255),
  `remind_sent`     INT NOT NULL DEFAULT 0,
  `cancel_by`       VARCHAR(255),
  `cancel_reason`   TEXT,
  `cancel_requested_at` VARCHAR(255),               -- 家长申请取消的时间（教员端同意/驳回后清空）
  `cancel_rejected_at`  VARCHAR(255),               -- 教员最近一次驳回取消的时间
  `cancel_reject_reason` TEXT,                      -- 教员驳回理由（回给家长）
  `penalty`         INT NOT NULL DEFAULT 0,
  `refund_amount`   BIGINT NOT NULL DEFAULT 0,
  `remark`          TEXT,
  `created_at`      VARCHAR(255) NOT NULL,
  `updated_at`      VARCHAR(255),
  KEY `idx_order_parent` (`parent_id`, `status`),
  KEY `idx_order_teacher` (`teacher_id`, `status`),
  KEY `idx_order_region` (`region_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `payments` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_id`        BIGINT UNSIGNED,
  `user_id`         BIGINT UNSIGNED NOT NULL,
  `type`            VARCHAR(255) NOT NULL,
  `amount`          BIGINT NOT NULL,
  `channel`         VARCHAR(255) NOT NULL DEFAULT 'wechat',
  `trade_no`        VARCHAR(191) NOT NULL UNIQUE,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'success',
  `idem_key`        VARCHAR(191) UNIQUE,
  `created_at`      VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `escrow_ledger` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_id`        BIGINT UNSIGNED,
  `direction`       VARCHAR(255) NOT NULL,
  `amount`          BIGINT NOT NULL,
  `balance`         BIGINT NOT NULL,
  `remark`          TEXT,
  `created_at`      VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `wallets` (
  `user_id`         BIGINT UNSIGNED PRIMARY KEY REFERENCES users(id),
  `balance`         BIGINT NOT NULL DEFAULT 0,
  `frozen`          BIGINT NOT NULL DEFAULT 0,
  `total_income`    BIGINT NOT NULL DEFAULT 0,
  `total_withdraw`  BIGINT NOT NULL DEFAULT 0,
  `updated_at`      VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `wallet_txns` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`         BIGINT UNSIGNED NOT NULL,
  `order_id`        BIGINT UNSIGNED,
  `type`            VARCHAR(255) NOT NULL,
  `amount`          BIGINT NOT NULL,
  `balance_after`   BIGINT NOT NULL DEFAULT 0,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'done',
  `remark`          TEXT,
  `created_at`      VARCHAR(255) NOT NULL,
  KEY `idx_txn_user` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `withdrawals` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`         BIGINT UNSIGNED NOT NULL,
  `role`            VARCHAR(255) NOT NULL,
  `amount`          BIGINT NOT NULL,
  `fee`             BIGINT NOT NULL DEFAULT 0,
  `actual`          INT NOT NULL DEFAULT 0,
  `channel`         VARCHAR(255) NOT NULL,
  `account`         VARCHAR(255) NOT NULL,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'pending',
  `reject_reason`   TEXT,
  `reviewed_by`     INT,
  `reviewed_at`     VARCHAR(255),
  `idem_key`        VARCHAR(191) UNIQUE,
  `created_at`      VARCHAR(255) NOT NULL,
  KEY `idx_wd_user` (`user_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `reviews` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_id`        BIGINT UNSIGNED NOT NULL UNIQUE REFERENCES orders(id),
  `parent_id`       BIGINT UNSIGNED NOT NULL,
  `teacher_id`      BIGINT UNSIGNED NOT NULL,
  `score`           INT NOT NULL,
  `content`         TEXT,
  `tags`            TEXT,
  `weight`          DOUBLE NOT NULL DEFAULT 1.0,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'public',
  `appeal_status`   VARCHAR(255) NOT NULL DEFAULT 'none',
  `appeal_reason`   TEXT,
  `appeal_result`   TEXT,
  `created_at`      VARCHAR(255) NOT NULL,
  KEY `idx_review_teacher` (`teacher_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `growth_logs` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `teacher_id`      BIGINT UNSIGNED NOT NULL,
  `change`          INT NOT NULL,
  `reason`          TEXT NOT NULL,
  `balance_after`   BIGINT NOT NULL,
  `order_id`        BIGINT UNSIGNED,
  `created_at`      VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `credit_logs` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`         BIGINT UNSIGNED NOT NULL,
  `change`          INT NOT NULL,
  `reason`          TEXT NOT NULL,
  `balance_after`   BIGINT NOT NULL,
  `order_id`        BIGINT UNSIGNED,
  `created_at`      VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `level_logs` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `teacher_id`      BIGINT UNSIGNED NOT NULL,
  `from_level`      VARCHAR(255) NOT NULL,
  `to_level`        VARCHAR(255) NOT NULL,
  `reason`          TEXT,
  `created_at`      VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `sales_profiles` (
  `user_id`         BIGINT UNSIGNED PRIMARY KEY REFERENCES users(id),
  `agent_id`        BIGINT UNSIGNED NOT NULL,
  `region_id`       BIGINT UNSIGNED NOT NULL,
  `code`            VARCHAR(191) NOT NULL UNIQUE,
  `joined_at`       VARCHAR(255) NOT NULL,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'active'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `agent_profiles` (
  `user_id`         BIGINT UNSIGNED PRIMARY KEY REFERENCES users(id),
  `region_id`       BIGINT UNSIGNED NOT NULL,
  `level`           VARCHAR(255) NOT NULL DEFAULT 'A',
  `signed_at`       VARCHAR(255) NOT NULL,
  `deposit`         BIGINT NOT NULL DEFAULT 0,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'active',
  `commission_rate` DOUBLE NOT NULL DEFAULT 0.25,
  `mgmt_rate`       DOUBLE NOT NULL DEFAULT 0.01
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `bindings` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`         BIGINT UNSIGNED NOT NULL UNIQUE,
  `sales_id`        BIGINT UNSIGNED,
  `agent_id`        BIGINT UNSIGNED,
  `region_id`       BIGINT UNSIGNED,
  `source`          VARCHAR(255) NOT NULL,
  `bound_at`        VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `promotion_codes` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `sales_id`        BIGINT UNSIGNED NOT NULL,
  `target`          VARCHAR(255) NOT NULL,
  `token`           VARCHAR(191) NOT NULL UNIQUE,
  `scans`           INT NOT NULL DEFAULT 0,
  `registrations`   INT NOT NULL DEFAULT 0,
  `created_at`      VARCHAR(255) NOT NULL,
  UNIQUE KEY `uk_promotion_codes_sales_id_target` (`sales_id`, `target`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `rewards` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `sales_id`        BIGINT UNSIGNED NOT NULL,
  `type`            VARCHAR(255) NOT NULL,
  `amount`          BIGINT NOT NULL,
  `ref_order_id`    BIGINT UNSIGNED,
  `ref_user_id`     BIGINT UNSIGNED,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'pending',
  `calc_note`       TEXT,
  `settle_at`       VARCHAR(255),
  `created_at`      VARCHAR(255) NOT NULL,
  KEY `idx_reward_sales` (`sales_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `complaints` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_id`        BIGINT UNSIGNED,
  `from_user`       INT NOT NULL,
  `from_role`       VARCHAR(255) NOT NULL,
  `against_user`    INT,
  `region_id`       BIGINT UNSIGNED,
  `type`            VARCHAR(255) NOT NULL,
  `title`           TEXT NOT NULL,
  `content`         TEXT,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'open',
  `handler_id`      BIGINT UNSIGNED,
  `handle_note`     TEXT,
  `created_at`      VARCHAR(255) NOT NULL,
  `resolved_at`     VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `risk_events` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_id`        BIGINT UNSIGNED,
  `user_id`         BIGINT UNSIGNED,
  `region_id`       BIGINT UNSIGNED,
  `type`            VARCHAR(255) NOT NULL,
  `level`           VARCHAR(255) NOT NULL DEFAULT 'mid',
  `reason`          TEXT,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'open',
  `settlement_hold` BIGINT NOT NULL DEFAULT 0,
  `handled_by`      INT,
  `created_at`      VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `rule_configs` (
  `key`             VARCHAR(191) PRIMARY KEY,
  `grp`             VARCHAR(255) NOT NULL,
  `label`           VARCHAR(255) NOT NULL,
  `value`           TEXT NOT NULL,
  `editable`        INT NOT NULL DEFAULT 1,
  `updated_by`      INT,
  `updated_at`      VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `banners` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `title`           TEXT NOT NULL,
  `image`           VARCHAR(255),
  `link`            VARCHAR(255),
  `sort`            INT NOT NULL DEFAULT 0,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'on',
  `created_at`      VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `announcements` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `title`           TEXT NOT NULL,
  `content`         TEXT,
  `audience`        VARCHAR(255) NOT NULL DEFAULT 'all',
  `pinned`          INT NOT NULL DEFAULT 0,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'on',
  `created_at`      VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `coupons` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `name`            VARCHAR(255) NOT NULL,
  `amount`          BIGINT NOT NULL,
  `threshold`       BIGINT NOT NULL DEFAULT 0,
  `total`           BIGINT NOT NULL DEFAULT 0,
  `claimed`         INT NOT NULL DEFAULT 0,
  `valid_from`      VARCHAR(255),
  `valid_to`        VARCHAR(255),
  `status`          VARCHAR(255) NOT NULL DEFAULT 'on',
  `created_at`      VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `user_coupons` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`         BIGINT UNSIGNED NOT NULL,
  `coupon_id`       BIGINT UNSIGNED NOT NULL,
  `used`            INT NOT NULL DEFAULT 0,
  `order_id`        BIGINT UNSIGNED,
  `claimed_at`      VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `messages` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`         BIGINT UNSIGNED NOT NULL,
  `title`           TEXT NOT NULL,
  `content`         TEXT,
  `type`            VARCHAR(255) NOT NULL DEFAULT 'system',
  `read`            INT NOT NULL DEFAULT 0,
  `link`            VARCHAR(255),
  `created_at`      VARCHAR(255) NOT NULL,
  KEY `idx_msg_user` (`user_id`, `read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `agreements` (
  `key`             VARCHAR(191) PRIMARY KEY,
  `title`           TEXT NOT NULL,
  `content`         TEXT NOT NULL,
  `updated_at`      VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `actor_id`        BIGINT UNSIGNED,
  `actor_role`      VARCHAR(255),
  `action`          VARCHAR(255) NOT NULL,
  `target`          VARCHAR(255),
  `detail`          TEXT,
  `ip`              VARCHAR(255),
  `created_at`      VARCHAR(255) NOT NULL,
  KEY `idx_audit_actor` (`actor_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `idempotency` (
  `key`             VARCHAR(191) PRIMARY KEY,
  `scope`           VARCHAR(255) NOT NULL,
  `response`        TEXT,
  `created_at`      VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `favorites` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`         BIGINT UNSIGNED NOT NULL,
  `teacher_id`      BIGINT UNSIGNED NOT NULL,
  `created_at`      VARCHAR(255) NOT NULL,
  UNIQUE KEY `uk_favorites_user_id_teacher_id` (`user_id`, `teacher_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `agent_deposits` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `agent_id`        BIGINT UNSIGNED NOT NULL,
  `direction`       VARCHAR(255) NOT NULL,
  `amount`          BIGINT NOT NULL,
  `balance`         BIGINT NOT NULL DEFAULT 0,
  `remark`          TEXT,
  `operator`        INT,
  `created_at`      VARCHAR(255) NOT NULL,
  KEY `idx_deposit_agent` (`agent_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `invoices` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `invoice_no`      VARCHAR(191) NOT NULL UNIQUE,
  `order_id`        BIGINT UNSIGNED NOT NULL,
  `user_id`         BIGINT UNSIGNED NOT NULL,
  `title_type`      VARCHAR(255) NOT NULL DEFAULT 'personal',
  `title`           TEXT NOT NULL,
  `tax_no`          VARCHAR(255),
  `email`           VARCHAR(255),
  `amount`          BIGINT NOT NULL,
  `status`          VARCHAR(255) NOT NULL DEFAULT 'pending',
  `reject_reason`   TEXT,
  `invoice_url`     VARCHAR(255),
  `handled_by`      INT,
  `handled_at`      VARCHAR(255),
  `created_at`      VARCHAR(255) NOT NULL,
  KEY `idx_invoice_user` (`user_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- invoices：同一订单仅允许一张有效申请（驳回后可重申请），用生成列 + 唯一索引等价实现
ALTER TABLE `invoices`
  ADD COLUMN `active_order_id` BIGINT AS (IF(`status` <> 'rejected', `order_id`, NULL)) STORED,
  ADD UNIQUE KEY `uk_invoice_active_order` (`active_order_id`);
