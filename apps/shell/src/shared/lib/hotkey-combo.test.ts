/**
 * hotkey-combo 纯函数面测试（B4 全局组合键；TDD 红→绿）。
 *
 * - captureCombo：按键事件 → 组合键捕获裁决四态——修饰键单独按下（不完整，
 *   继续等）/ Esc（取消录制）/ 单键无修饰（拒收 + 主键回报）/ 合法组合
 *   （⌘⌥⇧⌃ 顺序定格回显，主键大写归一）；
 * - comboToAccel：回显串 → tauri-plugin-global-shortcut 注册 accel
 *   （⌘→CommandOrControl、⌥→Alt、⇧→Shift、⌃→Control；主键透传）。
 */
import { describe, expect, it } from "vitest";
import { captureCombo, comboToAccel } from "./hotkey-combo";

describe("captureCombo（录制态按键裁决）", () => {
  it("合法组合：⌘+⇧+K → 「⌘⇧K」（⌘⌥⇧⌃ 定序 + 主键大写归一）", () => {
    expect(captureCombo({ key: "K", metaKey: true, shiftKey: true })).toEqual({
      kind: "combo",
      combo: "⌘⇧K",
    });
    // 全修饰 + 功能键：顺序恒为 ⌘⌥⇧⌃，主键透传
    expect(
      captureCombo({ key: "F5", metaKey: true, altKey: true, shiftKey: true, ctrlKey: true }),
    ).toEqual({ kind: "combo", combo: "⌘⌥⇧⌃F5" });
    // 小写按键大写归一（Shift 未按但键值为小写）
    expect(captureCombo({ key: "k", metaKey: true })).toEqual({ kind: "combo", combo: "⌘K" });
    // 空格主键回显 Space
    expect(captureCombo({ key: " ", altKey: true })).toEqual({ kind: "combo", combo: "⌥Space" });
  });

  it("单键（无修饰键）拒收：need-modifier 携主键", () => {
    expect(captureCombo({ key: "k" })).toEqual({ kind: "need-modifier", key: "K" });
    expect(captureCombo({ key: "F5" })).toEqual({ kind: "need-modifier", key: "F5" });
  });

  it("修饰键单独按下 = 不完整组合（none，继续等待主键）", () => {
    for (const key of ["Meta", "Alt", "Shift", "Control"]) {
      expect(captureCombo({ key, metaKey: true, altKey: true }).kind).toBe("none");
    }
  });

  it("Esc = cancel（取消录制判据）", () => {
    expect(captureCombo({ key: "Escape" })).toEqual({ kind: "cancel" });
    // Esc 即使带修饰也是取消（Esc 不可被录成组合键）
    expect(captureCombo({ key: "Escape", metaKey: true }).kind).toBe("cancel");
  });
});

describe("comboToAccel（回显串 → 注册 accel）", () => {
  it("修饰映射：⌘→CommandOrControl、⌥→Alt、⇧→Shift、⌃→Control；主键透传", () => {
    expect(comboToAccel("⌘⇧K")).toBe("CommandOrControl+Shift+K");
    expect(comboToAccel("⌥Space")).toBe("Alt+Space");
    expect(comboToAccel("⌃A")).toBe("Control+A");
    expect(comboToAccel("⌘⌥⇧⌃F5")).toBe("CommandOrControl+Alt+Shift+Control+F5");
  });
});
