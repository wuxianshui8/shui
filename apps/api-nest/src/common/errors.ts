import { HttpException, HttpStatus } from "@nestjs/common";

export const bad = (msg = "参数错误") => new HttpException({ code: "BAD_REQUEST", message: msg }, HttpStatus.BAD_REQUEST);
export const unauthorized = (msg = "请先登录") => new HttpException({ code: "UNAUTHORIZED", message: msg }, HttpStatus.UNAUTHORIZED);
export const forbidden = (msg = "无权访问该资源") => new HttpException({ code: "FORBIDDEN", message: msg }, HttpStatus.FORBIDDEN);
export const notFound = (msg = "资源不存在") => new HttpException({ code: "NOT_FOUND", message: msg }, HttpStatus.NOT_FOUND);
export const biz = (code: string, msg: string) => new HttpException({ code, message: msg }, HttpStatus.BAD_REQUEST);
export const conflict = (msg = "操作冲突，请刷新后重试") =>
  new HttpException({ code: "CONFLICT", message: msg }, HttpStatus.CONFLICT);
/** 429：用于登录失败锁定等限流语义 */
export const tooMany = (code: string, msg: string) => new HttpException({ code, message: msg }, HttpStatus.TOO_MANY_REQUESTS);

/** 403 + 指定错误码：让前端能区分「普通无权限」与「必须先去改口令」 */
export const forbiddenWithCode = (code: string, msg: string) =>
  new HttpException({ code, message: msg }, HttpStatus.FORBIDDEN);