/**
 * P-1 bootstrap 扩面纯函数面单测（CL-1 F1.1 准入 + CL-4 F4.1~F4.3 呈现/修正；
 * T3.2 TDD RED 清单：准入四态判定矩阵 / 修正面内联态互斥 / 切项目清旧态 /
 * 产出回执三态 / 条目修正回写 / 连带标记）。
 *
 * 准入机械定义（contracts/kg-bootstrap-api.md §1）：显示 bootstrap 入口 ⟺
 * indexStatus ∈ {synced, degraded} 且 nodeCount === 0（nodeCount 缺省视为
 * 非空）；absent → 引导态；building → 构建中；已有图谱 → 静默不渲染。
 */
import { describe, expect, it } from "vitest";
import type { KgProjectRow, KgProduceGroupDto, KgProduceNodeDto } from "@helix/protocol";
import {
  bootstrapEntryMode,
  createProjectPageState,
  projectReducer,
  type ProjectPageState,
} from "./project-model";

const ROWS: KgProjectRow[] = [
  { name: "helix", path: "/ws/helix", status: "synced", symbolCount: 56, nodeCount: 0 },
  { name: "web-access", path: "/ws/web-access", status: "degraded", degradedNote: "锚精度降级" },
  { name: "pi-src", path: "/ws/pi-src", status: "synced", symbolCount: 81, nodeCount: 81 },
  { name: "sandpile", path: "/ws/sandpile", status: "absent" },
  { name: "rising", path: "/ws/rising", status: "building" },
  { name: "legacy", path: "/ws/legacy", status: "synced", symbolCount: 12 }, // nodeCount 缺省 = 未知
];

function loaded(): ProjectPageState {
  return projectReducer(createProjectPageState(), { type: "list-result", projects: ROWS });
}

function nodeOf(nodeId: string, over: Partial<KgProduceNodeDto> = {}): KgProduceNodeDto {
  return {
    nodeId,
    name: `节点 ${nodeId}`,
    kind: "rule",
    status: "confirmed",
    digest: "digest 首行",
    body: "正文段。",
    anchors: [{ symbol: "sym", path: "src/a.ts", line: 12 }],
    rationale: "来源 + 存在理由",
    origin: { taskTitle: "helix 知识图谱创建", batchScope: "批次：全局规范" },
    ...over,
  };
}

function groupOf(nodes: KgProduceNodeDto[]): KgProduceGroupDto[] {
  return [
    {
      jobId: "job-1",
      title: "helix 知识图谱创建",
      stages: [
        {
          layer: "L0",
          name: "L0 核心层",
          batches: [{ batchId: "b-1", scope: "批次：全局规范", nodes }],
        },
      ],
    },
  ];
}

describe("bootstrapEntryMode 准入四态判定（CL-1-T8 机械定义）", () => {
  it("synced + 知识层为空 → 可发起；启动叠加 → 已启动", () => {
    expect(bootstrapEntryMode(ROWS[0]!, false)).toBe("ready");
    expect(bootstrapEntryMode(ROWS[0]!, true)).toBe("launched");
  });

  it("degraded + 知识层为空 → 可发起（warning 条由 degraded 标记另行渲染）", () => {
    // web-access 行无 nodeCount？——degraded 行缺 nodeCount = 未知 = 视为非空 → 不显示
    expect(bootstrapEntryMode({ status: "degraded", nodeCount: 0 }, false)).toBe("ready");
  });

  it("absent → 引导态；building → 构建中", () => {
    expect(bootstrapEntryMode(ROWS[3]!, false)).toBe("guide");
    expect(bootstrapEntryMode(ROWS[4]!, false)).toBe("building");
  });

  it("已有图谱（nodeCount>0）→ 静默不渲染；nodeCount 缺省 = 未知 = 视为非空", () => {
    expect(bootstrapEntryMode(ROWS[2]!, false)).toBe("hidden");
    expect(bootstrapEntryMode(ROWS[5]!, false)).toBe("hidden");
    // 缺省即使 degraded 也不显示（未知 ≠ 空）
    expect(bootstrapEntryMode({ status: "degraded" }, false)).toBe("hidden");
  });

  it("启动标记不改变 guide/building/hidden 态（launched 仅叠加在 ready 上）", () => {
    expect(bootstrapEntryMode(ROWS[3]!, true)).toBe("guide");
    expect(bootstrapEntryMode(ROWS[4]!, true)).toBe("building");
    expect(bootstrapEntryMode(ROWS[2]!, true)).toBe("hidden");
  });
});

describe("bootstrapEntryMode running 态（P0① 双启动防护：bootstrapRunning 优先）", () => {
  const RUNNING_READY: KgProjectRow = { name: "helix", path: "/ws/helix", status: "synced", symbolCount: 56, nodeCount: 0, bootstrapRunning: true };
  const RUNNING_FULL: KgProjectRow = { name: "pi-src", path: "/ws/pi-src", status: "synced", symbolCount: 81, nodeCount: 81, bootstrapRunning: true };
  const RUNNING_BUILDING: KgProjectRow = { name: "rising", path: "/ws/rising", status: "building", bootstrapRunning: true };

  it("bootstrapRunning=true 优先于其他条件：ready/launched/hidden/building 位全让位", () => {
    expect(bootstrapEntryMode(RUNNING_READY, false)).toBe("running");
    expect(bootstrapEntryMode(RUNNING_READY, true)).toBe("running"); // 会话内启动标记也让位（任务确在跑）
    expect(bootstrapEntryMode(RUNNING_FULL, false)).toBe("running"); // 优先于 hidden（窗口期后产出中仍可见出口）
    expect(bootstrapEntryMode(RUNNING_BUILDING, false)).toBe("running");
  });

  it("bootstrapRunning 缺省/false → 既有四态不动（旧 daemon 兼容）", () => {
    expect(bootstrapEntryMode({ status: "synced", nodeCount: 0 }, false)).toBe("ready");
    expect(bootstrapEntryMode(ROWS[0]!, false)).toBe("ready"); // 旧行无字段 = 无任务在跑
  });
});

describe("bootstrap 入口启动标记与产出呈现状态", () => {
  it("bootstrap-launched 置位（启动成功回执）", () => {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "helix" });
    expect(s.bootstrap.launched).toBe(false);
    s = projectReducer(s, { type: "bootstrap-launched" });
    expect(s.bootstrap.launched).toBe(true);
  });

  it("produce-loading → 空结果 → empty；有分组 → success（三态互斥）", () => {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "pi-src" });
    expect(s.produce.view).toBe("loading");
    s = projectReducer(s, { type: "produce-result", groups: [] });
    expect(s.produce.view).toBe("empty");
    s = projectReducer(s, { type: "produce-loading" });
    expect(s.produce.view).toBe("loading");
    s = projectReducer(s, { type: "produce-result", groups: groupOf([nodeOf("TR-1")]) });
    expect(s.produce.view).toBe("success");
    expect(s.produce.groups).toHaveLength(1);
  });
});

describe("修正面内联态互斥（CL-4-T6）", () => {
  function inProduce(): ProjectPageState {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "pi-src" });
    s = projectReducer(s, { type: "produce-result", groups: groupOf([nodeOf("TR-1"), nodeOf("E-2")]) });
    return s;
  }

  it("开 supersede 理由框 → 编辑框清；反之亦然（互斥，开一个清其余）", () => {
    let s = inProduce();
    s = projectReducer(s, { type: "produce-inline-open", kind: "edit", nodeId: "TR-1" });
    expect(s.produce.inline).toEqual({ kind: "edit", nodeId: "TR-1" });
    s = projectReducer(s, { type: "produce-inline-open", kind: "supersede", nodeId: "E-2" });
    expect(s.produce.inline).toEqual({ kind: "supersede", nodeId: "E-2" });
    s = projectReducer(s, { type: "produce-inline-open", kind: "edit", nodeId: "E-2" });
    expect(s.produce.inline).toEqual({ kind: "edit", nodeId: "E-2" });
  });

  it("编辑面打开即展开节点；关闭内联面清空；展开互不干扰", () => {
    let s = inProduce();
    s = projectReducer(s, { type: "produce-inline-open", kind: "edit", nodeId: "TR-1" });
    expect(s.produce.openNodes["TR-1"]).toBe(true);
    s = projectReducer(s, { type: "produce-inline-close" });
    expect(s.produce.inline).toBeNull();
    expect(s.produce.openNodes["TR-1"]).toBe(true); // 展开态独立保留
    s = projectReducer(s, { type: "produce-toggle-node", nodeId: "TR-1" });
    expect(s.produce.openNodes["TR-1"]).toBeUndefined();
  });
});

describe("切项目清旧态（CL-4-T6：launched/内联态/展开/标记全复位）", () => {
  it("切项目后 bootstrap.launched 与 produce 全部回到初始", () => {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "helix" });
    s = projectReducer(s, { type: "bootstrap-launched" });
    s = projectReducer(s, { type: "produce-result", groups: groupOf([nodeOf("TR-1")]) });
    s = projectReducer(s, { type: "produce-inline-open", kind: "supersede", nodeId: "TR-1" });
    s = projectReducer(s, { type: "produce-toggle-node", nodeId: "TR-1" });
    s = projectReducer(s, { type: "produce-affected", nodeIds: ["E-2", "E-9"] });
    expect(s.bootstrap.launched).toBe(true);
    expect(s.produce.inline).not.toBeNull();
    expect(s.produce.affected).toEqual({ "E-2": true, "E-9": true });

    s = projectReducer(s, { type: "select-project", name: "sandpile" });
    expect(s.bootstrap.launched).toBe(false);
    expect(s.produce.view).toBe("loading");
    expect(s.produce.groups).toEqual([]);
    expect(s.produce.inline).toBeNull();
    expect(s.produce.openNodes).toEqual({});
    expect(s.produce.affected).toEqual({});
  });

  it("workspace-reset 同样复位 bootstrap/produce（重绑后项目域作废）", () => {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "helix" });
    s = projectReducer(s, { type: "bootstrap-launched" });
    s = projectReducer(s, { type: "produce-result", groups: groupOf([nodeOf("TR-1")]) });
    s = projectReducer(s, { type: "workspace-reset" });
    expect(s.bootstrap.launched).toBe(false);
    expect(s.produce.view).toBe("loading");
  });
});

describe("修正回执回写与连带标记（CL-4-T3/T4 数据面）", () => {
  function inProduce(): ProjectPageState {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "pi-src" });
    s = projectReducer(s, { type: "produce-result", groups: groupOf([nodeOf("TR-1"), nodeOf("E-2")]) });
    return s;
  }

  it("produce-node-updated：条目原位替换（保持分组位置）", () => {
    let s = inProduce();
    s = projectReducer(s, {
      type: "produce-node-updated",
      node: nodeOf("E-2", { digest: "修订后的 digest", body: "修订后的正文。" }),
    });
    const nodes = s.produce.groups[0]!.stages[0]!.batches[0]!.nodes;
    expect(nodes.map((n) => n.nodeId)).toEqual(["TR-1", "E-2"]);
    expect(nodes[1]!.digest).toBe("修订后的 digest");
    expect(nodes[1]!.status).toBe("confirmed"); // 修改保持 confirmed
  });

  it("produce-node-superseded：条目翻已废弃 + 理由留史 + 内联面关闭", () => {
    let s = inProduce();
    s = projectReducer(s, { type: "produce-inline-open", kind: "supersede", nodeId: "TR-1" });
    s = projectReducer(s, { type: "produce-node-superseded", nodeId: "TR-1", reason: "与现状不符" });
    const node = s.produce.groups[0]!.stages[0]!.batches[0]!.nodes[0]!;
    expect(node.status).toBe("superseded");
    expect(node.supersedeReason).toBe("与现状不符");
    expect(s.produce.inline).toBeNull();
  });

  it("produce-affected：只标记不改变节点状态（无任何自动写语义）", () => {
    let s = inProduce();
    s = projectReducer(s, { type: "produce-affected", nodeIds: ["E-2"] });
    expect(s.produce.affected).toEqual({ "E-2": true });
    const node = s.produce.groups[0]!.stages[0]!.batches[0]!.nodes[1]!;
    expect(node.status).toBe("confirmed"); // 被标记节点状态本身不变
  });
});
