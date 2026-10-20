import { foldPathSegments } from "../path-fold";

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

/** 控制字符（C0 + DEL）——sbpl 字面量断行/注入的唯一入口面（解析过滤与字面量
 * 削除两处共用）。 */
export const HAS_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 绝对路径形态（POSIX `/`、win32 盘符 `C:\`/`C:/`、UNC `\\server`）——纯字符串
 *  判定（domain 不 import node:path）。 */
const IS_ABSOLUTE_PATH = /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/;

/** 解析沙箱开关配置载荷（KV sandbox_config 单键 JSON {enabled, extraRoots?}——
 * 沙箱开关批 2026-09-12 起开关存 db 单键；第一版 <home>/sandbox.json 文件开关已由
 * bootPrelude.migrateLegacySandboxConfig 一次性迁移退役；extraRoots = 用户配置的
 * 全局额外可写根（设置页「通用 → 命令沙箱」），归一后与固定集合合并）。 */
export function parseSandboxConfig(raw: unknown, workspaceRoot: string, helixHomeDir: string): SandboxPolicy {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const enabled = obj["enabled"] === true;
  const extra = Array.isArray(obj["extraRoots"])
    ? obj["extraRoots"].filter((r): r is string => typeof r === "string" && r.trim() !== "").filter(
        // 控制字符剔除（评审 F1）：root 是要拼进 sbpl 字符串字面量的——\n 等
        // 控制字符会断行/注入策略语句。合法路径不含控制字符，直接剔除且在
        // 策略面即剔除（与 profile 构建同口径：不放行 write 工具也不放行 bash）。
        (r) => !HAS_CONTROL_CHARS.test(r),
      ).filter(
        // 绝对路径闸（评审 low #71 / E-173）：相对 root 进 profile 后拼进
        // subpath 段会以沙箱进程 cwd 为基准静默解析，可写面随之漂移——
        // 非绝对一律剔除（此前只在 adapter 侧兑现）。
        (r) => IS_ABSOLUTE_PATH.test(r),
      )
    : [];
  return {
    mode: enabled ? "on" : "off",
    // writableRoots 固定集合：workspace 根 + helix 全局数据目录（SubAgent
    // 报告等 daemon 自身数据面）+ 用户额外可写根。系统 /tmp 由 SEATBELT_SCRATCH_POLICY 覆盖。
    writableRoots: enabled ? normalizeRoots([workspaceRoot, helixHomeDir, ...extra]) : [],
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

/** 路径段折叠（单源：domain/path-fold.ts——防未规范化路径骗过前缀判定）。 */
export { foldPathSegments } from "../path-fold";

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
    `③ 该操作确属必要时可在设置页「通用 → 命令沙箱」关闭沙箱后重试。`
  );
}
