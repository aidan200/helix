/**
 * codegraph 二进制路径单级解析单点（T2.1/AF-2 裁决，TR-AD-32 三方二进制
 * 接入定式）——framework-free 纯函数：零 env/fs 直接依赖，全部环境面由
 * 入参注入（可单测）。与 resolve-rg.ts 同模板（AF-3：真实顺序以代码为准）。
 *
 * 单级解析：包内 bundle（壳经 env HELIX_CODEGRAPH_PATH 注入，由装配层
 * 读出后传入；dev 形态由 dev-desktop 注入同路径仓内二进制）——bundle-only。
 *
 * 不设 PATH 探测级（历史第③级已砍，与 rg 同裁决）；也不设 config.json
 * 级（历史第②级已砍，2026-09-05 config.json 瘦身裁决：与 env 键语义完全
 * 重叠——分发形态 bundle 必在、dev 形态 dev-desktop 自动注入，任何显式
 * 指定场景 env 一行可达，且用户指向任意版本引擎同样与「pin 版本 +
 * sha256」确定性目标相悖）。
 *
 * 决策消解：
 * - 任何输入组合均不 throw；bundle 缺失或 probe 失败返回 `unavailable`
 *   且 reason 记录原因（供启动日志），是 EngineUnavailable/degraded 路径
 *   的解析面入口（二进制不可达 = degraded 第一入口）；probe 自身抛错
 *   同样只视为候选不可用。
 * - 本模块是全仓唯一 codegraph 路径解析点；消费点在装配层一次性调用，
 *   ensureIndex/exportSymbols 的 spawn 只用定格产物（exportSymbols 不用
 *   二进制——只读直连 db，与解析结果解耦）。
 */

/** 解析入参（全注入，零环境直读）。 */
export interface CodegraphResolutionInput {
  /** 壳 env HELIX_CODEGRAPH_PATH 注入值（由装配层读出后传入；唯一来源级）。 */
  readonly bundlePath?: string;
  /**
   * 存在且可执行探测（注入，可单测）。缺省 = 无法验证可用性，
   * 任何候选均不命中（保守降级，不臆造可用性）。
   */
  readonly probe?: (path: string) => boolean;
}

/** 解析结果：命中（路径）或全缺（缺失原因）。 */
export type CodegraphResolution =
  | { readonly kind: "resolved"; readonly path: string }
  | { readonly kind: "unavailable"; readonly reasons: readonly string[] };

/** 单级判定：值缺失 / probe 失败各自的 reason 文案；命中返回路径。
 * 三级解析砍为 bundle 单级后保留参数化形态（level/reason 文案入参），
 * 与 resolve-rg.ts 同模板有意保持一致（测试可注入文案断言 reason 面）。 */
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
 * 单级解析：bundle env 注入值，probe 命中即 resolved；缺失/不可执行返回
 * unavailable（reasons 恒一条）。任何输入组合不 throw。
 */
export function resolveCodegraphPath(input: CodegraphResolutionInput): CodegraphResolution {
  const probe = input.probe ?? (() => false);

  // 包内 bundle（壳注入；dev 由 dev-desktop 注入同路径仓内二进制）——唯一来源级
  const bundle = tryLevel(input.bundlePath, "bundle", "HELIX_CODEGRAPH_PATH 未注入或为空", probe);
  if (bundle.hit !== undefined) return { kind: "resolved", path: bundle.hit };

  return { kind: "unavailable", reasons: [bundle.reason] };
}
