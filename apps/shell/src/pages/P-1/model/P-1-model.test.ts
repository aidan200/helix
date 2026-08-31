/**
 * P-1 页面状态机纯函数面单测（F5.0 主区四态 + F5.1~F5.5 graph 态；
 * TDD RED 清单：四态互斥/切项目清旧态/kgToken/折叠不改主区/过滤叠加）。
 */
import { describe, expect, it } from "vitest";
import type { KgProjectRow } from "@helix/protocol";
import {
  createProjectPageState,
  projectReducer,
  type ProjectPageState,
} from "./project-model";
import {
  createKgViewState,
  filterRows,
  kgReducer,
  panelStateOf,
  pickInitial,
} from "./kg-model";
import type { KgNodeListRow, KgNodeDetailDto } from "@helix/protocol";

const ROWS: KgProjectRow[] = [
  { name: "helix", path: "/ws/helix", status: "synced", symbolCount: 56, nodeCount: 17 },
  { name: "feifei", path: "/ws/feifei", status: "degraded", degradedNote: "落后" },
  { name: "codegraph", path: "/ws/codegraph", status: "absent" },
];

/** 详情 fixture（最小六段；同一对象引用供“不重拉”身份断言）。 */
function detailOf(id: string, name: string, status: KgNodeListRow["status"]): KgNodeDetailDto {
  return {
    id, name, kind: id.startsWith("E-") ? "entity" : "rule", domain: "tech", status,
    digest: "", body: "", anchors: [], relations: [],
    supersede: { history: [], current: { id, name, kind: "rule", digestFirstLine: "" } },
    log: [],
  };
}
const DETAIL_E9 = detailOf("E-9", "实体甲", "confirmed");
const DETAIL_TR47 = detailOf("TR-47", "规则乙", "draft");

function loaded(): ProjectPageState {
  return projectReducer(createProjectPageState(), { type: "list-result", projects: ROWS });
}

describe("project-model 主区四态状态机", () => {
  it("初始 = empty：未选项目，主区空态", () => {
    const s = createProjectPageState();
    expect(s.mainMode).toBe("empty");
    expect(s.selected).toBeNull();
  });

  it("选中 synced/degraded → graph；absent → absent；building → building", () => {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "helix" });
    expect(s.mainMode).toBe("graph");
    expect(s.domainCollapsed).toBe(true);
    s = projectReducer(s, { type: "select-project", name: "feifei" });
    expect(s.mainMode).toBe("graph");
    s = projectReducer(s, { type: "select-project", name: "codegraph" });
    expect(s.mainMode).toBe("absent");
  });

  it("点当前已选中行仅折叠不重置（kgToken/主区不变）", () => {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "helix" });
    const token = s.kgToken;
    s = projectReducer(s, { type: "expand-domain" });
    expect(s.domainCollapsed).toBe(false);
    expect(s.mainMode).toBe("graph");
    s = projectReducer(s, { type: "select-project", name: "helix" });
    expect(s.domainCollapsed).toBe(true);
    expect(s.mainMode).toBe("graph");
    expect(s.kgToken).toBe(token); // 不重置
  });

  it("切项目先清旧态再进新态（kgToken 递增防残影）", () => {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "helix" });
    const t1 = s.kgToken;
    s = projectReducer(s, { type: "select-project", name: "codegraph" });
    expect(s.kgToken).toBe(t1 + 1);
    expect(s.mainMode).toBe("absent");
    expect(s.buildProgress).toBeNull();
  });

  it("B1 冷启动：CTA → absent→building（行徽章乐观翻）→ synced 回执 → graph + 行翻 synced", () => {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "codegraph" });
    s = projectReducer(s, { type: "build-started", name: "codegraph" });
    expect(s.mainMode).toBe("building");
    expect(s.projects.find((p) => p.name === "codegraph")!.status).toBe("building");
    s = projectReducer(s, {
      type: "index-status",
      name: "codegraph",
      status: { state: "building", progress: { done: 12, total: 26 } },
    });
    expect(s.buildProgress).toEqual({ done: 12, total: 26 });
    s = projectReducer(s, {
      type: "index-status",
      name: "codegraph",
      status: { state: "synced", symbolCount: 26, syncedAt: "2026-08-25T10:00:00Z" },
    });
    expect(s.mainMode).toBe("graph");
    expect(s.buildProgress).toBeNull();
    expect(s.projects.find((p) => p.name === "codegraph")!.status).toBe("synced");
  });

  it("触发未生效（回执仍 absent）→ 退回 absent 可重试", () => {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "codegraph" });
    s = projectReducer(s, { type: "build-started", name: "codegraph" });
    s = projectReducer(s, { type: "index-status", name: "codegraph", status: { state: "absent" } });
    expect(s.mainMode).toBe("absent");
  });

  it("未选中项目的状态回执只更新行，不动主区", () => {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "helix" });
    s = projectReducer(s, {
      type: "index-status",
      name: "codegraph",
      status: { state: "synced", symbolCount: 9 },
    });
    expect(s.mainMode).toBe("graph");
    expect(s.projects.find((p) => p.name === "codegraph")!.status).toBe("synced");
  });
});

const NODES: KgNodeListRow[] = [
  { id: "TR-44", name: "规则甲", kind: "rule", domain: "tech", status: "confirmed", digest: "aaa 队列" },
  { id: "TR-47", name: "规则乙", kind: "rule", domain: "tech", status: "draft", digest: "bbb 行动项" },
  { id: "E-9", name: "实体丙", kind: "entity", domain: "business", status: "confirmed", digest: "aaa 中转" },
  { id: "E-13", name: "实体丁", kind: "entity", domain: null, status: "superseded", digest: "ccc 报告" },
];

describe("kg-model graph 态", () => {
  it("过滤三路叠加：q × kind × status", () => {
    expect(filterRows(NODES, { q: "", kind: "all", status: "all" })).toHaveLength(4);
    expect(filterRows(NODES, { q: "aaa", kind: "all", status: "all" })).toHaveLength(2);
    expect(filterRows(NODES, { q: "", kind: "rule", status: "all" })).toHaveLength(2);
    expect(filterRows(NODES, { q: "", kind: "all", status: "draft" })).toHaveLength(1);
    expect(filterRows(NODES, { q: "aaa", kind: "entity", status: "confirmed" })).toHaveLength(1);
    expect(filterRows(NODES, { q: "zzz", kind: "all", status: "all" })).toHaveLength(0);
  });

  it("P2③ superseded 折叠位：默认折叠；toggle 翻转；过滤/清除不动折叠位", () => {
    // 过滤语义不变：status=all 仍匹配 superseded（折叠只发生在渲染层，读面数据不丢）
    expect(filterRows(NODES, { q: "", kind: "all", status: "all" })).toHaveLength(4);
    expect(filterRows(NODES, { q: "", kind: "all", status: "superseded" })).toHaveLength(1);
    let s = createKgViewState();
    expect(s.supersededOpen).toBe(false); // 默认折叠
    s = kgReducer(s, { type: "toggle-superseded" });
    expect(s.supersededOpen).toBe(true);
    s = kgReducer(s, { type: "filter-status", status: "superseded" });
    expect(s.supersededOpen).toBe(true); // 过滤不动折叠位
    s = kgReducer(s, { type: "clear-filter" });
    expect(s.supersededOpen).toBe(true);
    s = kgReducer(s, { type: "toggle-superseded" });
    expect(s.supersededOpen).toBe(false);
  });

  it("P2③ 默认选中避开 superseded：实体 → 任意 → 全废时回落旧序", () => {
    const SUP_FIRST: KgNodeListRow[] = [
      { id: "E-1", name: "废实体", kind: "entity", domain: null, status: "superseded", digest: "" },
      { id: "E-2", name: "现行实体", kind: "entity", domain: null, status: "confirmed", digest: "" },
      { id: "TR-1", name: "规则", kind: "rule", domain: null, status: "confirmed", digest: "" },
    ];
    expect(pickInitial(SUP_FIRST)?.id).toBe("E-2"); // 首实体 superseded → 让位现行实体
    expect(pickInitial(NODES)?.id).toBe("E-9"); // 既有口径：首选现行实体
    const ALL_SUP: KgNodeListRow[] = [
      { id: "TR-1", name: "废规则", kind: "rule", domain: null, status: "superseded", digest: "" },
      { id: "E-1", name: "废实体", kind: "entity", domain: null, status: "superseded", digest: "" },
    ];
    expect(pickInitial(ALL_SUP)?.id).toBe("E-1"); // 全 superseded → 回落旧序（实体优先）
    expect(pickInitial([])).toBeUndefined();
  });

  it("列表回执置 success + 默认选中（initialSel）；迟到 detail 丢弃", () => {
    let s = createKgViewState();
    s = kgReducer(s, { type: "list-result", total: 4, nodes: NODES, initialSel: "E-9" });
    expect(s.view).toBe("success");
    expect(s.sel).toBe("E-9");
    expect(s.detailLoading).toBe(true);
    s = kgReducer(s, {
      type: "detail-result",
      detail: {
        id: "TR-44", name: "规则甲", kind: "rule", domain: "tech", status: "confirmed",
        digest: "", body: "", anchors: [], relations: [],
        supersede: { history: [], current: { id: "TR-44", name: "规则甲", kind: "rule", digestFirstLine: "" } },
        log: [],
      },
    });
    expect(s.detail).toBeNull(); // sel≠回执 id → 丢弃
  });

  it("报告纯通知面（无 resolved 状态链）；面板起步态映射", () => {
    const report = { iterationId: "i1", entries: [{}, {}] } as never;
    let s = createKgViewState();
    s = kgReducer(s, { type: "report-result", report });
    expect(s.report).toBe(report);
    expect(panelStateOf("absent")).toBe("synced"); // graph 态面板不呈现 absent（主区消化）
    expect(panelStateOf("building")).toBe("building");
    expect(panelStateOf("degraded")).toBe("degraded");
  });

  it("选中即跳详情：report 态重选同节点仅切 tab 不重拉；异节点重拉", () => {
    let s = createKgViewState();
    s = kgReducer(s, { type: "list-result", total: 4, nodes: NODES, initialSel: "E-9" });
    s = kgReducer(s, { type: "detail-result", detail: DETAIL_E9 });
    s = kgReducer(s, { type: "tab", tab: "report" });
    // report 态点回已选中节点：切回详情，不重拉（detail 保留）
    s = kgReducer(s, { type: "select-node", id: "E-9" });
    expect(s.tab).toBe("detail");
    expect(s.detail).toBe(DETAIL_E9);
    expect(s.detailLoading).toBe(false);
    // 切异节点：重拉（detail 清空置 loading）
    s = kgReducer(s, { type: "select-node", id: "TR-47" });
    expect(s.sel).toBe("TR-47");
    expect(s.detail).toBeNull();
    expect(s.detailLoading).toBe(true);
  });

  it("list 刷新不重置当前选中/详情（initialSel 仅首载生效）", () => {
    let s = createKgViewState();
    s = kgReducer(s, { type: "list-result", total: 4, nodes: NODES, initialSel: "E-9" });
    s = kgReducer(s, { type: "select-node", id: "TR-47" });
    s = kgReducer(s, { type: "detail-result", detail: DETAIL_TR47 });
    // 转正后 list 回读（带 initialSel）：选中与详情保持，不被默认选中打回
    s = kgReducer(s, { type: "list-result", total: 4, nodes: NODES, initialSel: "E-9" });
    expect(s.sel).toBe("TR-47");
    expect(s.detail).toBe(DETAIL_TR47);
    expect(s.detailLoading).toBe(false);
  });

  it("转正回执：列表行状态翻转 + 详情置 loading（重发 detail 刷新）", () => {
    let s = createKgViewState();
    s = kgReducer(s, { type: "list-result", total: 4, nodes: NODES });
    s = kgReducer(s, { type: "select-node", id: "TR-47" });
    s = kgReducer(s, {
      type: "detail-result",
      detail: {
        id: "TR-47", name: "规则乙", kind: "rule", domain: "tech", status: "draft",
        digest: "", body: "", anchors: [], relations: [],
        supersede: { history: [], current: { id: "TR-47", name: "规则乙", kind: "rule", digestFirstLine: "" } },
        log: [],
      },
    });
    s = kgReducer(s, { type: "confirm-applied", id: "TR-47", status: "confirmed" });
    expect(s.all.find((n) => n.id === "TR-47")!.status).toBe("confirmed");
    expect(s.detail?.status).toBe("confirmed");
    expect(s.detailLoading).toBe(true);
  });
});
