// @vitest-environment jsdom
/**
 * SteerComposer 键盘发送测试（CL-3 F(3.3).3 补面 + 抽屉 plan 面批补断言）。
 *
 * - Enter 非空 → steerInstance + 清空；空输入零动作（既有口径回归）；
 * - IME 选词确认的 Enter（nativeEvent.isComposing=true）不发送——zh-CN
 *   一等语言，未上屏半截文本直发 SubAgent 是事故面（M11 批修复）；
 * - 去 agentid（用户需求）：目标行/placeholder 均不携带 instanceId——
 *   身份面唯一化抽屉头部 d-id 行，输入区不重复展示。
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

describe("SteerComposer 去 agentid（抽屉输入区身份面唯一化）", () => {
  it("目标提示行不携带 instanceId（无 tgt chip）", () => {
    ui();
    const target = document.querySelector(".sc-target");
    expect(target).not.toBeNull();
    expect(target!.textContent).not.toContain("agent-run");
    expect(document.querySelector(".sc-target .tgt")).toBeNull();
  });

  it("placeholder 不携带 instanceId（空输入态文案）", () => {
    ui();
    expect(input().value).toBe(""); // 空输入态 → placeholder 可见
    expect(input().placeholder).not.toContain("agent-run");
    expect(input().placeholder).toContain("纠偏指令");
  });
});
