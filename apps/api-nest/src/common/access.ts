import { SetMetadata } from "@nestjs/common";
export const ROLES_KEY = "roles";
/** 角色白名单（不匹配返回 403），对应需求 2.1 / 2.2 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);