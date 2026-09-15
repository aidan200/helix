// @vitest-environment jsdom
/**
 * P-1-context-card：code-review 族B（B4）——状态徽标走 displayState 词表
 * （E-154 单源，与 instance-panel displayKeyOf 同口径）回归钉。
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceInstanceRecord } from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";
import ContextCard from "./P-1-context-card";

localStorage.setItem("helix-lang", "zh-CN");

afterEach(() => cleanup());

function recordOf(over: Partial<TraceInstanceRecord>): TraceInstanceRecord {
  return {
    instanceId: "inst-1",
    agentKind: "main",
    profileKind: "main",
    status: "running",
    eventCount: 3,
    snapshotMissing: true,
    ...over,
  };
}

function ui(record: TraceInstanceRecord) {
  return render(
    <I18nProvider>
      <ContextCard record={record} loading={false} promptOpen={false} onTogglePrompt={() => {}} events={[]} refMs={Date.now()} />
    </I18nProvider>,
  );
}

describe("code-review 族B：context-card 状态徽标 displayState 词表（B4）", () => {
  it("displayState=idle + status=running（main 编译会话空闲态）→ 徽标显示「空闲」而非「运行中」", () => {
    ui(recordOf({ status: "running", displayState: "idle" }));
    const badge = document.querySelector(".st-badge") as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain("空闲"); // ← 缺陷：原实现只看 status →「运行中」
    expect(badge.textContent).not.toContain("运行中");
  });

  it("无 displayState（旧数据降级窗口）→ 回落 status 词表（「运行中」）", () => {
    ui(recordOf({ status: "running" }));
    const badge = document.querySelector(".st-badge") as HTMLElement;
    expect(badge.textContent).toContain("运行中");
  });
});
