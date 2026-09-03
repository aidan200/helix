import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * T2.1 TP-2.1b 结构断言（H2.1：SessionRecord 收敛六台账）。
 *
 * SessionRegistry.ts 内 Map/Set 构造计数 ≤3——收敛后恰为：
 * ① `private readonly sessions = new Map<string, SessionRecord>()` 单台账；
 * ② `RUN_STATE_EVENT_TYPES = new Set([...])` 模块级事件类型常量（非台账）；
 * ③ `private readonly loading = new Map<string, Promise<SessionRuntime>>()`
 *   冷会话懒加载在飞去重登记（code-review M3；finally 摘除，非平行台账）。
 *
 * 收敛前现状：6 平行台账声明（runtimes / lastActivityMs /
 * lastBroadcastRunState / deleting / unpromotedDrafts / createdAnnounced）
 * + 1 常量 = 7 处构造 → 本断言先红。
 *
 * 全局口径（architecture §4.1）：Map/Set ≤2 达成「清理点 N→1」的结构前提
 * ——delete/unload 各恰一次 sessions.delete、promoteDraft 零 delete。
 */

const registryPath = path.join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "application",
  "services",
  "SessionRegistry.ts",
);
const registrySource = readFileSync(registryPath, "utf8");

/** Map/Set 构造命中行清单（file:line: 行文本；含泛型形态 `new Map<…>(…)`）。 */
function mapSetConstructionHits(source: string): string[] {
  return source
    .split("\n")
    .map((line, i) => ({ text: line.trim(), no: i + 1 }))
    .filter(({ text }) => /\bnew\s+(?:Map|Set)\b/.test(text))
    .map(({ text, no }) => `${no}: ${text}`);
}

describe("TP-2.1b 结构断言：六台账 → 单台账 Map<string, SessionRecord>", () => {
  test("SessionRegistry.ts 内 Map/Set 构造计数 ≤3（sessions 单台账 + RUN_STATE_EVENT_TYPES 常量 + loading 在飞去重）", () => {
    const hits = mapSetConstructionHits(registrySource);
    expect(
      hits.length,
      `Map/Set 构造 ${hits.length} 处（>${3}）：\n${hits.join("\n")}`,
    ).toBeLessThanOrEqual(3);
  });

  test("单台账声明存在：`private readonly sessions = new Map<string, SessionRecord>()`", () => {
    expect(registrySource).toMatch(/private readonly sessions = new Map<string, SessionRecord>/);
  });

  test("六平行台账字段声明零残留（收敛完成的机械判据）", () => {
    const legacyDeclarations = [
      "private readonly runtimes",
      "private readonly lastActivityMs",
      "private readonly lastBroadcastRunState",
      "private readonly deleting",
      "private readonly unpromotedDrafts",
      "private readonly createdAnnounced",
    ];
    for (const legacy of legacyDeclarations) {
      expect(registrySource.includes(legacy), `残留声明：${legacy}`).toBe(false);
    }
  });
});
