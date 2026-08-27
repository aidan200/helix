// @vitest-environment jsdom
/**
 * P-1 ProjectPage 组件测试（F5.0 单页 master-detail + F5.1~F5.5 graph 态；
 * TDD RED 清单：左栏两段与折叠/主区四态/CTA 冷启动/过滤叠加/转正门控两步/
 * 行动项联动/AD-16 反向断言）。
 *
 * vi.mock SessionContext 先例（TracePage.test.tsx）：kg 六命令发送面捕获
 * + subscribeKgFrames 帧注入回放（页面私有链）。中文断言语言钉 zh-CN。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { EventEnvelope, KgProjectRow } from "@helix/protocol";
import type {
  KgChangeReportResultPayload,
  KgIndexStatusPayload,
  KgListPayload,
  KgNodeConfirmPayload,
  KgNodeDetailPayload,
  KgProjectsResultPayload,
} from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider } from "@/shared/ui/Toast";

// ── SessionContext mock（页面域消费面）─────────────────────

const PROJECTS: KgProjectRow[] = [
  { name: "helix", path: "/ws/helix", status: "synced", symbolCount: 56, nodeCount: 17, syncedAt: "2026-08-25T14:32:00+08:00" },
  { name: "feifei", path: "/ws/feifei", status: "degraded", degradedNote: "符号层落后" },
  { name: "codegraph", path: "/ws/codegraph", status: "absent" },
];

const NODES = [
  { id: "TR-44", name: "四段模板", kind: "rule", domain: "tech", status: "confirmed", digest: "固定四段渲染" },
  { id: "TR-47", name: "行动项规则", kind: "rule", domain: "tech", status: "draft", digest: "条目必须带行动项" },
  { id: "E-9", name: "Steer 队列", kind: "entity", domain: "business", status: "confirmed", digest: "消息中转中枢" },
  { id: "E-13", name: "报告生成器", kind: "entity", domain: null, status: "superseded", digest: "按迭代聚合报告" },
] as const;

function detailOf(id: string): KgNodeDetailPayload {
  const base = {
    id, name: NODES.find((n) => n.id === id)!.name, kind: NODES.find((n) => n.id === id)!.kind,
    domain: NODES.find((n) => n.id === id)!.domain, status: NODES.find((n) => n.id === id)!.status,
    digest: NODES.find((n) => n.id === id)!.digest,
    desc: "描述段落",
    rules: [`写入路径经 {{E-9}} 中转`],
    anchors: [
      { symbol: "injectClosure", path: "apps/daemon/src/services/ChatService.ts", line: 309, state: "dead" },
      { symbol: "publish", path: "libs/steer/src/queue.ts", line: 21, state: "ok" },
    ],
    relations: [{ verb: "中转", peer: { id: "E-9", name: "Steer 队列", kind: "entity", digestFirstLine: "消息中转" } }],
    supersede: { history: [], current: { id, name: NODES.find((n) => n.id === id)!.name, kind: NODES.find((n) => n.id === id)!.kind as "rule" | "entity", digestFirstLine: "" } },
    log: [
      { date: "2026-08-25T09:30:00+08:00", iterationId: "iter-20260825-11fo", eventText: "锚点失效，待人工裁决" },
      { date: "2026-08-24T10:00:00+08:00", iterationId: "iter-20260825-11fo", eventText: "从 md 体系迁移入库（保号）" },
    ],
  };
  return base as unknown as KgNodeDetailPayload;
}

const REPORT: KgChangeReportResultPayload = {
  iterationId: "iter-20260825-11fo",
  entries: [
    {
      kind: "dead_anchor", sev: "warn", label: "失效锚点",
      body: "你删除了会话服务里的方法 `injectClosure`，它是『Steer 队列』的唯一锚点。",
      refs: { nodes: [{ id: "E-9", name: "Steer 队列", kind: "entity", digestFirstLine: "消息中转" }], symbols: [{ name: "injectClosure", path: "apps/daemon/src/services/ChatService.ts", line: 309 }] },
      options: ["重挂新位置", "废弃（留史）"],
    },
    {
      kind: "knowledge_change", sev: "ok", label: "知识变化",
      body: "本迭代你把报告生成改为段库装配。",
      refs: { nodes: [], symbols: [] },
      options: ["确认已阅（归档）"],
    },
  ],
};

interface Sent {
  projects: number;
  list: KgListPayload[];
  detail: KgNodeDetailPayload[];
  report: number;
  confirm: KgNodeConfirmPayload[];
  index: KgIndexStatusPayload[];
}

const sent: Sent = { projects: 0, list: [], detail: [], report: 0, confirm: [], index: [] };
let listeners: ((e: EventEnvelope) => void)[] = [];
/** W4 刷新链：workspace 帧订阅注入位。 */
let wsListeners: ((e: EventEnvelope) => void)[] = [];

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: { conn: "connected", sessionId: null },
      sendKgProjects: () => {
        sent.projects += 1;
        return true;
      },
      sendKgList: (payload: KgListPayload) => {
        sent.list.push(payload);
        return true;
      },
      sendKgNodeDetail: (payload: KgNodeDetailPayload) => {
        sent.detail.push(payload);
        return true;
      },
      sendKgChangeReport: () => {
        sent.report += 1;
        return true;
      },
      sendKgNodeConfirm: (payload: KgNodeConfirmPayload) => {
        sent.confirm.push(payload);
        return true;
      },
      sendKgIndexStatus: (payload: KgIndexStatusPayload) => {
        sent.index.push(payload);
        return true;
      },
      subscribeKgFrames: (cb: (e: EventEnvelope) => void) => {
        listeners.push(cb);
        return () => {
          listeners = listeners.filter((l) => l !== cb);
        };
      },
      subscribeWorkspaceFrames: (cb: (e: EventEnvelope) => void) => {
        wsListeners.push(cb);
        return () => {
          wsListeners = wsListeners.filter((l) => l !== cb);
        };
      },
    }),
  };
});

import ProjectPage from "./ProjectPage";

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

function ui() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <ProjectPage path="/project" />
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

/** querySelector 的 HTMLElement 收窄（jsdom 测试面：目标均为元素节点）。 */
function qs(selector: string): HTMLElement {
  return document.querySelector(selector) as HTMLElement;
}

function feed(type: string, payload: unknown) {
  const frame = { v: "0.11", type, sessionId: "__system__", channel: "kg", payload } as EventEnvelope;
  act(() => {
    for (const l of [...listeners]) l(frame);
  });
}

/** workspace 帧注入（W4 刷新链）。 */
function feedWorkspace(type: string, payload: unknown) {
  const frame = { v: "0.11", type, sessionId: "__system__", channel: "workspace", payload } as EventEnvelope;
  act(() => {
    for (const l of [...wsListeners]) l(frame);
  });
}

function feedProjects() {
  feed("kg.projects.result", { projects: PROJECTS } satisfies KgProjectsResultPayload);
}

/** 进入 graph 态并完成数据面装配（list + 默认 detail + report + index）。 */
function enterGraph(name: "helix" | "feifei") {
  fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText(name).closest(".pj-row")!);
  feed("kg.list.result", { total: NODES.length, matched: NODES.length, nodes: NODES });
  feed("kg.node.detail.result", detailOf("E-9"));
  feed("kg.change.report.result", REPORT);
  feed("kg.index.status.result", name === "helix" ? { state: "synced", symbolCount: 56, syncedAt: "2026-08-25T14:32:00+08:00" } : { state: "degraded", degradedNote: "符号层落后" });
}

afterEach(() => {
  cleanup();
  listeners = [];
  wsListeners = [];
  sent.projects = 0;
  sent.list = [];
  sent.detail = [];
  sent.report = 0;
  sent.confirm = [];
  sent.index = [];
});

describe("F5.0 左栏项目域与主区状态机", () => {
  it("初始：主区 empty 空态 + 左栏两段（项目列表 + 工作树占位空态）+ 项目行可选中无按钮", () => {
    ui();
    expect(screen.getByText("从左侧选择项目")).toBeTruthy();
    expect(qs(".pj-wt-empty")!.textContent).toBe("暂无数据 · 占位");
    expect(qs('[aria-label="项目列表"]')!.querySelectorAll(".pj-row")).toHaveLength(0);
    feedProjects();
    const rows = qs('[aria-label="项目列表"]')!.querySelectorAll(".pj-row");
    expect(rows).toHaveLength(3);
    // 行内无任何按钮（选中即主区切换——无行尾动作）
    for (const r of rows) expect(r.querySelector("button")).toBeNull();
  });

  it("四态徽章与次行：synced=已同步+统计 / degraded=DEGRADED+影响 / absent=未建索引+无边条", () => {
    ui();
    feedProjects();
    const [helix, feifei, codegraph] = [...document.querySelectorAll(".pj-row")] as HTMLElement[];
    expect(within(helix!).getByText("已同步")).toBeTruthy();
    expect(helix!.textContent).toContain("56 符号 · 17 节点");
    expect(within(feifei!).getByText("DEGRADED")).toBeTruthy();
    expect(feifei!.textContent).toContain("符号层落后");
    expect(within(codegraph!).getAllByText("未建索引").length).toBeGreaterThan(0);
    expect(codegraph!.className).not.toContain("st-synced"); // absent 无边条
  });

  it("选中 synced → 自动折叠窄轨 + 主区 graph；☰ 展开可反复且不改主区；点已选中行仅折叠不重置", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    // 折叠轨 + 主区 graph 头
    expect(qs('[data-pj-rail="collapsed"]')).not.toBeNull();
    expect(qs('[data-kg-head]')!.textContent).toContain("知识图谱 · helix");
    expect(qs('[data-kg-workspace]')).not.toBeNull();
    // ☰ 展开：恢复两段列表，主区保持 graph
    fireEvent.click(screen.getByTitle("展开项目域"));
    expect(qs('[data-pj-domain]')).not.toBeNull();
    expect(qs('[data-kg-workspace]')).not.toBeNull();
    // 再点已选中行 → 仅折叠（graph 不重置：kg-head 仍在）
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getAllByText("helix")[0]!.closest(".pj-row")!);
    expect(qs('[data-pj-rail="collapsed"]')).not.toBeNull();
    expect(qs('[data-kg-workspace]')).not.toBeNull();
  });

  it("absent 选中 → 主区空态+构建 CTA → building 进度 → synced → graph 出现 + toast + 左栏徽章同步翻", () => {
    ui();
    feedProjects();
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("codegraph").closest(".pj-row")!);
    expect(qs('[data-pj-main="absent"]')).not.toBeNull();
    expect(screen.getByText("该项目尚未构建知识索引，暂无图谱内容。构建完成后即可在此查看它的知识图谱。")).toBeTruthy();
    // CTA 唯一入口（左栏行无按钮已断言）——rebuild:true 发出后轮询随即启动（project-only 帧）
    fireEvent.click(screen.getByText("构建索引"));
    expect(sent.index.some((p) => p.project === "codegraph" && p.rebuild === true)).toBe(true);
    expect(qs('[data-pj-main="building"]')).not.toBeNull();
    feed("kg.index.status.result", { state: "building", progress: { done: 12, total: 26 } });
    expect(qs(".pj-build-panel")!.textContent).toContain("12 / 26 符号");
    // 左栏行徽章同步翻 building（展开态验证）
    fireEvent.click(screen.getByTitle("展开项目域"));
    expect(within(qs('[aria-label="项目列表"]')!).getAllByText(/构建中/).length).toBeGreaterThan(0);
    feed("kg.index.status.result", { state: "synced", symbolCount: 26, syncedAt: "2026-08-25T15:00:00+08:00" });
    // 若仍选中 → 主区自动进 graph；toast 出现；左栏徽章翻已同步
    expect(qs('[data-pj-main="graph"]')).not.toBeNull();
    expect(qs(".toast-zone")!.textContent).toContain("索引构建完成");
    expect(within(qs('[aria-label="项目列表"]')!).getAllByText("已同步").length).toBeGreaterThan(0);
  });

  it("切项目先清旧态：helix graph → feifei graph（kg-head 项目名切换，旧详情/过滤清空）", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    // 过滤残留制造
    fireEvent.change(qs('[data-kg-q]')!, { target: { value: "队列" } });
    expect(qs('[data-kg-count]')!.textContent).toContain("匹配 1");
    // 展开左栏切 feifei
    fireEvent.click(screen.getByTitle("展开项目域"));
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("feifei").closest(".pj-row")!);
    feed("kg.list.result", { total: NODES.length, matched: NODES.length, nodes: NODES });
    feed("kg.node.detail.result", detailOf("E-9"));
    feed("kg.change.report.result", REPORT);
    feed("kg.index.status.result", { state: "degraded", degradedNote: "符号层落后" });
    expect(qs('[data-kg-head]')!.textContent).toContain("知识图谱 · feifei");
    // 新数据面：过滤清空
    expect((qs('[data-kg-q]') as HTMLInputElement).value).toBe("");
    expect(qs('[data-kg-count]')!.textContent).toContain(`匹配 ${NODES.length}`);
  });
});

describe("graph 态 F5.1~F5.5", () => {
  it("F5.1 行形态 + draft 高亮 + superseded 降档 + 三路过滤叠加 + 计数行 + 空态清除", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    const list = qs('[data-kg-list]')!;
    expect(list.querySelectorAll(".kgv-row")).toHaveLength(4);
    expect(within(list).getAllByText("规则").length).toBeGreaterThan(0);
    expect(within(list).getAllByText("实体").length).toBeGreaterThan(0);
    const draftRow = list.querySelector('.kgv-row[data-id="TR-47"]')!;
    expect(draftRow.className).toContain("draft");
    expect(list.querySelector('.kgv-row[data-id="E-13"]')!.className).toContain("superseded");
    // 裸 id 不作为可见文本（AD-16）
    expect(list.textContent).not.toMatch(/TR-\d+|E-\d+/);
    // 计数行
    expect(qs('[data-kg-count]')!.textContent).toBe("4 节点 · 匹配 4");
    // 类型 seg 过滤
    fireEvent.click(within(qs('[data-kg-seg-kind]')!).getByText("规则"));
    expect(qs('[data-kg-count]')!.textContent).toBe("4 节点 · 匹配 2");
    // 状态 seg 叠加
    fireEvent.click(within(qs('[data-kg-seg-status]')!).getByText("草稿"));
    expect(qs('[data-kg-count]')!.textContent).toBe("4 节点 · 匹配 1");
    // 关键词叠加至零 → 空态 + 清除过滤
    fireEvent.change(qs('[data-kg-q]')!, { target: { value: "zzz" } });
    expect(screen.getByText("没有匹配的节点")).toBeTruthy();
    fireEvent.click(screen.getByText("清除过滤"));
    expect(qs('[data-kg-count]')!.textContent).toBe("4 节点 · 匹配 4");
    // 关键词命中 mark 高亮
    fireEvent.change(qs('[data-kg-q]')!, { target: { value: "队列" } });
    expect(qs('[data-kg-list] mark')!.textContent).toBe("队列");
  });

  it("F5.2 六段详情：头卡+描述/规则（{{ref}} 替换）/锚点 dead 标记/关系跳转/日志最新在上", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    const pane = qs('[data-kg-detail]')!;
    for (const sec of ["描述", "规则", "锚点", "关系", "supersede 链", "变更日志"]) {
      expect(within(pane).getAllByText(sec).length).toBeGreaterThan(0);
    }
    // 锚点 dead 标记 + 等宽符号 + 路径:行号
    expect(within(pane).getByText(/⚠ 失效/).textContent).toContain("符号已不存在");
    expect(within(pane).getByText("apps/daemon/src/services/ChatService.ts:309")).toBeTruthy();
    // 规则内 {{E-9}} → 引用替换（粗体 name + 徽章；无裸 id）
    const nref = pane.querySelector(".kgv-sec-item .kg-nref")!;
    expect(nref.getAttribute("data-goto")).toBe("E-9");
    expect(nref.textContent).toContain("Steer 队列");
    expect(pane.textContent).not.toMatch(/（\{\{|}}）/); // 标记不残留
    // 关系跳转：点 data-goto → 发 kg.node.detail
    fireEvent.click(pane.querySelector('.kg-rel-row [data-goto="E-9"]')!);
    expect(sent.detail.at(-1)).toEqual({ project: "helix", id: "E-9" });
    // 日志最新在上
    const logs = [...pane.querySelectorAll(".kg-log-t")].map((x) => x.textContent);
    expect(logs[0]).toContain("锚点失效");
  });

  it("F5.3 报告：四类条目 glyph + 行动项待决→已处理（可撤销）→计数联动→清零横幅", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    fireEvent.click(qs('[data-tab="report"]')!);
    const pane = qs('[data-kg-report]')!;
    expect(within(pane).getByText(/失效锚点 ⚠/)).toBeTruthy();
    expect(within(pane).getByText(/知识变化 ✓/)).toBeTruthy();
    // tab 计数 = 2 待决
    expect(qs('[data-kg-report-count]')!.textContent).toBe("2 待决");
    // 行动项单选 → 已处理 + 撤销 + 计数联动
    fireEvent.click(within(pane).getAllByLabelText(/重挂新位置|废弃（留史）/)[0]!);
    expect(within(pane).getByText(/已处理：/)).toBeTruthy();
    expect(qs('[data-kg-report-count]')!.textContent).toBe("1 待决");
    // 疑似措辞由数据面承载（本用例无 info 条目——措辞断言归 F 层 mock 全集）
    // 撤销 → 回待决
    fireEvent.click(within(pane).getByText("撤销"));
    expect(qs('[data-kg-report-count]')!.textContent).toBe("2 待决");
    // 全部处理 → 清零横幅（仍 success 态）
    const opts = within(pane).getAllByRole("radio");
    for (const o of opts) fireEvent.click(o);
    expect(qs('[data-kg-report-clear]')).not.toBeNull();
    expect(qs('[data-kg-report-count]')!.textContent).toBe("已清零");
  });

  it("F5.4 转正门控与两步确认：draft 渲染/非 draft 静默不渲染/确认走 kg.node.confirm/toast", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    // 默认选中 E-9（confirmed）→ 无转正按钮（静默不渲染非置灰）
    expect(qs('[data-kg-promote]')).toBeNull();
    // 切到 draft 节点 TR-47
    fireEvent.click(qs('.kgv-row[data-id="TR-47"]')!);
    feed("kg.node.detail.result", detailOf("TR-47"));
    const promote = qs('[data-kg-promote]')!;
    expect(promote).not.toBeNull();
    // 第一步：点转正 → 内联确认条（warning 边框）
    fireEvent.click(promote);
    const box = qs('[data-kg-confirm-box]')!;
    expect(box).not.toBeNull();
    // 取消退回（确认条消失，无命令发出）
    fireEvent.click(qs('[data-kg-promote-no]')!);
    expect(qs('[data-kg-confirm-box]')).toBeNull();
    expect(sent.confirm).toHaveLength(0);
    // 第二步：确认 → kg.node.confirm 发出 → 回执 → 徽章翻已确认 + toast + 按钮消失
    fireEvent.click(qs('[data-kg-promote]')!);
    fireEvent.click(qs('[data-kg-promote-yes]')!);
    expect(sent.confirm).toEqual([{ project: "helix", id: "TR-47" }]);
    feed("kg.node.confirm.result", { applied: true, node: { ...NODES[1], status: "confirmed" } });
    // 回执后重发 detail 刷新（daemon 落账日志）
    expect(sent.detail.at(-1)).toEqual({ project: "helix", id: "TR-47" });
    feed("kg.node.detail.result", detailOf("TR-47"));
    expect(qs(".toast-zone")!.textContent).toContain("已转正");
    // 列表行状态翻转（draft 高亮消失）
    expect(qs('.kgv-row[data-id="TR-47"]')!.className).not.toContain("draft");
  });

  it("F5.5 索引面板：degraded 起步（徽章+影响+重新构建）→ rebuild → building → synced + toast", () => {
    ui();
    feedProjects();
    enterGraph("feifei");
    const panel = qs('[data-kg-index-panel]')!;
    expect(panel.getAttribute("data-kg-index-panel")).toBe("degraded");
    expect(within(panel).getByText("DEGRADED")).toBeTruthy();
    expect(panel.textContent).toContain("符号层落后");
    // 重新构建 → rebuild:true + 面板转 building（后续轮询帧 project-only）
    fireEvent.click(within(panel).getByText("重新构建"));
    expect(sent.index.some((p) => p.project === "feifei" && p.rebuild === true)).toBe(true);
    expect(qs('[data-kg-index-panel')!.getAttribute("data-kg-index-panel")).toBe("building");
    feed("kg.index.status.result", { state: "building", progress: { done: 8, total: 44 } });
    feed("kg.index.status.result", { state: "synced", symbolCount: 44, syncedAt: "2026-08-25T15:00:00+08:00" });
    const panel2 = qs('[data-kg-index-panel]')!;
    expect(panel2.getAttribute("data-kg-index-panel")).toBe("synced");
    expect(qs(".toast-zone")!.textContent).toContain("索引构建完成");
  });
});

describe("全局（AD-16 反向 + 原型标注剥离）", () => {
  it("全页可见文本零 TR-\\d+/E-\\d+ 裸形态；无 data-proto-annotation；主题切换用 helix-theme 键", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    fireEvent.click(qs('[data-tab="report"]')!);
    // AD-16：全页（左栏+主区+报告）扫可见文本
    expect(qs(".app-layout")!.textContent).not.toMatch(/\b(TR|E)-\d+\b/);
    // 原型标注剥离（反向断言）
    expect(document.querySelectorAll("[data-proto-annotation]").length).toBe(0);
    expect(document.querySelectorAll("[data-route-note]").length).toBe(0);
    // 主题切换走既有 helix-theme 键（AF-5）
    localStorage.removeItem("helix-theme");
    fireEvent.click(qs("[data-theme-toggle]")!);
    expect(localStorage.getItem("helix-theme")).toBe("light");
  });
});

describe("W4 workspace_changed 刷新链（项目域 + kg 视图）", () => {
  it("changed 广播 → 页面复位到首拉态 + 重拉 kg.projects（kg 视图随选中清空卸载）", () => {
    ui();
    feedProjects();
    enterGraph("helix"); // 选中 + graph 态（kg 视图装配完成）
    expect(qs("[data-ctx-proj]")!.textContent).toBe("helix"); // 选中在场
    const before = sent.projects;
    feedWorkspace("workspace_changed", { root: "/ws/two" });
    // 重拉动作发生（连接转换重拉同款链）
    expect(sent.projects).toBeGreaterThan(before);
    // 选中/主区复位：回 empty（旧选中在新域不存在——残影零泄漏）
    expect(qs("[data-ctx-proj]")).toBeNull();
    expect(screen.getByText("从左侧选择项目")).toBeTruthy();
    // 新域清单回填：左栏按新数据渲染
    feedProjects();
    expect(qs('[aria-label="项目列表"]')!.querySelectorAll(".pj-row")).toHaveLength(PROJECTS.length);
  });

  it("非 changed 的 workspace 帧 → 不复位不重拉（订阅面单一职责）", () => {
    ui();
    feedProjects();
    const before = sent.projects;
    feedWorkspace("workspace.open.result", { root: "/ws/two", projects: [] });
    expect(sent.projects).toBe(before);
  });
});
