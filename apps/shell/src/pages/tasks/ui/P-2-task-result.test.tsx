// @vitest-environment jsdom
/**
 * P-2 任务页结果 tab artifact body 渲染（D2 additive）：
 * body 存在时按段留白渲染 markdown 全文（纯文字风格，无计数 chip/链接）；
 * 无 body 时只渲染 summary（不渲染 body 容器，历史产物不炸）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { TaskArtifactsDto } from "@helix/protocol";
import { t as translate } from "@/shared/i18n";
import { zhCN } from "@/shared/i18n/lang/zh-CN";
import TaskResultPane from "./P-2-task-result";

const t = (key: string, vars?: Record<string, string | number>) => translate(zhCN, key, vars);

function artifactsOf(stages: TaskArtifactsDto["stages"]): TaskArtifactsDto {
  return { stages };
}

afterEach(cleanup);

describe("P-2 结果 tab：artifact body（D2）", () => {
  it("body 存在 → summary 与 body 全文都渲染（按段留白容器）", () => {
    const body = "## 发现\n\n- [阻断] a.ts:1 空指针\n- [高] b.ts:2 竞态";
    const { container } = render(
      <TaskResultPane
        artifacts={artifactsOf([
          { seq: 1, name: "L0 核心层", status: "done", artifact: { summary: "审 3 模块：阻断 1 / 高 1", body } },
        ])}
        t={t}
      />,
    );
    expect(screen.getByText("审 3 模块：阻断 1 / 高 1")).toBeTruthy();
    const bodyEl = container.querySelector("[data-tk-art-body]");
    expect(bodyEl).not.toBeNull();
    expect(bodyEl!.textContent).toBe(body);
  });

  it("无 body → 只渲染 summary，不出现 body 容器（历史产物兼容）", () => {
    const { container } = render(
      <TaskResultPane
        artifacts={artifactsOf([
          { seq: 1, name: "L0 核心层", status: "done", artifact: { summary: "仅摘要" } },
        ])}
        t={t}
      />,
    );
    expect(screen.getByText("仅摘要")).toBeTruthy();
    expect(container.querySelector("[data-tk-art-body]")).toBeNull();
  });

  it("混合阶段：有 body 与无 body 各自如实呈现", () => {
    const { container } = render(
      <TaskResultPane
        artifacts={artifactsOf([
          { seq: 1, name: "L0 核心层", status: "done", artifact: { summary: "有全文", body: "正文段一\n\n正文段二" } },
          { seq: 2, name: "L1 领域层", status: "done", artifact: { summary: "无全文" } },
        ])}
        t={t}
      />,
    );
    const bodies = container.querySelectorAll("[data-tk-art-body]");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.textContent).toBe("正文段一\n\n正文段二");
  });
});
