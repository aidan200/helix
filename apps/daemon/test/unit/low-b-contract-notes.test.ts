/**
 * 低危批 L2（adapters 域）注释口径漂移的源码定式断言（TR-285）。
 *
 * 「注释承诺 ≠ 实现」型修复无行为面可测，改用源码文本断言钉住校正后的口径：
 * 新口径在场 + 旧措辞禁回潮。断言目标都是**别的文件**（不在本文件里），
 * 因此不存在「待禁字符串与源码同文件自指」的恒真陷阱（TR-285 负向断言条款）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const PI_ENGINE = path.join(import.meta.dir, "..", "..", "src", "adapters", "driven", "pi-engine");
const PROFILES = path.join(PI_ENGINE, "runtime", "profiles");
const ENGINE_SHARED = path.join(import.meta.dir, "..", "..", "src", "adapters", "driven", "engine-shared");

const read = (...segments: string[]): string => readFileSync(path.join(...segments), "utf8");

describe("adapters 域注释口径（低危批 L2）", () => {
  test("AgentProfile.lifecycle：声明为纯元数据、无运行期消费点（不得再写「生命周期策略」裸义）", () => {
    const src = read(PI_ENGINE, "runtime", "AgentProfile.ts");
    expect(src).toContain("纯元数据，无运行期消费点");
    expect(src).toContain("AgentRuntime 不读本字段");
    // 旧裸义声明位（易误导「runtime 按 lifecycle 分支」）不得回潮
    const banned = "/** 生命周期策略" + "。 */";
    expect(src).not.toContain(banned);
  });

  test("McpDeferredHooks：链位序契约不引行号（行号引用必随编辑漂移）", () => {
    const src = read(PI_ENGINE, "runtime", "hooks", "McpDeferredHooks.ts");
    expect(src).toContain("本注释不引行号");
    // 「CompactionHook:<数字>」式行号引用不得回潮
    expect(/CompactionHook:\d+/.test(src)).toBe(false);
  });

  test("SessionMapper 头注：无编辑残留病句（半句覆盖重写）", () => {
    const src = read(PI_ENGINE, "mappers", "SessionMapper.ts");
    expect(src).toContain("sqlite-session 适配器承载（不在本层）");
    const banned = "完整持久化映射随\n * 完整持久化映射";
    expect(src).not.toContain(banned);
  });

  test("SubAgentCodeReviewerProfile：REMOVED_TOOLS 文档注释单份（编辑残留两份已清）", () => {
    const src = read(PROFILES, "SubAgentCodeReviewerProfile.ts");
    const head = "reviewer 相对通用 worker 的摘除工具（代码写面机械关闭；组装快照派生单源）";
    expect(src.split(head).length - 1).toBe(1);
  });

  test("profiles：engine-shared import 单语句（同模块不拆两条 import）", () => {
    for (const name of ["MainSessionProfile.ts", "OrchestratorProfile.ts", "SubAgentProfile.ts"]) {
      const src = read(PROFILES, name);
      const hits = src.split('from "../../../engine-shared"').length - 1;
      expect(hits).toBe(1);
    }
  });

  test("EditTool.EditAppliedEvent.fileLines：注明非磁盘原样（LF 归一/去 BOM）", () => {
    const src = read(path.join(import.meta.dir, "..", "..", "src", "adapters", "driven", "tools", "edit", "EditTool.ts"));
    expect(src).toContain("**不是磁盘原样**");
    expect(src).toContain("LF 归一、已去 BOM");
    const banned = "/** 落盘后内容按 \\n 切分";
    expect(src).not.toContain(banned);
  });

  test("validateBrief 标题判据：口径 = 标题包含要素词（非「收窄枚举」）", () => {
    const src = read(ENGINE_SHARED, "templates", "validate.ts");
    expect(src).toContain("标题**包含**要素词");
    expect(src).toContain("同词异义标题");
    const banned = "源文档实际用词的收窄" + "枚举";
    expect(src).not.toContain(banned);
  });
});
