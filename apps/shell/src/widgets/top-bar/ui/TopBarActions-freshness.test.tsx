// @vitest-environment jsdom
/**
 * 顶栏连接状态区 daemon 陈旧警示 chip（stale-indicator 批）：
 * - state.daemonFreshness.stale === true → 琥珀 chip 出现（文案 + warn dot），
 *   title 含 daemon 启动时间；点击 → 剪贴板复制重启提示文本；
 * - stale=false / daemonFreshness=null（旧 daemon / 打包态）→ 不出 chip。
 * vi.mock SessionContext 先例（StewardPanel.test.tsx）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { SessionState } from "@/entities/session/model/state";

const writeText = vi.fn((_text: string) => Promise.resolve());
vi.stubGlobal("navigator", { clipboard: { writeText } });

let mockState: Partial<SessionState> = {};
// chip 主题测试不渲染连带兄弟：StatsBadge 依赖价格表×model 派生 cost（mock model 为空会崩），直接 mock 掉
vi.mock("./SessionStats", () => ({
  StatsBadge: () => <button type="button" className="stats-btn" data-testid="stats-badge-stub" />,
}));
vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    state: {
      conn: "connected",
      model: "",
      sessionId: "s1",
      view: "ready",
      agentState: "idle",
      mainInstanceId: "agent-main",
      usage: { total: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, audioInput: 0, audioOutput: 0 }, compaction: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, audioInput: 0, audioOutput: 0 }, byInstance: {}, ctxByInstance: {} },
      ...mockState,
    },
    topology: { modelConfig: { defaultModel: "" }, list: [], agentConfig: { revision: 0, slots: null } },
    requestModelConfig: () => {},
  }),
}));

import { TopBarActions } from "./P-1-top-bar";

function renderActions() {
  return render(
    <I18nProvider>
      <TopBarActions
        statsOpen={false}
        modelMenuOpen={false}
        stewardOpen={false}
        onToggleStats={() => undefined}
        onToggleModelMenu={() => undefined}
        onToggleSteward={() => undefined}
      />
    </I18nProvider>,
  );
}

describe("TopBarActions daemon 陈旧警示 chip（stale-indicator 批）", () => {
  beforeEach(() => {
    localStorage.setItem("helix-lang", "zh-CN");
    mockState = {};
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("stale=true → 琥珀 chip 出现；hover title 含 daemon 启动时间；点击复制重启提示", () => {
    mockState = { daemonFreshness: { startedAt: 1_760_000_000_000, stale: true } };
    renderActions();
    const chip = screen.getByTestId("daemon-stale-chip");
    expect(chip.textContent).toContain("daemon 代码已更新");
    expect(chip.textContent).toContain("建议重启");
    // hover：daemon 启动时间（epoch 1_760_000_000_000 → 本地时区人话）
    expect(chip.getAttribute("title")).toContain(new Date(1_760_000_000_000).toLocaleString());
    // 点击：复制重启提示文本
    fireEvent.click(chip);
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain("Ctrl+C");
    expect(copied).toContain("bun run dev");
  });

  it("stale=false（daemon 新鲜）→ 不出 chip", () => {
    mockState = { daemonFreshness: { startedAt: 1_760_000_000_000, stale: false } };
    renderActions();
    expect(screen.queryByTestId("daemon-stale-chip")).toBeNull();
  });

  it("daemonFreshness=null（旧 daemon / 打包态缺省）→ 不出 chip（additive 行为不变）", () => {
    mockState = { daemonFreshness: null };
    renderActions();
    expect(screen.queryByTestId("daemon-stale-chip")).toBeNull();
  });
});
