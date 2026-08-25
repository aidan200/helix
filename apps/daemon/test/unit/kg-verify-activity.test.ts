import { describe, expect, test } from "bun:test";
import type { KnowledgeNode, MaterializedAnchor } from "../../src/domain/kg/types";
import {
  sortActivityMismatch,
  type ActivitySignal,
} from "../../src/domain/kg/verify/activity-mismatch";

/**
 * U 层（CL-3.A7）：活跃度错位启发——代码高频变更（churn）× 锚长期未动
 * → 疑似过时排序。启发式非结论：每条输出必含「疑似过时」与
 * 「非结论」限定词（无「疑似」措辞的条目 = violation）。
 */

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function node(id: string, updatedAtDaysAgo: number): KnowledgeNode {
  return {
    id,
    kind: "rule",
    name: id === "TR-1" ? "分层依赖单向" : id === "TR-2" ? "写路径白名单" : id === "TR-3" ? "会话去重" : "其余规则",
    digest: "摘要行",
    body: "",
    domain: "tech",
    layer: null,
    status: "confirmed",
    createdAt: new Date(NOW - 120 * DAY).toISOString(),
    updatedAt: new Date(NOW - updatedAtDaysAgo * DAY).toISOString(),
  };
}

function signal(id: string, updatedAtDaysAgo: number, fileMtimeDaysAgo: number | null, path = "src/hot.ts"): ActivitySignal {
  const anchor: MaterializedAnchor = { nodeId: id, anchorPath: path, anchorSymbol: "foo", anchorKind: "symbol" };
  return {
    node: node(id, updatedAtDaysAgo),
    anchor,
    fileMtime: fileMtimeDaysAgo === null ? null : NOW - fileMtimeDaysAgo * DAY,
  };
}

describe("domain/kg/verify/activity-mismatch：启发式排序（纯函数）", () => {
  test("① 高 churn（文件近期仍改）且知识久未动 → 排前；排序按滞后天数降序", () => {
    const items = sortActivityMismatch(
      [
        signal("TR-2", 30, 2), // lag ≈ 28 天
        signal("TR-1", 60, 1), // lag ≈ 59 天 → 最前
        signal("TR-3", 10, 3), // lag ≈ 7 天 → 最后
      ],
      { now: NOW },
    );
    expect(items.map((i) => i.node.id)).toEqual(["TR-1", "TR-2", "TR-3"]);
    expect(items[0]!.lagMs).toBeGreaterThan(items[1]!.lagMs);
    expect(items[1]!.lagMs).toBeGreaterThan(items[2]!.lagMs);
  });

  test("② CL-3.A7 机械断言：每条输出必含「疑似过时」与「非结论」限定词", () => {
    const items = sortActivityMismatch([signal("TR-1", 60, 1), signal("TR-2", 45, 5)], { now: NOW });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.summary).toContain("疑似过时");
      expect(item.summary).toContain("非结论");
      expect(item.summary).toContain("规则「"); // 节点名（非裸 id）
      expect(item.summary).not.toMatch(/TR-\d+/);
    }
  });

  test("③ 排除面：文件久未改（churn 窗口外）/ 知识新于代码（滞后不足）/ 无文件记录（mtime=null）→ 零输出", () => {
    const items = sortActivityMismatch(
      [
        signal("TR-1", 60, 100), // 文件 100 天未动 → 不在 churn 窗口
        signal("TR-2", 1, 1), // 知识与代码同步（lag=0）
        signal("TR-3", 60, null), // files 表无记录
        signal("TR-4", 40, 3, "src/fresh.ts"), // lag 37 天 → 唯一候选
      ],
      { now: NOW },
    );
    expect(items.map((i) => i.node.id)).toEqual(["TR-4"]);
  });

  test("④ 窗口参数可注入（churnWindowMs/staleGapMs 缺省值存在且可覆盖）", () => {
    // 缺省窗口：churn 30 天 / 滞后 7 天（文件 29 天前改、知识 36 天未动 → lag 恰 7 天，入列）
    const defaultHit = sortActivityMismatch([signal("TR-1", 36, 29)], { now: NOW });
    expect(defaultHit).toHaveLength(1);
    const tightened = sortActivityMismatch([signal("TR-1", 36, 29)], { now: NOW, churnWindowMs: 7 * DAY, staleGapMs: 14 * DAY });
    expect(tightened).toHaveLength(0); // churn 窗口收紧后排除
  });

  test("⑤ 同滞后并列时按节点 id 再按锚路径稳定排序；node 引用含 digestFirstLine", () => {
    const a = signal("TR-2", 60, 1, "src/z.ts");
    const b = signal("TR-1", 60, 1, "src/z.ts");
    const items = sortActivityMismatch([a, b], { now: NOW });
    expect(items.map((i) => i.node.id)).toEqual(["TR-1", "TR-2"]);
    expect(items[0]!.node).toEqual({ id: "TR-1", name: "分层依赖单向", kind: "rule", digestFirstLine: "摘要行" });
    expect(items[0]!.anchor.anchorPath).toBe("src/z.ts");
  });
});
