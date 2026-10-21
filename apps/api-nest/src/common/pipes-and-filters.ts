import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";

/**
 * 统一错误响应：{ code, message, data }，与既有前端契约保持一致
 * 安全约束：任何未预期异常（含数据库驱动的转换/约束错误）一律折叠为 400，
 * 且不把底层异常信息回显给客户端——避免通过畸形入参探测 SQL 结构（见 security.test §3）。
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    let status = HttpStatus.BAD_REQUEST;
    let code = "BAD_REQUEST";
    let message = "请求参数不合法或数据格式错误";
    let data: unknown = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as any;
      if (typeof body === "string") {
        message = body;
      } else if (body && typeof body === "object") {
        message = body.message || message;
        code = body.code || (status === 400 ? "BAD_REQUEST" : status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : "ERROR");
        data = body.data ?? null;
      }
    } else {
      // eslint-disable-next-line no-console
      console.error("[unhandled]", exception instanceof Error ? exception.stack || exception.message : exception);
    }
    res.status(status).json({ code, message, data });
  }
}
