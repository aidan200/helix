/**
 * 载荷字段校验共享辅助（原 kg/task/diff 三族三份近似拷贝上收，错误码
 * 参数化——族内薄包装只钉本族错误码，调用点零改动）。
 *
 * ctx 最小结构面（type/payload/commandError——三族 context 均满足），
 * 结构化鸭子型不 import context.ts（解环同 context.ts 模式）。
 * 惯例：返回 undefined/null = 报错已回执，调用方直接 return。
 */
import type { ErrorCode } from "@helix/protocol";

/** 载荷校验最小 ctx 面（三族 CommandContext 的公共子集）。 */
export interface PayloadGuardContext {
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  readonly payload: Record<string, unknown>;
  commandError(type: string, code: ErrorCode, message: string): void;
}

/** 必填 string 字段：缺失/非 string → 报错回执 + undefined。 */
export function requirePayloadString(ctx: PayloadGuardContext, key: string, code: ErrorCode): string | undefined {
  const value = ctx.payload[key];
  if (typeof value !== "string") {
    ctx.commandError(ctx.type, code, `payload.${key} 应为 string（必填）`);
    return undefined;
  }
  return value;
}

/** 可选 string 字段：null=形状非法（已回执）；undefined=缺省透传。 */
export function optionalPayloadString(ctx: PayloadGuardContext, key: string, code: ErrorCode): string | undefined | null {
  const value = ctx.payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    ctx.commandError(ctx.type, code, `payload.${key} 应为 string`);
    return null;
  }
  return value;
}
