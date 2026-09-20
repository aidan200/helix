import { describe, expect, test } from "bun:test";
import {
  DEPRECATED_TOOL_NAMES,
  sanitizeDeprecatedToolNames,
} from "../../src/adapters/driven/tools/deprecated-tool-names";

/**
 * 已废弃工具名消毒器（幽灵工具名复发修复批）：会话文本注入 SubAgent 上下文
 * 前的防扩散层——按「已废弃名表」把旧工具名改写为新名 + 废弃注记。
 *
 * 背景：工具改名（sandbox_request → permission_request）后，会话历史文本
 * 仍携带旧名（实证 269 处污染）；MainAgent 组 brief 照搬会话内容时旧名随
 * task 文本进 SubAgent 上下文，模型照搬旧名发起调用。消毒器在 spawn 装配
 * 面机械改写，模型看到的第一手文本即新名。
 */
describe("已废弃工具名表（单源数据面）", () => {
  test("当前表仅 sandbox_request → permission_request 一项（留扩展位）", () => {
    expect(DEPRECATED_TOOL_NAMES.size).toBe(1);
    expect(DEPRECATED_TOOL_NAMES.get("sandbox_request")).toBe("permission_request");
  });
});

describe("sanitizeDeprecatedToolNames（文本消毒）", () => {
  test("出现 sandbox_request → 改写为 permission_request + 废弃注记；旧名仅以注记形态残留", () => {
    const out = sanitizeDeprecatedToolNames("遇到沙箱拦截时调用 sandbox_request 提权");
    expect(out).toContain("permission_request（沙箱外执行申请通道");
    expect(out).toContain("旧名 sandbox_request 已废弃");
    // 裸旧名清零：剥掉注记形态后不再出现
    expect(out.replace(/旧名 sandbox_request 已废弃/g, "")).not.toContain("sandbox_request");
  });

  test("多处出现全部改写；其余文本逐字节保留", () => {
    const text = "工具 A：sandbox_request；工具 B：sandbox_request。正文不动。";
    const out = sanitizeDeprecatedToolNames(text);
    expect(out).toContain("正文不动。");
    expect((out.match(/permission_request（沙箱外执行申请通道/g) ?? []).length).toBe(2);
    expect((out.match(/旧名 sandbox_request 已废弃/g) ?? []).length).toBe(2);
  });

  test("干净文本零改写（逐字节不变）", () => {
    const clean = "调用 permission_request 申请提权；bash/read/write 均正常。";
    expect(sanitizeDeprecatedToolNames(clean)).toBe(clean);
  });

  test("词边界：长标识符内嵌（如 my_sandbox_request_v2）不误改", () => {
    const text = "字段 my_sandbox_request_v2 保持原样";
    expect(sanitizeDeprecatedToolNames(text)).toBe(text);
  });
});
