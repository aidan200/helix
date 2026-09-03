/**
 * grep 工具契约（CL-3/F3.1，architecture §6.3）——rg 单后端语义定义面。
 *
 * 本文件承载 grep 工具的**语义基准**（历史角色由内置 TS 匹配核担任，
 * rg 唯一化后上收于此）：
 * - 类型：GrepMatch/GrepQuery 为匹配核数据形状（自旧 GrepTool.ts 机械
 *   迁移，零改动）；GrepBackend 为后端统一接口（构造面持有执行所需
 *   环境，search 只吃查询，返回恒为 GrepMatch[]——对调用方/引擎透明）。
 * - globToRegExp：glob 路径过滤的**唯一实现源**（自 ts-backend 迁入），
 *   rg 后端适配层经它做单源过滤（glob 不进 rg argv）。
 * 语义契约由 golden fixture 契约测试守护（grep-contract.test.ts）。
 * framework-free，零 import。
 */

/** 一次命中：文件 + 1-based 行号 + 行原文。 */
export interface GrepMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly line: string;
}

/** 匹配查询：子串 pattern + 可选 glob 路径过滤 + 大小写开关。 */
export interface GrepQuery {
  readonly pattern: string;
  readonly glob?: string;
  readonly ignoreCase?: boolean;
}

/**
 * 后端统一接口（architecture §6.3）：rg 为唯一后端（加速器定位升格为
 * 正式实现）；执行所需环境在构造面注入，search 只消费查询，返回恒为
 * GrepMatch[]（rg --json 输出在适配层归一到本形状）。
 */
export interface GrepBackend {
  readonly name: "rg";
  search(query: GrepQuery): Promise<GrepMatch[]>;
}

/**
 * glob → 正则（`*` 可跨目录——grep --include 的 fnmatch 语义；
 * `?` 单字符；其余字符按字面量转义）。
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
