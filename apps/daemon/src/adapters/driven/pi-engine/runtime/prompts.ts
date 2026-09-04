import path from "node:path";

import disciplineEngineering from "../../../../../resources/prompts/disciplines/engineering.md" with { type: "text" };
import disciplineKnowledgeCore from "../../../../../resources/prompts/disciplines/knowledge-core.md" with { type: "text" };
import roleMainSession from "../../../../../resources/prompts/roles/main-session.md" with { type: "text" };
import roleOrchestrator from "../../../../../resources/prompts/roles/orchestrator.md" with { type: "text" };
import roleSubagentCodeReviewer from "../../../../../resources/prompts/roles/subagent-code-reviewer.md" with { type: "text" };
import roleSubagentKgWriter from "../../../../../resources/prompts/roles/subagent-kg-writer.md" with { type: "text" };
import roleSubagentWorker from "../../../../../resources/prompts/roles/subagent-worker.md" with { type: "text" };

/**
 * 提示词资源装载器（prompts-as-resources：提示词正文唯一事实源 =
 * apps/daemon/resources/prompts/ 下的分层 md，TS 侧零内联散文）。
 *
 * 目录约定：
 * - roles/        —— 角色层：每 agent 一个 md（角色定位 + 本 agent 特有纪律）；
 * - disciplines/  —— 通用纪律层：全局静态 md，所有 profile 如实注入。
 *
 * 装载通道 = **静态 text import 嵌入清单**（EMBEDDED_PROMPTS），不用运行时
 * readFileSync：bun build --compile 单文件产物只内嵌模块图资产，运行时按
 * 计算路径读文件在 compiled 形态必 ENOENT（$bunfs 虚拟根，c49df62 外置化
 * 后实证 F2.2 compiled 形态启动即崩）——text import 在 dev 直跑与 compiled
 * 两形态走同一嵌入通道，内容逐字节一致，无双形态漂移面。
 * 新增 md 文件必须在本清单登记（漏登记 = loadPrompt 模块装载期 throw
 * fail-fast——提示词缺块不允许静默降级成空 prompt）；prompts-resources
 * 契约测试反向兜底「profile 引用路径 ∈ 清单」。
 */

/** 随仓提示词目录（fs 面，仅供契约测试/开发期枚举用——运行时装载不走 fs）。 */
export function builtinPromptsDir(): string {
  return path.join(import.meta.dir, "..", "..", "..", "..", "..", "resources", "prompts");
}

/** 嵌入清单：相对路径（相对 resources/prompts/）→ md 全文（静态 text import）。 */
const EMBEDDED_PROMPTS: Readonly<Record<string, string>> = {
  "roles/main-session.md": roleMainSession,
  "roles/orchestrator.md": roleOrchestrator,
  "roles/subagent-worker.md": roleSubagentWorker,
  "roles/subagent-code-reviewer.md": roleSubagentCodeReviewer,
  "roles/subagent-kg-writer.md": roleSubagentKgWriter,
  "disciplines/knowledge-core.md": disciplineKnowledgeCore,
  "disciplines/engineering.md": disciplineEngineering,
};

/**
 * 按相对路径（相对 resources/prompts/）装载若干 md 并拼接（段间空行）。
 * 未登记路径 = throw（fail-fast）。返回值即 profile systemPrompt 的 base
 * 部分——组装器再追加工具/技能段。
 */
export function loadPrompt(...relativePaths: readonly string[]): string {
  return relativePaths
    .map((rel) => {
      const text = EMBEDDED_PROMPTS[rel];
      if (text === undefined) {
        throw new Error(
          `提示词未登记进嵌入清单：${rel}（新增 md 须在 prompts.ts EMBEDDED_PROMPTS 登记——compile 产物内嵌唯一通道）`,
        );
      }
      return text.trim();
    })
    .join("\n\n");
}
