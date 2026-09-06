import { describe, expect, test } from "bun:test";
import { buildRecovery } from "../../src/adapters/driven/tools/edit/recovery";

/**
 * runLevel2 行锚多次出现召回（M8 修复红→绿）：
 * 锚行在内容中多次出现时，首个命中位置不可行（窗口起点为负 / 窗口分数不足）
 * 不应终止扫描——后续出现位置仍可能命中合法窗口（两处 break → continue）。
 */
describe("runLevel2：锚多次出现时继续扫描后续出现位置", () => {
  test("首次出现 start<0（窗口起点为负）→ 继续扫描命中后续合法窗口", () => {
    // oldText 首行为空（anchorIndex=1），锚 "TARGET" 在 L1 先出现一次
    //（i=0 → start=-1 不可行）；L3 的第二次出现才是合法窗口起点。
    const content = "TARGET something\nx\nTARGET\nrest-a\nrest-b";
    const oldText = "\nTARGET\nrest-a\nrest-B-diff";
    const report = buildRecovery(content, oldText);
    expect(report.level1.hit).toBe(false); // 前置：①级不命中（差异不止引号）
    expect(report.level2.hit).toBe(true);
    expect(report.level2.anchorLine).toBe(2); // 窗口起点 L2（锚在 L3）
  });

  test("首次出现窗口分数不足 → 继续扫描命中后续高分窗口", () => {
    // 锚 "ANCHOR" 在 L1/L5 各出现一次：L1 窗口其余行全不似（0.25 < 0.5），
    // L5 窗口三行全等（0.75 ≥ 0.5）——首个低分出现不应终止扫描。
    const content = "ANCHOR\nzz\nyy\nww\nANCHOR\nfoo1\nfoo2\nbar3";
    const oldText = "ANCHOR\nfoo1\nfoo2\nfoo3";
    const report = buildRecovery(content, oldText);
    expect(report.level1.hit).toBe(false);
    expect(report.level2.hit).toBe(true);
    expect(report.level2.anchorLine).toBe(5);
  });
});
