// @vitest-environment jsdom
/**
 * P-1 ProjectPage 组件测试（F5.0 单页 master-detail + F5.1~F5.5 graph 态；
 * TDD RED 清单：左栏两段与折叠/主区四态/CTA 冷启动/过滤叠加/转正门控两步/
 * 纯通知报告/AD-16 反向断言）。
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
    body: "## 写入路径\n\n描述段落。\n\n- 写入路径经 {{E-9}} 中转",
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
    },
    {
      kind: "knowledge_change", sev: "ok", label: "知识变化",
      body: "本迭代你把报告生成改为段库装配。",
      refs: { nodes: [], symbols: [] },
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
  /** T3.2 kg-bootstrap 批五命令发送面（produce 分组/修正/连带）。 */
  bootstrapCreate: { project: string }[];
  bootstrapProduce: { project: string }[];
  nodeUpdate: { project: string; nodeId: string; digest?: string; body?: string }[];
  nodeSupersede: { project: string; nodeId: string; reason: string }[];
  bootstrapImpact: { project: string; nodeId: string }[];
  /** C1 kg 维护批两命令发送面（清空图谱 / 删除索引）。 */
  graphPurge: { project: string }[];
  indexDelete: { project: string }[];
  /** W2-E/W2-F 体检面两命令发送面（健康拉取 / 发起语义体检）。 */
  health: { project: string }[];
  reviewCreate: { project: string }[];
  /** 台账读面三件套：kg.candidates.list 发送面（status 过滤形态透传）。 */
  candidatesList: { project: string; status?: string }[];
}

const sent: Sent = {
  projects: 0, list: [], detail: [], report: 0, confirm: [], index: [],
  bootstrapCreate: [], bootstrapProduce: [], nodeUpdate: [], nodeSupersede: [], bootstrapImpact: [],
  graphPurge: [], indexDelete: [], health: [], reviewCreate: [], candidatesList: [],
};
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
      sendKgBootstrapCreate: (payload: { project: string }) => {
        sent.bootstrapCreate.push(payload);
        return true;
      },
      sendKgBootstrapProduce: (payload: { project: string }) => {
        sent.bootstrapProduce.push(payload);
        return true;
      },
      sendKgNodeUpdate: (payload: { project: string; nodeId: string; digest?: string; body?: string }) => {
        sent.nodeUpdate.push(payload);
        return true;
      },
      sendKgNodeSupersede: (payload: { project: string; nodeId: string; reason: string }) => {
        sent.nodeSupersede.push(payload);
        return true;
      },
      sendKgBootstrapImpact: (payload: { project: string; nodeId: string }) => {
        sent.bootstrapImpact.push(payload);
        return true;
      },
      sendKgGraphPurge: (payload: { project: string }) => {
        sent.graphPurge.push(payload);
        return true;
      },
      sendKgIndexDelete: (payload: { project: string }) => {
        sent.indexDelete.push(payload);
        return true;
      },
      sendKgHealth: (payload: { project: string }) => {
        sent.health.push(payload);
        return true;
      },
      sendKgReviewCreate: (payload: { project: string }) => {
        sent.reviewCreate.push(payload);
        return true;
      },
      sendKgCandidatesList: (payload: { project: string; status?: string }) => {
        sent.candidatesList.push(payload);
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

import ProjectPage, { resetRememberedProjectForTest } from "./ProjectPage";

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

function ui() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <ProjectPage path="/project" onOpenTasks={() => {}} />
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
  sent.bootstrapCreate = [];
  sent.bootstrapProduce = [];
  sent.nodeUpdate = [];
  sent.nodeSupersede = [];
  sent.bootstrapImpact = [];
  sent.graphPurge = [];
  sent.indexDelete = [];
  sent.health = [];
  sent.reviewCreate = [];
  sent.candidatesList = [];
  resetRememberedProjectForTest();
});

describe("F5.0 左栏项目域与主区状态机", () => {
  it("初始：主区 empty 空态 + 左栏项目列表段 + 项目行可选中无按钮", () => {
    ui();
    expect(screen.getByText("从左侧选择项目")).toBeTruthy();
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

  it("选中 synced → 自动折叠窄轨 + 主区 graph；点竖排名展开可反复且不改主区；点已选中行仅折叠不重置", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    // 折叠轨 + 主区 graph 头
    expect(qs('[data-pj-rail="collapsed"]')).not.toBeNull();
    expect(qs('[data-kg-head]')!.textContent).toContain("知识图谱 · helix");
    // 头部 = 标题 + 索引紧凑形态（只读/迭代 chip 已移除）
    expect(qs('[data-kg-head]')!.textContent).not.toContain("只读");
    expect(qs('[data-kg-head]')!.textContent).not.toContain("iter-20260825-11fo");
    expect(qs('[data-kg-head] [data-kg-index-panel]')).not.toBeNull();
    expect(qs('[data-kg-workspace]')).not.toBeNull();
    // 窄轨无 ☰ 按钮：竖排项目名即展开触发（title 挂在 rail-name 上）
    expect(qs(".pj-rail-btn")).toBeNull();
    expect(qs(".pj-rail-name").getAttribute("title")).toBe("展开项目域");
    // 点竖排名展开：恢复两段列表，主区保持 graph
    fireEvent.click(screen.getByTitle("展开项目域"));
    expect(qs('[data-pj-domain]')).not.toBeNull();
    expect(qs('[data-kg-workspace]')).not.toBeNull();
    // 再点已选中行 → 仅折叠（graph 不重置：kg-head 仍在）
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getAllByText("helix")[0]!.closest(".pj-row")!);
    expect(qs('[data-pj-rail="collapsed"]')).not.toBeNull();
    expect(qs('[data-kg-workspace]')).not.toBeNull();
    // 键盘可达：窄轨项目名 Enter/Space 展开
    fireEvent.keyDown(qs(".pj-rail-name"), { key: "Enter" });
    expect(qs('[data-pj-domain]')).not.toBeNull();
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
    // 尚无 progress 回执（buildProgress 仅乐观占位）→ 不确定态，无假「0 / 0」
    expect(qs(".pj-build-panel")!.textContent).toContain("构建中…");
    expect(qs(".pj-build-panel")!.textContent).not.toMatch(/0\s*\/\s*0/);
    expect(qs(".pj-build-panel .kg-progress-fill")!.className).toContain("indeterminate");
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

  it("building 无真实进度（{state:\"building\"} 仅此）→ 主区/左栏行不确定态；progress 到位后转 N/M", () => {
    ui();
    feedProjects();
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("codegraph").closest(".pj-row")!);
    fireEvent.click(screen.getByText("构建索引"));
    expect(qs('[data-pj-main="building"]')).not.toBeNull();
    // 真实 daemon building 回执不带 progress → 主区仍不确定态（无「0 / 0」「0%」假数据）
    feed("kg.index.status.result", { state: "building" });
    expect(qs(".pj-build-panel")!.textContent).toContain("构建中…");
    expect(qs(".pj-build-panel")!.textContent).not.toMatch(/0\s*\/\s*0/);
    expect(qs(".pj-build-panel")!.textContent).not.toContain("0%");
    expect(qs(".pj-build-panel .kg-progress-fill")!.className).toContain("indeterminate");
    expect(qs(".pj-build-panel .kgv-ip-sub")!.textContent).toContain("codegraph 机械抽取中（仅代码层）…");
    // 左栏行次行同样不确定态（展开验证）
    fireEvent.click(screen.getByTitle("展开项目域"));
    const row = qs('.pj-row[data-name="codegraph"]');
    expect(row.textContent).toContain("构建中…");
    expect(row.textContent).not.toMatch(/0\s*\/\s*0/);
    // progress 到位 → N/M 现状不变
    feed("kg.index.status.result", { state: "building", progress: { done: 12, total: 26 } });
    expect(qs(".pj-build-panel")!.textContent).toContain("12 / 26 符号");
    expect(row.textContent).toContain("12 / 26 符号");
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
  it("F5.1 行形态 + draft 高亮 + superseded 默认折叠/可展开 + 三路过滤叠加 + 计数行 + 空态清除", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    const list = qs('[data-kg-list]')!;
    // P2③ superseded 默认折叠：默认 3 行（E-13 不在列），折叠徽标行在场
    expect(list.querySelectorAll(".kgv-row")).toHaveLength(3);
    expect(list.querySelector('.kgv-row[data-id="E-13"]')).toBeNull();
    expect(within(list).getAllByText("规则").length).toBeGreaterThan(0);
    expect(within(list).getAllByText("实体").length).toBeGreaterThan(0);
    const draftRow = list.querySelector('.kgv-row[data-id="TR-47"]')!;
    expect(draftRow.className).toContain("draft");
    // 折叠徽标行（计数）+ 展开后 superseded 行入列（降档样式）+ 再收起
    expect(qs('[data-kg-sup-toggle]')!.textContent).toBe("已取代 1 条 · 展开 ▾");
    fireEvent.click(qs('[data-kg-sup-toggle]')!);
    expect(list.querySelectorAll(".kgv-row")).toHaveLength(4);
    expect(list.querySelector('.kgv-row[data-id="E-13"]')!.className).toContain("superseded");
    expect(qs('[data-kg-sup-toggle]')!.textContent).toBe("已取代 1 条 · 收起 ▴");
    fireEvent.click(qs('[data-kg-sup-toggle]')!);
    expect(list.querySelectorAll(".kgv-row")).toHaveLength(3);
    // 裸 id 不作为可见文本（AD-16）
    expect(list.textContent).not.toMatch(/TR-\d+|E-\d+/);
    // 计数行：matched 含 superseded（过滤语义不变，折叠不吞计数）
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
    // 关键词仅命中 superseded：不落空态（折叠徽标行在场可展开，匹配计数如实）
    fireEvent.change(qs('[data-kg-q]')!, { target: { value: "报告" } });
    expect(screen.queryByText("没有匹配的节点")).toBeNull();
    expect(qs('[data-kg-count]')!.textContent).toBe("4 节点 · 匹配 1");
    expect(qs('[data-kg-sup-toggle]')!.textContent).toBe("已取代 1 条 · 展开 ▾");
    fireEvent.change(qs('[data-kg-q]')!, { target: { value: "" } });
    // 状态 seg 选「已取代」= 显式过滤：无折叠徽标行，superseded 全量直显
    fireEvent.click(within(qs('[data-kg-seg-status]')!).getByText("已取代"));
    expect(list.querySelectorAll(".kgv-row")).toHaveLength(1);
    expect(list.querySelector('.kgv-row[data-id="E-13"]')).not.toBeNull();
    expect(document.querySelector("[data-kg-sup-toggle]")).toBeNull();
  });

  it("F5.2 详情：头卡+正文 body 单段 md 渲染（标题/列表/{{ref}} 替换）/锚点 dead 标记/关系跳转/日志最新在上", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    const pane = qs('[data-kg-detail]')!;
    for (const sec of ["正文", "锚点", "关系", "supersede 链", "变更日志"]) {
      expect(within(pane).getAllByText(sec).length).toBeGreaterThan(0);
    }
    // 锚点 dead 标记 + 等宽符号 + 路径:行号
    expect(within(pane).getByText(/⚠ 失效/).textContent).toContain("符号已不存在");
    expect(within(pane).getByText("apps/daemon/src/services/ChatService.ts:309")).toBeTruthy();
    // 正文单段 md 渲染：## → h2；- → li；{{E-9}} → **『Steer 队列』**（无裸 id、无标记残留）
    const body = pane.querySelector("[data-kg-body]")!;
    expect(body.querySelector("h2")!.textContent).toBe("写入路径");
    const li = body.querySelector("li")!;
    expect(li.textContent).toContain("写入路径经");
    expect(li.querySelector("strong")!.textContent).toBe("『Steer 队列』");
    expect(body.textContent).not.toContain("{{");
    // 关系跳转：点 data-goto → 发 kg.node.detail
    fireEvent.click(pane.querySelector('.kg-rel-row [data-goto="E-9"]')!);
    expect(sent.detail.at(-1)).toEqual({ project: "helix", id: "E-9" });
    // 日志最新在上
    const logs = [...pane.querySelectorAll(".kg-log-t")].map((x) => x.textContent);
    expect(logs[0]).toContain("锚点失效");
  });

  it("F5.3 报告：四类条目 glyph + 纯通知面（零交互装置、refs 不跳转、无计数徽章）", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    fireEvent.click(qs('[data-tab="report"]')!);
    const pane = qs('[data-kg-report]')!;
    expect(within(pane).getByText(/失效锚点 ⚠/)).toBeTruthy();
    expect(within(pane).getByText(/知识变化 ✓/)).toBeTruthy();
    // 待决计数徽章随选项消失一并移除
    expect(document.querySelector("[data-kg-report-count]")).toBeNull();
    // 通知面非审核面：无 radio 行动项 / 已处理 / 撤销 / 清零横幅
    expect(pane.querySelectorAll('[data-kg-opt]')).toHaveLength(0);
    expect(pane.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(document.querySelector("[data-kg-report-clear]")).toBeNull();
    // refs 纯信息展示：引用在场但点击不跳转（不发 detail、仍停报告 tab）
    expect(pane.querySelector(".kg-nref")).not.toBeNull();
    const before = sent.detail.length;
    fireEvent.click(pane.querySelector(".kg-nref")!);
    expect(sent.detail.length).toBe(before);
    expect(qs("[data-kg-pane]")!.getAttribute("data-kg-pane")).toBe("report");
    // 疑似措辞由数据面承载（本用例无 info 条目——措辞断言归 F 层 mock 全集）
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

  it("F5.5 索引状态紧凑形态（kgv-head 右侧）：degraded 起步（徽章+重新构建）→ rebuild → building（N/M）→ synced + toast", () => {
    ui();
    feedProjects();
    enterGraph("feifei");
    // 紧凑形态在头部右侧（原左列底部大面板位置移除）
    const panel = qs('[data-kg-head] [data-kg-index-panel]')!;
    expect(panel.getAttribute("data-kg-index-panel")).toBe("degraded");
    const badge = within(panel).getByText("DEGRADED");
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("title")).toContain("符号层落后"); // 影响说明入 title（degraded 永不静默）
    // 重新构建 → rebuild:true + 形态转 building（后续轮询帧 project-only）
    fireEvent.click(within(panel).getByText("重新构建"));
    expect(sent.index.some((p) => p.project === "feifei" && p.rebuild === true)).toBe(true);
    expect(qs('[data-kg-index-panel')!.getAttribute("data-kg-index-panel")).toBe("building");
    // 重建回执未带 progress 前 → 不确定态（仅徽章，无假「0 / 0」）
    expect(qs('[data-kg-index-panel]')!.textContent).toContain("构建中…");
    expect(qs('[data-kg-index-panel]')!.textContent).not.toMatch(/0\s*\/\s*0/);
    feed("kg.index.status.result", { state: "building", progress: { done: 8, total: 44 } });
    // 有 progress → 简短 N/M
    expect(qs('[data-kg-index-panel]')!.textContent).toContain("8 / 44");
    feed("kg.index.status.result", { state: "synced", symbolCount: 44, syncedAt: "2026-08-25T15:00:00+08:00" });
    const panel2 = qs('[data-kg-index-panel]')!;
    expect(panel2.getAttribute("data-kg-index-panel")).toBe("synced");
    expect(panel2.textContent).toContain("已同步");
    expect(qs(".toast-zone")!.textContent).toContain("索引构建完成");
  });
});

describe("全局（AD-16 反向 + 原型标注剥离）", () => {
  it("全页可见文本零 TR-\\d+/E-\\d+ 裸形态；无 data-proto-annotation", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    fireEvent.click(qs('[data-tab="report"]')!);
    // AD-16：全页（左栏+主区+报告）扫可见文本
    expect(qs(".app-layout")!.textContent).not.toMatch(/\b(TR|E)-\d+\b/);
    // 原型标注剥离（反向断言）
    expect(document.querySelectorAll("[data-proto-annotation]").length).toBe(0);
    expect(document.querySelectorAll("[data-route-note]").length).toBe(0);
    // 页面级无主题切换钮（归全局导航栏 IconRail 单钮）
    expect(document.querySelectorAll("[data-theme-toggle]").length).toBe(0);
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

describe("会话内项目记忆（模块级内存态）", () => {
  it("选中后离开再进：清单到位自动恢复选中（免重选，走点选同路径）", () => {
    const first = ui();
    feedProjects();
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("helix").closest(".pj-row")!);
    expect(qs("[data-ctx-proj]")!.textContent).toBe("helix");
    first.unmount(); // 离开 /project（组件卸载，记忆留存）

    ui(); // 再进：清单未到位仍 empty，不抢先选中
    expect(screen.getByText("从左侧选择项目")).toBeTruthy();
    const listBefore = sent.list.length;
    feedProjects();
    // 自动恢复：header chip 回来 + 主区进 graph（KgViewer 重挂发起 kg.list）
    expect(qs("[data-ctx-proj]")!.textContent).toBe("helix");
    expect(sent.list.length).toBeGreaterThan(listBefore);
    expect(sent.list.some((p) => p.project === "helix")).toBe(true);
  });

  it("记忆项目已从新清单消失 → 保持 empty 不强行选中（记忆仅提示非权威）", () => {
    const first = ui();
    feedProjects();
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("helix").closest(".pj-row")!);
    first.unmount();

    ui();
    feed("kg.projects.result", {
      projects: PROJECTS.filter((p) => p.name !== "helix"),
    } satisfies KgProjectsResultPayload);
    expect(screen.getByText("从左侧选择项目")).toBeTruthy();
    expect(qs("[data-ctx-proj]")).toBeNull();
  });

  it("workspace_changed 后记忆作废：新域清单到位不自动恢复（同名项目也不选）", () => {
    ui();
    feedProjects();
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("helix").closest(".pj-row")!);
    feedWorkspace("workspace_changed", { root: "/ws/two" });
    feedProjects(); // 新域清单（helix 同名在列也不恢复——记忆已随项目域作废）
    expect(qs("[data-ctx-proj]")).toBeNull();
    expect(screen.getByText("从左侧选择项目")).toBeTruthy();
  });
});

// ═══ T3.2 kg-bootstrap 扩面（R-11~R-16/R-18：入口准入 + 产出呈现 + 修正 + 连带）═══

/** 扩面项目清单：legacy（synced + nodeCount 0 → 入口可发起）/ helix（非空 → 静默）。 */
const BOOT_PROJECTS: KgProjectRow[] = [
  { name: "helix", path: "/ws/helix", status: "synced", symbolCount: 56, nodeCount: 17, syncedAt: "2026-08-25T14:32:00+08:00" },
  { name: "legacy", path: "/ws/legacy", status: "synced", symbolCount: 43, nodeCount: 0, syncedAt: "2026-08-25T14:32:00+08:00" },
  { name: "wiring", path: "/ws/wiring", status: "synced", symbolCount: 7, nodeCount: 0, bootstrapRunning: true }, // P0① 运行中位
];

/** 产出分组夹具（任务 → L0/L1 两阶段 → 两批次 → 三节点）。 */
const PRODUCE_GROUPS = [
  {
    jobId: "job-9",
    title: "legacy 知识图谱创建",
    stages: [
      {
        layer: "L0",
        name: "L0 核心层",
        batches: [
          {
            batchId: "b-1",
            scope: "批次：架构基线与全局规范",
            nodes: [
              {
                nodeId: "TR-B1", name: "连接私有读面规则", kind: "rule", status: "confirmed",
                digest: "页面私有数据走听众转发，零 store 写入。\n第二行 digest。",
                body: "正文段：页面私有数据走听众转发。",
                anchors: [{ symbol: "kgListenersRef", path: "apps/shell/src/entities/session/SessionContext.tsx", line: 306 }],
                rationale: "会话与页面读面解耦。",
                origin: { taskTitle: "legacy 知识图谱创建", batchScope: "批次：架构基线与全局规范" },
              },
            ],
          },
        ],
      },
      {
        layer: "L1",
        name: "L1 领域层",
        batches: [
          {
            batchId: "b-2",
            scope: "批次：图谱域",
            nodes: [
              {
                nodeId: "E-B2", name: "图谱查看器", kind: "entity", status: "confirmed",
                digest: "graph 态单页 master-detail。",
                body: "正文段：graph 态单页 master-detail 组件。",
                anchors: [],
                rationale: "V-3 单页裁决。",
                origin: { taskTitle: "legacy 知识图谱创建", batchScope: "批次：图谱域" },
              },
            ],
          },
        ],
      },
    ],
  },
];

function feedBootProjects() {
  feed("kg.projects.result", { projects: BOOT_PROJECTS } satisfies KgProjectsResultPayload);
}

describe("T3.2 bootstrap 入口准入与任务内容卡（R-11/R-12）", () => {
  it("知识层非空项目主区无入口（静默）；空知识层 synced 项目入口卡出现（准入行+三阶段计划+启动钮）", () => {
    ui();
    feedBootProjects();
    // helix（nodeCount 17）→ graph 态无入口卡
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("helix").closest(".pj-row")!);
    feed("kg.list.result", { total: 0, matched: 0, nodes: [] });
    feed("kg.change.report.result", REPORT);
    feed("kg.index.status.result", { state: "synced", symbolCount: 56, syncedAt: "2026-08-25T14:32:00+08:00" });
    expect(qs('[data-boot-entry]')).toBeNull();
    // legacy（nodeCount 0）→ 入口卡出现（选中后自动折叠窄轨，先展开再选）
    fireEvent.click(screen.getByTitle("展开项目域"));
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("legacy").closest(".pj-row")!);
    feed("kg.list.result", { total: 0, matched: 0, nodes: [] });
    feed("kg.change.report.result", REPORT);
    feed("kg.index.status.result", { state: "synced", symbolCount: 43, syncedAt: "2026-08-25T14:32:00+08:00" });
    const entry = qs('[data-boot-entry="ready"]');
    expect(entry).not.toBeNull();
    expect(entry.textContent).toContain("准入条件");
    expect(entry.textContent).toContain("L0 核心层");
    expect(entry.textContent).toContain("L1 领域层");
    expect(entry.textContent).toContain("L2 实体层");
    expect(entry.querySelector("[data-launch-btn]")).not.toBeNull();
  });

  it("absent 项目出引导态（前置条件徽章 + 构建钮串联冷启动链）", () => {
    ui();
    feedProjects(); // codegraph absent
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("codegraph").closest(".pj-row")!);
    expect(qs('[data-boot-entry="guide"]')).not.toBeNull();
    expect(qs('[data-boot-entry="guide"]')!.textContent).toContain("前置条件未满足");
    fireEvent.click(screen.getByText("构建索引"));
    expect(sent.index.some((p) => p.project === "codegraph" && p.rebuild === true)).toBe(true);
  });

  it("启动 → create 回执 → ok-strip + 前往任务页出口；入口卡不再重复发命令", () => {
    ui();
    feedBootProjects();
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("legacy").closest(".pj-row")!);
    feed("kg.list.result", { total: 0, matched: 0, nodes: [] });
    feed("kg.change.report.result", REPORT);
    feed("kg.index.status.result", { state: "synced", symbolCount: 43, syncedAt: "2026-08-25T14:32:00+08:00" });
    fireEvent.click(qs("[data-launch-btn]")!);
    expect(sent.bootstrapCreate).toEqual([{ project: "legacy" }]);
    expect(qs("[data-boot-launched]")).toBeNull(); // 回执前不出 ok-strip
    feed("kg.bootstrap.create.result", { ok: true, jobId: "job-9" });
    expect(qs('[data-boot-entry="launched"]')).not.toBeNull();
    expect(qs("[data-boot-launched]")!.textContent).toContain("已创建并进入执行");
    expect(qs("[data-goto-tasks]")!.textContent).toContain("前往「任务」页观察");
  });

  it("P0① 运行中项目入口卡 running 态：徽标 + 前往任务页出口，无启动钮/范围输入", () => {
    ui();
    feedBootProjects();
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("wiring").closest(".pj-row")!);
    feed("kg.list.result", { total: 0, matched: 0, nodes: [] });
    feed("kg.change.report.result", REPORT);
    feed("kg.index.status.result", { state: "synced", symbolCount: 7, syncedAt: "2026-08-25T14:32:00+08:00" });
    const entry = qs('[data-boot-entry="running"]');
    expect(entry).not.toBeNull();
    expect(entry.textContent).toContain("图谱构建进行中");
    expect(entry.querySelector("[data-goto-tasks]")).not.toBeNull(); // 「前往『任务』页观察 →」出口
    expect(entry.querySelector("[data-launch-btn]")).toBeNull(); // 无启动钮
    expect(entry.textContent).not.toContain("范围参数"); // 无范围输入行
  });
});

describe("T3.2 产出呈现 / 修正 / 连带（R-13~R-16/R-18）", () => {
  /** 进入 legacy graph 态 + 切到产出 tab（拉取发出 + 分组回执）。 */
  function inProducePane() {
    ui();
    feedBootProjects();
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("legacy").closest(".pj-row")!);
    feed("kg.list.result", { total: 0, matched: 0, nodes: [] });
    feed("kg.change.report.result", REPORT);
    feed("kg.index.status.result", { state: "synced", symbolCount: 43, syncedAt: "2026-08-25T14:32:00+08:00" });
    fireEvent.click(qs('[data-tab="produce"]')!);
    expect(sent.bootstrapProduce).toEqual([{ project: "legacy" }]);
    feed("kg.bootstrap.produce.result", { groups: PRODUCE_GROUPS });
  }

  it("三级分组渲染：任务标题+详情链接 → 阶段 → 批次（n 节点）；节点展开四段与来源", () => {
    inProducePane();
    const pane = qs("[data-produce-pane='success']");
    expect(pane).not.toBeNull();
    expect(pane.textContent).toContain("legacy 知识图谱创建");
    expect(pane.textContent).toContain("任务详情 →");
    expect(pane.textContent).toContain("L0 核心层");
    expect(pane.textContent).toContain("批次：架构基线与全局规范");
    // 节点展开：正文/锚点/为什么存在/来源（AD-16：nodeId 不作可见文本）
    fireEvent.click(within(qs("[data-produce-node]") as HTMLElement).getByText("展开 ▾"));
    const node = qs("[data-produce-node]");
    expect(node.textContent).toContain("正文段：页面私有数据走听众转发。");
    expect(node.textContent).toContain("kgListenersRef");
    expect(node.textContent).toContain("为什么存在");
    expect(node.textContent).toContain("来源：legacy 知识图谱创建 · 批次：架构基线与全局规范");
    expect(node.textContent).not.toContain("TR-B1");
  });

  it("supersede：空理由拦截 → 填理由确认 → 条目翻已废弃 + 理由留史 + 动作钮消失 + impact 刷新标记 + toast 数量", () => {
    inProducePane();
    const node = qs("[data-produce-node]");
    fireEvent.click(within(node).getByText("supersede"));
    expect(qs("[data-sup-box]")).not.toBeNull();
    // 空理由：确认后出拦截提示，不发送
    fireEvent.click(qs("[data-act='supYes']")!);
    expect(qs("[data-sup-empty]")!.textContent).toContain("supersede 需要填写理由");
    expect(sent.nodeSupersede).toEqual([]);
    fireEvent.change(qs("[data-sup-reason]")!, { target: { value: "与现状不符" } });
    fireEvent.click(qs("[data-act='supYes']")!);
    expect(sent.nodeSupersede).toEqual([{ project: "legacy", nodeId: "TR-B1", reason: "与现状不符" }]);
    feed("kg.node.supersede.result", { ok: true });
    feed("kg.bootstrap.impact.result", {
      affected: [{ nodeId: "E-B2", name: "图谱查看器", kind: "entity", digestFirstLine: "graph 态单页。" }],
      count: 1,
    });
    const after = qs("[data-produce-node]");
    expect(after.getAttribute("data-node-status")).toBe("superseded");
    expect(after.textContent).toContain("已 supersede（留史可查）：与现状不符");
    expect(within(after).queryByText("supersede")).toBeNull(); // 动作钮消失
    // 连带标记：E-B2 条目 warning 徽章 + toast 数量；被标记节点状态不变
    const affectedNode = qs('[data-produce-node][data-affected="true"]');
    expect(affectedNode.getAttribute("data-node-status")).toBe("confirmed");
    expect(affectedNode.textContent).toContain("受影响待复核");
    expect(qs(".toast-zone")!.textContent).toContain("1 个下游节点标记「受影响待复核」");
  });

  it("修改：编辑 digest+正文保存 → update 回执原位替换（保持 confirmed）", () => {
    inProducePane();
    const node = qs("[data-produce-node]");
    fireEvent.click(within(node).getByText("修改"));
    fireEvent.change(qs("[data-edit-digest]")!, { target: { value: "修订后的 digest 首行" } });
    fireEvent.click(qs("[data-act='editYes']")!);
    expect(sent.nodeUpdate).toEqual([
      { project: "legacy", nodeId: "TR-B1", digest: "修订后的 digest 首行", body: "正文段：页面私有数据走听众转发。" },
    ]);
    feed("kg.node.update.result", {
      ok: true,
      node: {
        ...PRODUCE_GROUPS[0]!.stages[0]!.batches[0]!.nodes[0]!,
        digest: "修订后的 digest 首行",
      },
    });
    const after = qs("[data-produce-node]");
    expect(after.getAttribute("data-node-status")).toBe("confirmed");
    expect(after.textContent).toContain("修订后的 digest 首行");
  });

  it("无产出空态：空 groups → 「无 bootstrap 产出」+ 说明（R-18）", () => {
    ui();
    feedBootProjects();
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("legacy").closest(".pj-row")!);
    feed("kg.list.result", { total: 0, matched: 0, nodes: [] });
    feed("kg.change.report.result", REPORT);
    feed("kg.index.status.result", { state: "synced", symbolCount: 43, syncedAt: "2026-08-25T14:32:00+08:00" });
    fireEvent.click(qs('[data-tab="produce"]')!);
    feed("kg.bootstrap.produce.result", { groups: [] });
    const pane = qs("[data-produce-pane='empty']");
    expect(pane).not.toBeNull();
    expect(pane.textContent).toContain("无 bootstrap 产出");
    expect(pane.textContent).toContain("按 任务 / 阶段 / 批次 分组");
  });

  it("切项目清旧态：produce 分组/内联态/启动标记全复位（CL-4-T6 联动面）", () => {
    inProducePane();
    feed("kg.bootstrap.create.result", { ok: true, jobId: "job-9" });
    fireEvent.click(qs("[data-produce-node]"));
    expect(qs("[data-produce-pane='success']")).not.toBeNull();
    fireEvent.click(screen.getByTitle("展开项目域"));
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("helix").closest(".pj-row")!);
    feed("kg.list.result", { total: 0, matched: 0, nodes: [] });
    feed("kg.change.report.result", REPORT);
    feed("kg.index.status.result", { state: "synced", symbolCount: 56, syncedAt: "2026-08-25T14:32:00+08:00" });
    // helix 非空 → 无入口卡（静默）；tab 面回到 detail（kgToken 重挂）
    expect(qs("[data-boot-entry]")).toBeNull();
    // 切回 legacy：入口回到 ready（启动标记随切项目复位——bootstrap.launched 清）
    fireEvent.click(screen.getByTitle("展开项目域"));
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("legacy").closest(".pj-row")!);
    feed("kg.list.result", { total: 0, matched: 0, nodes: [] });
    feed("kg.change.report.result", REPORT);
    feed("kg.index.status.result", { state: "synced", symbolCount: 43, syncedAt: "2026-08-25T14:32:00+08:00" });
    expect(qs('[data-boot-entry="ready"]')).not.toBeNull();
  });
});

describe("C1 kg 维护批（清空图谱 + 删除索引 + 空态文案）", () => {
  it("purge 两步确认（危险文案）→ 取消不发命令 → 确认发出 kg.graph.purge → 回执后四面刷新 + 空态呈现", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    // 第一步：点开确认条——文案含「不可恢复」与「运行中任务时不可用」说明
    fireEvent.click(qs("[data-kg-purge]"));
    const box = qs("[data-kg-purge-confirm]");
    expect(box.textContent).toContain("不可恢复");
    expect(box.textContent).toContain("运行中的知识创建任务时不可用");
    // 取消：不发命令
    fireEvent.click(within(box).getByText("取消"));
    expect(qs("[data-kg-purge-confirm]")).toBeNull();
    expect(sent.graphPurge).toEqual([]);
    // 第二步：确认 → 命令发出
    fireEvent.click(qs("[data-kg-purge]"));
    fireEvent.click(within(qs("[data-kg-purge-confirm]")).getByText("确认清空"));
    expect(sent.graphPurge).toEqual([{ project: "helix" }]);
    const before = { list: sent.list.length, report: sent.report, index: sent.index.length, produce: sent.bootstrapProduce.length, projects: sent.projects };
    feed("kg.graph.purge.result", { purged: true, nodesRemoved: 4, symbolsRemoved: 56, filesRemoved: 3 });
    expect(qs(".toast-zone")!.textContent).toContain("已清空图谱");
    // 四面刷新：列表 / 报告 / 索引态 / 产出 + 左栏项目行（mock 回调每次渲染
    // 新身份——挂载 effect 会随重渲染补发，断言下界不钉死精确增量）
    expect(sent.list.length).toBeGreaterThan(before.list);
    expect(sent.report).toBeGreaterThan(before.report);
    expect(sent.index.length).toBeGreaterThan(before.index);
    expect(sent.bootstrapProduce.length).toBe(before.produce + 1);
    expect(sent.projects).toBe(before.projects + 1);
    // 空态呈现：图谱区（全库无节点专属文案，无「清除过滤」钮）
    feed("kg.list.result", { total: 0, matched: 0, nodes: [] });
    const emptyAll = qs("[data-kg-empty-all]");
    expect(emptyAll.textContent).toContain("无知识节点");
    expect(emptyAll.textContent).toContain("尚未发起过知识创建任务，或图谱已被清空");
    // 变化报告空态
    feed("kg.change.report.result", { iterationId: "iter-20260825-11fo", entries: [] });
    fireEvent.click(qs('[data-tab="report"]'));
    expect(qs("[data-kg-report-empty]").textContent).toContain("无变化报告内容");
    // 产出呈现空态（产出已被清理口径）
    fireEvent.click(qs('[data-tab="produce"]'));
    feed("kg.bootstrap.produce.result", { groups: [] });
    expect(qs("[data-produce-pane='empty']").textContent).toContain("尚未发起过知识创建任务，或产出已被清理");
  });

  it("purge 门禁回执（kg.graph.purge_blocked）→ err toast + 单飞解锁可重试", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    fireEvent.click(qs("[data-kg-purge]"));
    fireEvent.click(within(qs("[data-kg-purge-confirm]")).getByText("确认清空"));
    expect(sent.graphPurge).toEqual([{ project: "helix" }]);
    feed("connection.error", { code: "kg.graph.purge_blocked", message: "存在运行中的 kg-bootstrap 任务：清空不可用" });
    expect(qs(".toast-zone")!.textContent).toContain("清空图谱未通过");
    // 解锁后可重试（确认条可再开、命令可再发）
    fireEvent.click(qs("[data-kg-purge]"));
    fireEvent.click(within(qs("[data-kg-purge-confirm]")).getByText("确认清空"));
    expect(sent.graphPurge.length).toBe(2);
  });

  it("index 删除按钮（synced/degraded 均与重建区并排）+ 两步确认 → kg.index.delete → absent 徽章", () => {
    ui();
    feedProjects();
    enterGraph("helix");
    // synced 态：删除按钮出现；两步确认
    fireEvent.click(qs("[data-kg-index-delete]"));
    const box = qs("[data-kg-index-delete-confirm]");
    expect(box.textContent).toContain("知识图谱内容保留");
    fireEvent.click(within(box).getByText("确认删除"));
    expect(sent.indexDelete).toEqual([{ project: "helix" }]);
    feed("kg.index.delete.result", { deleted: true, state: "absent", watcherStopped: true });
    expect(qs(".toast-zone")!.textContent).toContain("已删除索引");
    // 面板翻 absent 徽章（不静默不假造同步态）
    feed("kg.index.status.result", { state: "absent" });
    expect(qs('[data-kg-index-panel="absent"]').textContent).toContain("未建索引");
    // building 态不开放删除；degraded 态与重建并排（先展开折叠域再切项目）
    fireEvent.click(screen.getByTitle("展开项目域"));
    enterGraph("feifei");
    expect(qs("[data-kg-rebuild]")).not.toBeNull();
    expect(qs("[data-kg-index-delete]")).not.toBeNull();
  });
});

// ═══ W2-F 体检面板运行态（kg.projects 行 reviewRunning：服务端为准，
//      组件重挂后仍持正确态——bootstrapRunning 入口卡 running 同构）═══

/** 体检面项目清单：helix（无运行任务 → 可发起）/ auditing（reviewRunning → 运行态）。 */
const REVIEW_PROJECTS: KgProjectRow[] = [
  { name: "helix", path: "/ws/helix", status: "synced", symbolCount: 56, nodeCount: 17, syncedAt: "2026-08-25T14:32:00+08:00" },
  { name: "auditing", path: "/ws/auditing", status: "synced", symbolCount: 30, nodeCount: 5, syncedAt: "2026-08-25T14:32:00+08:00", reviewRunning: true },
];

/** 健康空态夹具（零冲突零孤儿——面板 ready 态最小形状）。 */
const HEALTH_EMPTY = {
  conflicts: [],
  orphans: [],
  orphanCount: 0,
  index: { state: "synced", symbolCount: 56, syncedAt: "2026-08-25T14:32:00+08:00" },
  candidates: { pending: 0, deferred: 0, applied: 0, discarded: 0 },
};

describe("W2-F 体检面板运行态（reviewRunning 行标志）", () => {
  /** 进指定项目 graph 态并切到 health tab（拉取发出 + 健康回执就绪）。 */
  function inHealthPane(name: "helix" | "auditing") {
    ui();
    feed("kg.projects.result", { projects: REVIEW_PROJECTS } satisfies KgProjectsResultPayload);
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText(name).closest(".pj-row")!);
    feed("kg.list.result", { total: 0, matched: 0, nodes: [] });
    feed("kg.change.report.result", REPORT);
    feed("kg.index.status.result", { state: "synced", symbolCount: 30, syncedAt: "2026-08-25T14:32:00+08:00" });
    fireEvent.click(qs('[data-tab="health"]')!);
    expect(sent.health).toEqual([{ project: name }]); // 首进拉取一次
    feed("kg.health.result", HEALTH_EMPTY);
  }

  it("reviewRunning 行 → 运行态：运行中徽标 + 观察出口，无启动钮", () => {
    inHealthPane("auditing");
    const sec = qs("[data-kg-health-review]");
    expect(sec).not.toBeNull();
    expect(qs("[data-review-running]")).not.toBeNull();
    expect(sec.textContent).toContain("体检任务进行中");
    expect(sec.querySelector("[data-goto-tasks]")).not.toBeNull(); // 「前往『任务』页观察 →」出口
    expect(sec.querySelector("[data-review-launch-btn]")).toBeNull(); // 无启动钮——不可再发起
    // 未发起过本视图回执 → ok-strip 不出现（运行态 ≠ 本视图刚发起）
    expect(qs("[data-review-launched]")).toBeNull();
  });

  it("无运行任务行 → 发起入口在：启动钮 + 说明，无运行态条", () => {
    inHealthPane("helix");
    const sec = qs("[data-kg-health-review]");
    expect(sec).not.toBeNull();
    expect(qs("[data-review-launch-btn]")).not.toBeNull();
    expect(qs("[data-review-running]")).toBeNull();
    expect(qs("[data-review-running-badge]")).toBeNull();
  });

  it("发起 → 回执 → ok-strip + kg.projects 重拉（行标志权威化）", () => {
    inHealthPane("helix");
    const projectsBefore = sent.projects;
    fireEvent.click(qs("[data-review-launch-btn]")!);
    expect(sent.reviewCreate).toEqual([{ project: "helix" }]);
    expect(qs("[data-review-launched]")).toBeNull(); // 回执前不出 ok-strip
    feed("kg.review.create.result", { ok: true, jobId: "job-r1" });
    expect(qs("[data-review-launched]")).not.toBeNull();
    expect(qs("[data-review-launched]")!.textContent).toContain("体检任务已发起");
    expect(qs("[data-goto-tasks]")!.textContent).toContain("前往『任务』页观察");
    expect(sent.projects).toBe(projectsBefore + 1); // 发起成功重拉行数据——reviewRunning 即时置位
  });
});

// ── 候选台账查看面板（台账读面三件套之三：kg.candidates.list 数据面；只读零裁决） ──

describe("候选台账面板（health tab 内：列表 + 四态徽章过滤联动 + 选中展开详情）", () => {
  const CAND_ROWS = [
    { id: "CAND-3", title: "候选丙", status: "applied" as const, kind: "sediment", targetNode: null, deferAge: 0, createdAt: "2026-09-02T10:00:00.000Z", body: "changeType: 新增\nname: 规则丙" },
    { id: "CAND-2", title: "候选乙", status: "deferred" as const, kind: "sediment", targetNode: null, deferAge: 2, createdAt: "2026-09-01T09:00:00.000Z", body: "" },
    { id: "CAND-1", title: "候选甲", status: "pending" as const, kind: "sediment", targetNode: "TR-7", deferAge: 0, createdAt: "2026-08-31T08:00:00.000Z", body: "changeType: 修改\nreason: 口径已演进" },
  ];

  /** 进 health tab 并装配台账回执（首进即拉全量）。 */
  function inCandPanel() {
    ui();
    feedProjects();
    fireEvent.click(within(qs('[aria-label="项目列表"]')!).getByText("helix").closest(".pj-row")!);
    feed("kg.list.result", { total: 0, matched: 0, nodes: [] });
    feed("kg.change.report.result", REPORT);
    feed("kg.index.status.result", { state: "synced", symbolCount: 56, syncedAt: "2026-08-25T14:32:00+08:00" });
    fireEvent.click(qs('[data-tab="health"]')!);
    expect(sent.health).toEqual([{ project: "helix" }]);
    expect(sent.candidatesList).toEqual([{ project: "helix" }]); // 首进 health tab 同窗口拉一次（全量）
    feed("kg.health.result", HEALTH_EMPTY); // 徽章渲染前提（体检面板数据就绪）
    feed("kg.candidates.list.result", { total: 3, rows: CAND_ROWS });
  }

  it("列表渲染（title/status 徽章/created_at）+ 只读零裁决（无任何裁决按钮）", () => {
    inCandPanel();
    const panel = qs("[data-kg-cand-panel]");
    expect(panel).not.toBeNull();
    const items = panel!.querySelectorAll("[data-cand-id]");
    expect(items).toHaveLength(3);
    expect(panel!.textContent).toContain("候选甲");
    expect(panel!.textContent).toContain("候选乙");
    expect(panel!.textContent).toContain("候选丙");
    expect(panel!.textContent).toContain("共 3 条");
    // 只读：面板内无裁决动作（applied/discarded/deferred 决定按钮不存在——
    // 过滤按钮是查看语义非写语义，不算裁决）
    for (const btn of panel!.querySelectorAll("button")) {
      expect(btn.hasAttribute("data-cand-filter")).toBe(true);
    }
    // 未展开行不渲染 body / targetNode
    expect(panel!.textContent).not.toContain("口径已演进");
    expect(panel!.textContent).not.toContain("TR-7");
  });

  it("选中行展开 body 全文 + 目标节点；再点收起", () => {
    inCandPanel();
    fireEvent.click(qs('[data-cand-id="CAND-1"]')!);
    const detail = qs("[data-cand-detail]");
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toContain("目标节点：TR-7");
    expect(detail!.textContent).toContain("changeType: 修改");
    expect(detail!.textContent).toContain("reason: 口径已演进");
    fireEvent.click(qs('[data-cand-id="CAND-1"]')!);
    expect(qs("[data-cand-detail]")).toBeNull(); // 再点收起
  });

  it("四态徽章点击 → 设过滤重拉（体检面板与台账面板过滤态联动高亮）", () => {
    inCandPanel();
    fireEvent.click(qs("[data-cand-count='pending']")!);
    expect(sent.candidatesList).toEqual([{ project: "helix" }, { project: "helix", status: "pending" }]);
    expect((qs("[data-cand-count='pending']") as HTMLElement).className).toContain("active");
    expect((qs("[data-cand-filter='pending']") as HTMLElement).className).toContain("active");
    // 回执零行 → 空态
    feed("kg.candidates.list.result", { total: 0, rows: [] });
    expect(qs('[data-kg-cand="empty"]')!.textContent).toContain("暂无候选条目");
    // 面板过滤按钮切回 all（status 不携带）
    fireEvent.click(qs("[data-cand-filter='all']")!);
    expect(sent.candidatesList[2]).toEqual({ project: "helix" });
  });

  it("体检面板四态计数直渲（health 回执）+ deferred 行展示暂缓次数", () => {
    inCandPanel();
    feed("kg.health.result", { ...HEALTH_EMPTY, candidates: { pending: 1, deferred: 2, applied: 0, discarded: 0 } });
    const sec = qs("[data-kg-health-candidates]");
    expect(sec!.textContent).toContain("待审 1");
    expect(sec!.textContent).toContain("暂缓 2");
    const deferredRow = qs('[data-cand-id="CAND-2"]');
    expect(deferredRow!.textContent).toContain("第 2 次暂缓");
  });
});
