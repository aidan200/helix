/**
 * App 层「打开设置页某分区」tab 收敛闸（code-review 低危：classifier 白名单漏项）。
 *
 * 背景：features 层经 shared 信号（requestOpenSettings）发起跳转，app 层订阅
 * 后把宽 string tab 收敛成 pages 侧 ModelsTab 再落分区信号。旧实现手写
 * `tab === "chat" || "embedding" || "provider"` 串联——ModelsTab 联合后加的
 * "classifier" 被静默丢弃（落 chat tab），且无人报错（无调用方传该值即潜伏）。
 * 修法 = Record<ModelsTab, true> 白名单（联合新增成员即编译报缺键）+ 纯函数
 * 收敛闸，本测试钉「全部 ModelsTab 成员可通过、未知字面量丢弃」。
 */
import { describe, expect, it } from "vitest";
import { resolveModelsTab } from "./App";

describe("resolveModelsTab（shared 信号 tab → ModelsTab 收敛）", () => {
  it("全部 ModelsTab 成员放行（chat/embedding/classifier/provider）", () => {
    for (const tab of ["chat", "embedding", "classifier", "provider"] as const) {
      expect(resolveModelsTab(tab)).toBe(tab);
    }
  });

  it("未知字面量丢弃 tab（只指路分区，不猜义）", () => {
    expect(resolveModelsTab("unknown-tab")).toBeUndefined();
    expect(resolveModelsTab("")).toBeUndefined();
    expect(resolveModelsTab(undefined)).toBeUndefined();
  });
});
