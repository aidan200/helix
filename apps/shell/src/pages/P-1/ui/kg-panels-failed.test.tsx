// @vitest-environment jsdom
/**
 * code-review 族A：kg 体检/台账面板「加载失败」两态区分（假空态/永挂骨架消除）。
 * 钉住：failed=true 且非 loading 时渲染「加载失败」（data-kg-*="failed"），
 * 不再落「暂无候选条目」假空态 / 永挂「读取中」骨架。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import KgHealthPane from "@/pages/P-1/ui/kg-health-pane";
import KgCandidatesPanel from "@/pages/P-1/ui/kg-candidates-panel";
import { useI18n } from "@/shared/i18n";

localStorage.setItem("helix-lang", "zh-CN");

afterEach(() => cleanup());

/** 面板 t 函数注入（组件收 t prop——I18nProvider 内取真词条）。 */
function TProbe({ render: renderProp }: { render: (t: ReturnType<typeof useI18n>["t"]) => React.ReactNode }) {
  const { t } = useI18n();
  return <>{renderProp(t)}</>;
}

const healthShape = {
  conflicts: [],
  orphans: [],
  orphanCount: 0,
  staleCount: 0,
  nodeCount: 3,
  edgeCount: 2,
  candidateCounts: { pending: 0, deferred: 0, applied: 0, discarded: 0 },
};

describe("族A 两态区分：failed 分支", () => {
  it("KgHealthPane：failed + 非 loading → 「加载失败」（非永挂骨架）", () => {
    const { container } = render(
      <I18nProvider>
        <TProbe
          render={(t) => (
            <KgHealthPane
              health={null}
              loading={false}
              failed={true}
              nodeCount={undefined}
              reviewBusy={false}
              reviewLaunched={false}
              reviewRunning={false}
              codeReviewBusy={false}
              codeReviewLaunched={false}
              codeReviewRunning={false}
              projectName="helix"
              t={t}
              onLaunchReview={() => {}}
              onLaunchCodeReview={() => {}}
              onOpenTasks={() => {}}
            />
          )}
        />
      </I18nProvider>,
    );
    expect(container.querySelector('[data-kg-health="failed"]')!.textContent).toContain("加载失败");
    expect(container.querySelector('[data-kg-health="loading"]')).toBeNull();
  });

  it("KgCandidatesPanel：failed + 非 loading → 「加载失败」而非「暂无候选条目」假空态", () => {
    const { container } = render(
      <I18nProvider>
        <TProbe
          render={(t) => (
            <KgCandidatesPanel
              loading={false}
              failed={true}
              rows={[]}
              total={0}
              filter="all"
              sel={null}
              t={t}
              onFilter={() => {}}
              onSelect={() => {}}
            />
          )}
        />
      </I18nProvider>,
    );
    expect(container.querySelector('[data-kg-cand="failed"]')!.textContent).toContain("加载失败");
    expect(container.querySelector('[data-kg-cand="empty"]')).toBeNull();
  });

  it("回归面：failed=false 空 rows → 空态照常（事实空不误报失败）", () => {
    const { container } = render(
      <I18nProvider>
        <TProbe
          render={(t) => (
            <KgCandidatesPanel
              loading={false}
              failed={false}
              rows={[]}
              total={0}
              filter="all"
              sel={null}
              t={t}
              onFilter={() => {}}
              onSelect={() => {}}
            />
          )}
        />
      </I18nProvider>,
    );
    expect(container.querySelector('[data-kg-cand="empty"]')!.textContent).toContain("暂无候选条目");
  });
});

void healthShape; // 形状备忘（真回执路径由 listener 测试覆盖）
