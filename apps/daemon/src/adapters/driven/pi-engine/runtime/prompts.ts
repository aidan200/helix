import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 提示词资源装载器（prompts-as-resources：提示词正文唯一事实源 =
 * apps/daemon/resources/prompts/ 下的分层 md，TS 侧零内联散文）。
 *
 * 目录约定：
 * - roles/        —— 角色层：每 agent 一个 md（角色定位 + 本 agent 特有纪律）；
 * - disciplines/  —— 通用纪律层：全局静态 md，所有 profile 如实注入。
 *
 * 解析根 = import.meta.dir 上溯五级到 apps/daemon 包根（与 paths.ts
 * builtinSkillsDir 同款 bun 直跑 .ts 解析，不展开用户主目录、不依赖 cwd）。
 * 缺文件/读取失败 = 模块加载期 throw（fail-fast——提示词缺块不允许
 * 静默降级成空 prompt）。
 */

/** 随仓提示词目录：`<包根>/resources/prompts`。 */
export function builtinPromptsDir(): string {
  return path.join(import.meta.dir, "..", "..", "..", "..", "..", "resources", "prompts");
}

/**
 * 按相对路径（相对 resources/prompts/）装载若干 md 并拼接（段间空行）。
 * 返回值即 profile systemPrompt 的 base 部分——组装器再追加工具/技能段。
 */
export function loadPrompt(...relativePaths: readonly string[]): string {
  return relativePaths
    .map((rel) => readFileSync(path.join(builtinPromptsDir(), rel), "utf8").trim())
    .join("\n\n");
}
