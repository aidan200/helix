/**
 * codegraph 二进制路径二级解析单点（T2.1/AF-2 裁决，TR-AD-32 三方二进制
 * 接入定式）——framework-free 纯函数：零 env/fs 直接依赖，全部环境面由
 * 入参注入（可单测）。与 resolve-rg.ts 同模板（AF-3：真实顺序以代码为准）。
 *
 * 固定二级顺序：① 包内 bundle（壳经 env HELIX_CODEGRAPH_PATH 注入，由装配
 * 层读出后传入；dev 形态由 dev-desktop 注入同路径仓内二进制）→ ② 用户
 * 配置（config.json codegraphPath，经 config.ts 读出后传入）。
 *
 * 不设 PATH 探测级（历史第③级已砍，与 rg 同裁决）：分发形态只有安装包
 * （bundle 必在）与开发者 dev（dev-desktop 注入），PATH 上的 codegraph
 * 版本不可控（CLI 输出/索引 schema 随版本漂移），与「pin 版本 + sha256」
 * 的确定性目标相悖。
 *
 * 决策消解：
 * - 任何输入组合均不 throw；二级全缺返回 `unavailable` 且 reasons 逐条
 *   记录哪级为何缺失（供启动日志），是 EngineUnavailable/degraded 路径的
 *   解析面入口（二进制不可达 = degraded 第一入口）。
 * - 某级值非空但 probe 失败 = 该级缺失（记 reason），继续下一级，不作废
 *   整体解析；probe 自身抛错同样只视为该候选不可用。
 * - 本模块是全仓唯一 codegraph 路径解析点；消费点在装配层一次性调用，
 *   ensureIndex/exportSymbols 的 spawn 只用定格产物（exportSymbols 不用
 *   二进制——只读直连 db，与解析结果解耦）。
 */

/** 解析入参（全注入，零环境直读）。 */
export interface CodegraphResolutionInput {
  /** ① 壳 env HELIX_CODEGRAPH_PATH 注入值（由装配层读出后传入）。 */
  readonly bundlePath?: string;
  /** ② config.json codegraphPath（经 config.ts 读出后传入）。 */
  readonly configPath?: string;
  /**
   * 存在且可执行探测（注入，可单测）。缺省 = 无法验证可用性，
   * 任何候选均不命中（保守降级，不臆造可用性）。
   */
  readonly probe?: (path: string) => boolean;
}

/** 解析结果：命中（路径 + 来源级）或全缺（各级缺失原因）。 */
export type CodegraphResolution =
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
export function resolveCodegraphPath(input: CodegraphResolutionInput): CodegraphResolution {
  const probe = input.probe ?? (() => false);
  const reasons: string[] = [];

  // ① 包内 bundle（壳注入；dev 由 dev-desktop 注入同路径仓内二进制）
  const bundle = tryLevel(input.bundlePath, "bundle", "HELIX_CODEGRAPH_PATH 未注入或为空", probe);
  if (bundle.hit !== undefined) return { kind: "resolved", path: bundle.hit, source: "bundle" };
  reasons.push(bundle.reason);

  // ② 用户配置（config.json codegraphPath）
  const config = tryLevel(input.configPath, "config", "config.json 未配置 codegraphPath", probe);
  if (config.hit !== undefined) return { kind: "resolved", path: config.hit, source: "config" };
  reasons.push(config.reason);

  return { kind: "unavailable", reasons };
}
