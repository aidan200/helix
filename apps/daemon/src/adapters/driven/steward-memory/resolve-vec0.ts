/**
 * vec0 扩展路径解析（管家记忆 B1 批——resolve-rg 同构二级解析，
 * framework-free 纯函数：零 env/fs 直接依赖，全部环境面由入参注入）。
 *
 * 固定二级顺序：① 包内 bundle（壳经 env HELIX_VEC_PATH 注入，打包形态
 * 由装配层读出传入）→ ② node_modules 平台包路径（dev 形态由装配层经
 * sqlite-vec npm 包 getLoadablePath() 解析传入；编译单文件形态
 * node_modules 不可解析 → 该级缺席，靠 ① 级兜底）。
 *
 * 任何输入组合均不 throw；二级全缺返回 unavailable 且 reasons 逐条记录
 * （启动日志/配置面降级提示数据源）。本模块是全仓唯一 vec0 路径解析点。
 */

/** 解析入参（全注入，零环境直读）。 */
export interface Vec0ResolutionInput {
  /** ① 壳 env HELIX_VEC_PATH 注入值（打包形态；dev 不注入）。 */
  readonly bundlePath?: string;
  /** ② node_modules 平台包解析产物（sqlite-vec getLoadablePath()；dev 形态）。 */
  readonly nodeModulesPath?: string;
  /** 文件存在探测（注入，可单测；缺省 = 任何候选均不命中，保守降级）。 */
  readonly probe?: (path: string) => boolean;
}

/** 解析结果：命中（路径 + 来源级）或全缺（各级缺失原因）。 */
export type Vec0Resolution =
  | { readonly kind: "resolved"; readonly path: string; readonly source: "bundle" | "node_modules" }
  | { readonly kind: "unavailable"; readonly reasons: readonly string[] };

function tryLevel(
  value: string | undefined,
  level: string,
  missingReason: string,
  probe: (path: string) => boolean,
): { hit?: string; reason: string } {
  if (value === undefined || value.trim() === "") {
    return { reason: `${level}：${missingReason}` };
  }
  let ok = false;
  try {
    ok = probe(value);
  } catch {
    ok = false; // probe 抛错只视为该候选不可用（整体不 throw 语义）
  }
  return ok ? { hit: value, reason: "" } : { reason: `${level}：${value} 不存在` };
}

/** 二级解析：bundle → node_modules，逐级短路；全缺返回 unavailable。 */
export function resolveVec0Path(input: Vec0ResolutionInput): Vec0Resolution {
  const probe = input.probe ?? (() => false);
  const reasons: string[] = [];

  const bundle = tryLevel(input.bundlePath, "bundle", "HELIX_VEC_PATH 未注入或为空", probe);
  if (bundle.hit !== undefined) return { kind: "resolved", path: bundle.hit, source: "bundle" };
  reasons.push(bundle.reason);

  const nm = tryLevel(input.nodeModulesPath, "node_modules", "sqlite-vec 平台包未安装或不可解析", probe);
  if (nm.hit !== undefined) return { kind: "resolved", path: nm.hit, source: "node_modules" };
  reasons.push(nm.reason);

  return { kind: "unavailable", reasons };
}
