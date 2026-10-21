import { SetMetadata } from "@nestjs/common";
export const ROLES_KEY = "roles";
/** 角色白名单（不匹配返回 403），对应需求 2.1 / 2.2 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/**
 * 细粒度权限点（需求 4.5.9「角色权限分配」）。
 * 语义：命中 @Perm 的接口，最终以规则 `permissions`（权限点 → 角色列表）为准，
 * 因此这类接口需要同时放开 @Roles，由权限矩阵决定「哪些角色真的能用」。
 * 默认矩阵只给 admin（与历史行为一致）；后台可在「规则配置中心 → permissions」里授予代理/业务员。
 */
export const PERM_KEY = "perm:key";
export const Perm = (...keys: string[]) => SetMetadata(PERM_KEY, keys);

/** 全部权限点（与 seed 默认矩阵、后台页面、check-permissions 用例保持一致） */
export const PERMISSION_KEYS = [
  "order.price",
  "order.close",
  "refund.review",
  "withdraw.review",
] as const;
