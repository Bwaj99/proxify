export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }

  /** Business-rule rejections worth an audit trail (policy, funds, ownership, state). */
  get auditable(): boolean {
    return this.status === 402 || this.status === 403 || this.status === 409;
  }
}

export const badRequest = (msg: string, code = "BAD_REQUEST", details?: Record<string, unknown>) =>
  new AppError(400, code, msg, details);
export const unauthorized = (msg: string, code = "UNAUTHORIZED") => new AppError(401, code, msg);
export const forbidden = (msg: string, code = "FORBIDDEN", details?: Record<string, unknown>) =>
  new AppError(403, code, msg, details);
export const notFound = (msg: string, code = "NOT_FOUND") => new AppError(404, code, msg);
export const conflict = (msg: string, code = "CONFLICT", details?: Record<string, unknown>) =>
  new AppError(409, code, msg, details);
