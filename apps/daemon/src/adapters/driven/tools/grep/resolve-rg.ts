/**
 * rg 路径二级解析单点（AD-2/F3.1，architecture §4.4）——framework-free
 * 纯函数：零 env/fs 直接依赖，全部环境面由入参注入（可单测）。
 *
 * 固定二级顺序：① 包内 bundle（壳经 env HELIX_RG_PATH 注入，由装配层
 * 读出后传入；dev 形态由 dev-desktop 注入同路径仓内二进制）→ ② 用户
 * 配置（config.json rgPath，经 paths.ts/config.ts 读出后传入）。
 *
 * 不设 PATH 探测级（历史第③级已砍）：分发形态只有安装包（bundle 必在）
 * 与开发者 dev（dev-desktop 注入），PATH 上的 rg 版本不可控（--json 输出
 * 细节随版本漂移），与「pin 版本 + sha256」的确定性目标相悖。
 *
 * 决策消解（T1.1 brief）：
 * - 任何输入组合均不 throw；二级全缺返回 `unavailable` 且 reasons 逐条
 *   记录哪级为何缺失（供启动日志），降级信号不抛裸错。
 * - 某级值非空但 probe 失败 = 该级缺失（记 reason），继续下一级，不作废
 *   整体解析；probe 自身抛错同样只视为该候选不可用。
 * - 本模块是全仓唯一 rg 路径解析点（R1：禁止散落 spawn("rg") 裸名直撞
 *   PATH 或各自拼资源路径）；消费点在装配层一次性调用（AF-1 语义），
 *   后端定格编排见 freeze-backend.ts / GrepTool 门面（T1.3）。
 */

/** 解析入参（全注入，零环境直读）。 */
export interface RgResolutionInput {
  /** ① 壳 env HELIX_RG_PATH 注入值（由装配层读出后传入）。 */
  readonly bundlePath?: string;
  /** ② config.json rgPath（经 paths.ts/config.ts 读出后传入）。 */
  readonly configPath?: string;
  /**
   * 存在且可执行探测（注入，可单测）。缺省 = 无法验证可用性，
   * 任何候选均不命中（保守降级，不臆造可用性）。
   */
  readonly probe?: (path: string) => boolean;
}

/** 解析结果：命中（路径 + 来源级）或全缺（各级缺失原因）。 */
export type RgResolution =
  | { readonly kind: "resolved"; readonly path: string; readonly source: "bundle" | "config" }
  | { readonly kind: "unavailable"; readonly reasons: readonly string[] };

/** 单级判定：值缺失 / probe 失败各自的 reason 文案；命中返回路径。 */
function tryLevel(
  value: string | undefined,
  level: string,
  missingReason: string,
  probe: (path: string) => boolean,
): { hit?: string; reason: string } {
  if (value === undefined || value.trim() === "") {
    return { reason: `${level}：${missingReason}` };
  }
  return safeProbe(probe, value)
    ? { hit: value, reason: "" }
    : { reason: `${level}：${value} 不存在或不可执行` };
}

/** probe 调用防护：抛错只视为该候选不可用（整体不 throw 语义的一部分）。 */
function safeProbe(probe: (path: string) => boolean, candidate: string): boolean {
  try {
    return probe(candidate);
  } catch {
    return false;
  }
}

/**
 * 二级解析：bundle → config，逐级短路；全缺返回 unavailable
 * （reasons 恒为两条，逐级记录缺失原因）。任何输入组合不 throw。
 */
export function resolveRgPath(input: RgResolutionInput): RgResolution {
  const probe = input.probe ?? (() => false);
  const reasons: string[] = [];

  // ① 包内 bundle（壳注入；dev 由 dev-desktop 注入同路径仓内二进制）
  const bundle = tryLevel(input.bundlePath, "bundle", "HELIX_RG_PATH 未注入或为空", probe);
  if (bundle.hit !== undefined) return { kind: "resolved", path: bundle.hit, source: "bundle" };
  reasons.push(bundle.reason);

  // ② 用户配置（config.json rgPath）
  const config = tryLevel(input.configPath, "config", "config.json 未配置 rgPath", probe);
  if (config.hit !== undefined) return { kind: "resolved", path: config.hit, source: "config" };
  reasons.push(config.reason);

  return { kind: "unavailable", reasons };
}
