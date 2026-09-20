// @vitest-environment jsdom
/**
 * SubAgentCard 流式摘要固定槽测试（行数临界抖动修复）。
 *
 * 钉结构差异：
 * - running 态摘要包 .sa-stream-text（line-clamp:2 + min-height 固定槽——滑窗
 *   120 字悬在换行临界，行数 1↔2 横跳即卡片高度脉动，内联消息流贴底态即抖动；
 *   槽层保证流式期高度恒定）+ 光标在槽内；
 * - 终态（done/failed）closure 摘要为静态定稿内容——裸文本不套槽不钳；
 * - sa-foot 在槽外（钳制不得吞脚注行）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { InstanceCardState } from "@/entities/session/model/session-reducer";

// useRunningElapsed 1s interval（running 态）——测试中挂 timer 无妨，卸载清理
vi.mock("@/shared/lib/useRunningElapsed", () => ({
  useRunningElapsed: () => "12.3s",
}));

import SubAgentCard from "./SubAgentCard";

afterEach(cleanup);

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言）
localStorage.setItem("helix-lang", "zh-CN");

function ui(card: InstanceCardState) {
  return render(
    <I18nProvider>
      <SubAgentCard card={card} onOpenDrawer={() => {}} />
    </I18nProvider>,
  );
}

const base: InstanceCardState = {
  instanceId: "agent-abc123",
  state: "running",
  task: "调研任务",
  profileKind: "subagent-worker",
  streamSummary: "第 3/20 次完成",
  anchorEntryId: null,
};

describe("SubAgentCard 流式摘要固定槽", () => {
  it("running 态：摘要包 .sa-stream-text 槽层 + 光标在槽内 + sa-foot 在槽外", () => {
    const { container } = ui({ ...base });
    const slot = container.querySelector(".sa-sub .sa-stream-text");
    expect(slot).not.toBeNull();
    // 滑窗摘要文本在槽内
    expect(slot!.textContent).toContain("第 3/20 次完成");
    // 流式光标随文本入槽（钳制不得吞光标位置）
    expect(slot!.querySelector(".stream-cursor")).not.toBeNull();
    // sa-foot（脚注行）在槽外——钳制不得吞脚注
    const sub = container.querySelector(".sa-sub")!;
    expect(sub.querySelector(":scope > .sa-foot")).not.toBeNull();
  });

  it("done 态：closure 摘要为静态定稿内容——裸文本，不套槽层", () => {
    const { container } = ui({
      ...base,
      state: "done",
      closure: { summary: "任务完成：产出调研报告", findings: [], status: "done" },
      streamSummary: "",
    });
    const sub = container.querySelector(".sa-sub")!;
    expect(sub.querySelector(".sa-stream-text")).toBeNull();
    expect(sub.textContent).toContain("任务完成：产出调研报告");
  });

  it("failed 态：错误行同为静态定稿——裸文本，不套槽层", () => {
    const { container } = ui({ ...base, state: "failed", error: "boom", streamSummary: "" });
    expect(container.querySelector(".sa-stream-text")).toBeNull();
    expect(container.querySelector(".sa-sub")!.textContent).toContain("boom");
  });
});
