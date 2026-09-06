// @vitest-environment jsdom
/**
 * SteerComposer 键盘发送测试（CL-3 F(3.3).3 补面）。
 *
 * - Enter 非空 → steerInstance + 清空；空输入零动作（既有口径回归）；
 * - IME 选词确认的 Enter（nativeEvent.isComposing=true）不发送——zh-CN
 *   一等语言，未上屏半截文本直发 SubAgent 是事故面（M11 批修复）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";

const steerInstance = vi.fn();
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({ steerInstance }),
  };
});

import SteerComposer from "./SteerComposer";

function ui() {
  return render(
    <I18nProvider>
      <SteerComposer instanceId="agent-run" />
    </I18nProvider>,
  );
}

const input = () => screen.getByRole("textbox") as HTMLInputElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

describe("SteerComposer Enter 发送（IME 组合态门控）", () => {
  it("Enter 非空 → steerInstance(text, instanceId) + 发送即清空", () => {
    ui();
    fireEvent.change(input(), { target: { value: "  继续执行  " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(steerInstance).toHaveBeenCalledWith("继续执行", "agent-run");
    expect(steerInstance).toHaveBeenCalledTimes(1);
    expect(input().value).toBe("");
  });

  it("空输入 Enter 零动作", () => {
    ui();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(steerInstance).not.toHaveBeenCalled();
  });

  it("IME 选词确认的 Enter（isComposing=true）不发送、不清空", () => {
    ui();
    fireEvent.change(input(), { target: { value: "拼音未上屏" } });
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    expect(steerInstance).not.toHaveBeenCalled();
    expect(input().value).toBe("拼音未上屏"); // 组合中文本保留
    // 组合结束后的确认 Enter 正常发送
    fireEvent.keyDown(input(), { key: "Enter", isComposing: false });
    expect(steerInstance).toHaveBeenCalledWith("拼音未上屏", "agent-run");
  });
});
