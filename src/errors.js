// 统一业务错误:status=HTTP 状态码,message=可展示中文信息。
export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function httpErr(status, message) {
  return new AppError(status, message);
}
