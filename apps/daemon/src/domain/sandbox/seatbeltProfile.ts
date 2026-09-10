/**
 * Seatbelt profile 组装（纯函数）：静态段 + writableRoots 动态段 → 完整 sbpl 文本。
 *
 * 输出交给 `/usr/bin/sandbox-exec -f <file> -- <cmd>` 执行（适配层负责落盘
 * 与 spawn，此处只产文本）。subpath 要求绝对路径——调用方传入已规范化
 * 的 roots（normalizeRoots 已去尾分隔符）。
 */

import {
  SEATBELT_BASE_POLICY,
  SEATBELT_NETWORK_ALLOW_ALL,
  SEATBELT_PLATFORM_READ_POLICY,
  SEATBELT_SCRATCH_POLICY,
} from "./seatbeltBaseProfile";
import type { SandboxPolicy } from "./SandboxPolicy";

/** sbpl 字符串字面量转义（路径含特殊字符时的安全网）。 */
function sbplLiteral(value: string): string {
  // 双引号与反斜杠转义；路径场景实际罕见，防御性处理。
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 生成完整 Seatbelt profile 文本。 */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  if (policy.mode !== "on" || policy.writableRoots.length === 0) {
    throw new Error("buildSeatbeltProfile 仅在 mode=on 且 writableRoots 非空时可用");
  }
  const dynamic = policy.writableRoots
    .map((root) => `(allow file-read* file-test-existence file-write* (subpath "${sbplLiteral(root)}"))`)
    .join("\n");
  return [
    SEATBELT_BASE_POLICY,
    SEATBELT_PLATFORM_READ_POLICY,
    SEATBELT_SCRATCH_POLICY,
    SEATBELT_NETWORK_ALLOW_ALL,
    `
; ---- helix 动态段：writableRoots（workspace / ~/.helix 等）----

${dynamic}
`,
  ].join("");
}
