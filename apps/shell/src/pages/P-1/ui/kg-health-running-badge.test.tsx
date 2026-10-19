// @vitest-environment jsdom
/**
 * 体检面板运行态徽标文案分域（F3a 续修）：TaskBlock 的运行态徽标键由调用方
 * 注入——review / code-review / triage 三块各显自己的运行态文案，不再复用
 * review 专属键（原实现 code-review/triage 运行中显示「体检任务进行中」，与
 * 组件头注「文案键由调用方注入」契约相悖且误导）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider, useI18n } from "@/shared/i18n";
import type { KgHealthDto } from "@helix/protocol";
import KgHealthPane from "@/pages/P-1/ui/kg-health-pane";

localStorage.setItem("helix-lang", "zh-CN");
afterEach(() => cleanup());

/** 三任务块都在运行态的最小健康回执（结构面全绿——任务行才是断言面）。 */
function runningHealth(): KgHealthDto {
  return {
    conflicts: [],
    orphans: [],
    orphanCount: 0,
    index: { symbolCount: 1, nodeCount: 1, syncedAt: new Date(0).toISOString() } as unknown as KgHealthDto["index"],
    candidates: { pending: 0, deferred: 0, applied: 0, discarded: 0 },
  };
}

function TProbe({ render: children }: { render: (t: ReturnType<typeof useI18n>["t"]) => React.ReactNode }) {
  const { t } = useI18n();
  return <>{children(t)}</>;
}

describe("体检面板运行态徽标文案分域", () => {
  it("code-review / triage 运行态徽标不复用 review 的「体检任务进行中」", () => {
    const { container } = render(
      <I18nProvider>
        <TProbe
          render={(t) => (
            <KgHealthPane
              health={runningHealth()}
              loading={false}
              failed={false}
              nodeCount={1}
              reviewBusy={false}
              reviewLaunched={false}
              reviewRunning={true}
              codeReviewBusy={false}
              codeReviewLaunched={false}
              codeReviewRunning={true}
              triageBusy={false}
              triageLaunched={false}
              triageRunning={true}
              audit={null}
              auditLoading={false}
              projectName="helix"
              t={t}
              onLaunchReview={() => {}}
              onLaunchCodeReview={() => {}}
              onLaunchTriage={() => {}}
              onAuditRefresh={() => {}}
              onOpenTasks={() => {}}
            />
          )}
        />
      </I18nProvider>,
    );
    const badge = (d: string) =>
      container.querySelector(`[data-${d}-running-badge]`)?.textContent ?? "";
    expect(badge("review")).toBe("体检任务进行中");
    expect(badge("code-review")).toBe("代码评审进行中");
    expect(badge("triage")).toBe("待办面裁决进行中");
    // 三块互不同文案（回归面：任一键被复用即红）
    expect(new Set([badge("review"), badge("code-review"), badge("triage")]).size).toBe(3);
  });
});
