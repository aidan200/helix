/**
 * P-1 bootstrap 扩面纯函数面单测（CL-1 F1.1 准入；T3.2 TDD RED 清单：
 * 准入四态判定矩阵 / running 态优先 / 启动标记 / 切项目清旧态）。
 *
 * 准入机械定义（contracts/kg-bootstrap-api.md §1）：显示 bootstrap 入口 ⟺
 * indexStatus ∈ {synced, degraded} 且 nodeCount === 0（nodeCount 缺省视为
 * 非空）；absent → 引导态；building → 构建中；已有图谱 → 静默不渲染。
 */
import { describe, expect, it } from "vitest";
import type { KgProjectRow } from "@helix/protocol";
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

describe("bootstrap 入口启动标记", () => {
  it("bootstrap-launched 置位（启动成功回执）", () => {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "helix" });
    expect(s.bootstrap.launched).toBe(false);
    s = projectReducer(s, { type: "bootstrap-launched" });
    expect(s.bootstrap.launched).toBe(true);
  });
});

describe("切项目清旧态（CL-4-T6：launched 复位）", () => {
  it("切项目后 bootstrap.launched 回到初始", () => {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "helix" });
    s = projectReducer(s, { type: "bootstrap-launched" });
    expect(s.bootstrap.launched).toBe(true);

    s = projectReducer(s, { type: "select-project", name: "sandpile" });
    expect(s.bootstrap.launched).toBe(false);
  });

  it("workspace-reset 同样复位 bootstrap（重绑后项目域作废）", () => {
    let s = loaded();
    s = projectReducer(s, { type: "select-project", name: "helix" });
    s = projectReducer(s, { type: "bootstrap-launched" });
    s = projectReducer(s, { type: "workspace-reset" });
    expect(s.bootstrap.launched).toBe(false);
  });
});
