/**
 * 领域错误（domain 层通用）：非法状态迁移、非法操作等业务规则违反。
 *
 * framework-free：不 import 任何包外符号（AG-02/AG-04）。
 * 领域层用它表达「业务规则不允许」，application/adapters 捕获后转成
 * 对用户友好的提示或事件，不吞掉。
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}
