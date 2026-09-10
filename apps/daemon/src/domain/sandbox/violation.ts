/**
 * 沙箱违规归一（bash 侧）——把「沙箱拒绝」从「普通命令失败」中区分出来。
 *
 * 搬运自 codex sandboxing/src/violation.rs 的关键词矩阵（stderr 匹配 +
 * 快拒退出码），文案改为 helix 引导语。write/edit 工具面的 TS 判定拒绝
 * （writeDeniedMessage）与本归一是同一策略面的两个分支。
 */

/** 沙箱拒绝的语义分类。 */
export type SandboxViolationReason =
  | "operation_not_permitted"
  | "permission_denied"
  | "read_only_filesystem"
  | "policy_denied";

/** 归一结果：是否沙箱拒绝 + 分类 + 引导文案。 */
export interface SandboxViolation {
  readonly isViolation: true;
  readonly reason: SandboxViolationReason;
  readonly message: string;
}

/** 非沙箱拒绝的哨兵结果。 */
export const NO_VIOLATION: { readonly isViolation: false } = { isViolation: false };

/** 快拒退出码：shell 误用 / 权限 / 命令不存在——这些不是沙箱拒绝（照 codex）。 */
const QUICK_REJECT_EXIT_CODES: ReadonlySet<number> = new Set([2, 126, 127]);

const VIOLATION_KEYWORDS: readonly { readonly reason: SandboxViolationReason; readonly keyword: string }[] = [
  { reason: "operation_not_permitted", keyword: "operation not permitted" },
  { reason: "permission_denied", keyword: "permission denied" },
  { reason: "read_only_filesystem", keyword: "read-only file system" },
  { reason: "policy_denied", keyword: "sandbox-exec: sandbox_apply" },
  { reason: "policy_denied", keyword: "seatbelt" },
];

/**
 * 归一 bash 执行结果：stderr 含沙箱拒绝关键词（且退出码非快拒码）→ violation。
 */
export function classifyBashOutput(
  exitCode: number | null,
  stderr: string,
): SandboxViolation | { readonly isViolation: false } {
  if (exitCode !== null && QUICK_REJECT_EXIT_CODES.has(exitCode)) return NO_VIOLATION;
  const lower = stderr.toLowerCase();
  for (const { reason, keyword } of VIOLATION_KEYWORDS) {
    if (lower.includes(keyword)) {
      return {
        isViolation: true,
        reason,
        message: violationMessage(stderr),
      };
    }
  }
  return NO_VIOLATION;
}

/** 沙箱拒绝引导文案（附原始 stderr 尾部，保诊断信息）。 */
function violationMessage(stderr: string): string {
  const tail = stderr.length > 300 ? `…${stderr.slice(-300)}` : stderr;
  return (
    `命令被 macOS 沙箱（Seatbelt）拒绝：写入目标不在可写根（workspace 与 ~/.helix）内。\n` +
    `处置：① 确认目标路径是否应为 workspace 内路径；② 项目文件写入优先使用 write/edit 工具；` +
    `③ 确需越界操作时，请用户在设置页「通用 → 命令沙箱」调整沙箱开关。\n原始输出：${tail}`
  );
}
