/**
 * 沙箱策略域模型（policy 类型 + writableRoots 解析 + 路径判定）。
 *
 * 设计定位（设计文档 U0c / 2026-09 沙箱裁决）：
 * - 沙箱是「全执行面、可选开启、近乎零侵入」的写面强制——off 态包装层
 *   纯透传（行为零差），on 态 bash 走 Seatbelt、write/edit 走本判定。
 * - 威胁模型钉在「诚实错误」（agent 算错路径/越界写），不做对抗级打磨。
 * - 网络轴 allow-all（见 seatbeltBasePolicy NETWORK 段）。
 *
 * framework-free 纯函数（TR 纪律：domain 层零外层 import）。
 */

/** 沙箱开关态。 */
export type SandboxMode = "off" | "on";

/** 沙箱策略：mode 决定包装层透传/生效，writableRoots 为写白名单（绝对路径）。 */
export interface SandboxPolicy {
  readonly mode: SandboxMode;
  /** 写允许根（绝对、已规范化路径；含 workspace、~/.helix、系统 tmp 由 platform 段覆盖）。 */
  readonly writableRoots: readonly string[];
}

/** 解析 workspace 级开关配置载荷（<workspace>/.helix/sandbox.json）。 */
export function parseSandboxConfig(raw: unknown, workspaceRoot: string, helixHomeDir: string): SandboxPolicy {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const enabled = obj["enabled"] === true;
  return {
    mode: enabled ? "on" : "off",
    // writableRoots 第一版固定集合：workspace 根 + helix 全局数据目录（SubAgent
    // 报告等 daemon 自身数据面）。系统 /tmp 由 SEATBELT_SCRATCH_POLICY 覆盖。
    writableRoots: enabled ? normalizeRoots([workspaceRoot, helixHomeDir]) : [],
  };
}

/** 规范化 roots：去尾分隔符、去重、保序。 */
export function normalizeRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    const norm = root.endsWith("/") && root !== "/" ? root.slice(0, -1) : root;
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/** 路径段折叠（纯字符串 POSIX 归一：// / ./ ../ 折叠——防未规范化路径骗过前缀判定）。 */
export function foldPathSegments(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (abs) return `/${joined}`;
  return joined === "" ? "." : joined;
}

/** 判定绝对路径是否落在可写根内（写前 TS 判定——write/edit 工具面）。 */
export function isPathWritable(absPath: string, policy: SandboxPolicy): boolean {
  if (policy.mode !== "on") return true;
  const folded = foldPathSegments(absPath);
  for (const root of policy.writableRoots) {
    const fr = foldPathSegments(root);
    if (folded === fr || folded.startsWith(fr + "/")) return true;
  }
  return false;
}

/** 非可写路径的拒绝文案（引导改道，violation 归一的 TS 判定分支同款）。 */
export function writeDeniedMessage(absPath: string, policy: SandboxPolicy): string {
  const roots = policy.writableRoots.join("、");
  return (
    `沙箱拒绝写入：${absPath} 不在可写根（${roots}）内。` +
    `若确需该文件：① 改写 workspace 内路径；② 对项目文件优先使用 write/edit 工具（同一策略面）；` +
    `③ 该操作确属必要时可在 <workspace>/.helix/sandbox.json 关闭沙箱（enabled: false）。`
  );
}
