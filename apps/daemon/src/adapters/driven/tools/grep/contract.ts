/**
 * grep 双后端共享契约（CL-3/F3.1，architecture §6.3）。
 *
 * 本文件只含类型：GrepFile/GrepMatch/GrepQuery 为既有匹配核的数据形状
 * （自旧 GrepTool.ts 机械迁移，零改动）；GrepBackend 为双后端统一接口
 * （T1.1 落地形状：构造面持有遍历所需环境，search 只吃查询，返回恒为
 * GrepMatch[]——对调用方/引擎透明）。framework-free，零 import。
 */

/** 单文件的纯数据投影（路径 + 按行拆分的内容）。 */
export interface GrepFile {
  readonly path: string;
  readonly lines: readonly string[];
}

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
 * 双后端统一接口（architecture §6.3）：内置 TS 后端恒在兜底，rg 后端
 * 为加速器（T1.2）；两后端语义一致由 F3.3 契约对比测试守护（T1.3）。
 * 遍历/执行所需环境在构造面注入，search 只消费查询，返回恒为
 * GrepMatch[]（rg 输出在适配层归一到本形状）。
 */
export interface GrepBackend {
  readonly name: "ts" | "rg";
  search(query: GrepQuery): Promise<GrepMatch[]>;
}
