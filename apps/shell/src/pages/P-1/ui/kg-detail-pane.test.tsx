// @vitest-environment jsdom
/**
 * KgDetailPane 两步确认条开态测试（F5.4 内联确认条）。
 *
 * 钉住：开态按 detail.id 派生——draft A 开确认条后切到 draft B，确认条不得
 * 转移（旧实现在渲染体裸写 ref + setState 守卫，并发渲染废弃腿可失效 →
 * A 的开态落到 B，误点即把 B 误转正，写面事故）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { KgNodeDetailDto, KgNodeListRow } from "@helix/protocol";
import KgDetailPane from "./kg-detail-pane";

localStorage.setItem("helix-lang", "zh-CN");
afterEach(cleanup);

function detailOf(id: string, name: string): KgNodeDetailDto {
  return {
    id,
    name,
    kind: "rule",
    domain: "tech",
    status: "draft",
    digest: "摘要",
    body: "正文",
    anchors: [],
    relations: [],
    supersede: { history: [], current: { id, name, kind: "rule", digestFirstLine: "" } },
    log: [],
  } as unknown as KgNodeDetailDto;
}

const byId = new Map<string, KgNodeListRow>();

function ui(detail: KgNodeDetailDto, onConfirm: (id: string) => void) {
  const element = (d: KgNodeDetailDto) => (
    <I18nProvider>
      <KgDetailPane detail={d} loading={false} byId={byId} onGoto={vi.fn()} onConfirm={onConfirm} />
    </I18nProvider>
  );
  const view = render(element(detail));
  return { view, rerender: (d: KgNodeDetailDto) => view.rerender(element(d)) };
}

describe("KgDetailPane 确认条开态（按 id 派生）", () => {
  it("确认条不跨节点转移：A 开条 → 切 B 无确认条 → 点转正只转 B", () => {
    const onConfirm = vi.fn();
    const { view, rerender } = ui(detailOf("TR-1", "节点A"), onConfirm);
    fireEvent.click(view.container.querySelector("[data-kg-promote]")!);
    expect(view.container.querySelector("[data-kg-confirm-box]")).not.toBeNull();
    // 切到另一 draft 节点：开态不得跟随
    rerender(detailOf("TR-2", "节点B"));
    expect(view.container.querySelector("[data-kg-confirm-box]")).toBeNull();
    // B 上重新开条确认 → onConfirm 收 B 的 id（不会误确认 A）
    fireEvent.click(view.container.querySelector("[data-kg-promote]")!);
    fireEvent.click(view.container.querySelector("[data-kg-promote-yes]")!);
    expect(onConfirm).toHaveBeenCalledWith("TR-2");
  });

  it("源码定式（TR-285）：开态判定按 id 派生，渲染体不写 ref/state（废弃腿风险面不可单测）", () => {
    // 并发渲染废弃腿在 jsdom 单测里复现不出（同一渲染内 setState 会立刻重渲，
    // 行为断言看不到窗口）——用源码形态钉住：禁渲染体写 confirmForRef，
    // 开态由 confirmFor === detailId 派生。
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "kg-detail-pane.tsx"), "utf8");
    expect(src).not.toMatch(/confirmForRef\.current\s*=/); // 渲染体裸写 ref 已退场（注释可留存）
    expect(src).toContain("confirmFor !== null && confirmFor === detailId"); // 开态按 id 派生
    expect(src).toMatch(/useEffect\(\(\) => \{\s*setConfirmFor\(null\);\s*\}, \[detailId\]\);/); // 清理走效果期
  });

  it("切换后确认条已收口：回到 A 不复活旧开态（需重新点击转正）", () => {
    const { view, rerender } = ui(detailOf("TR-1", "节点A"), vi.fn());
    fireEvent.click(view.container.querySelector("[data-kg-promote]")!);
    rerender(detailOf("TR-2", "节点B"));
    rerender(detailOf("TR-1", "节点A"));
    expect(view.container.querySelector("[data-kg-confirm-box]")).toBeNull();
  });
});
