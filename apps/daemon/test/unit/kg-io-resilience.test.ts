import { rmSyncWindowsSafe } from "../helpers/rm-safe";
/**
 * kg IO 韧性批（读面容错 + evict 自愈 + 定位短路）：
 *
 * 事故背景（2026-11-11 会话 087cc66e 磁盘风暴余波）：daemon 进程内单项目
 * kg 连接坏态（SQLITE_IOERR 后不自愈），而 KgQueryService 读面是「for 循环
 * 跨项目聚合」——一个坏库拖垮全部 19 个项目的 kg search/get/affected/
 * candidates，且定位类写操作（addEdge 前置 locateUnique）传了 project 参数
 * 仍全项目扫（过滤在扫描之后）。修复三件：
 * 1. per-project 容错：单库读失败跳过+告警（IOERR 先 evict 重试一次）；
 * 2. KgDatabase.evict：坏连接出缓存，下次懒开自愈重建；
 * 3. locate(nodeId, onlyProject) 短路：指定项目只查该库（写面定位事故路径）。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isIoError } from "../../src/domain/kg/io-error";
import { KgDatabase } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { KgQueryService } from "../../src/application/services/kg/KgQueryService";
import { createKgUpdateTool } from "../../src/adapters/driven/tools/kg-update/KgUpdateTool";
import type { KnowledgeGraphPort } from "../../src/application/ports/outbound/KnowledgeGraphPort";
import type { NodeDetail } from "../../src/domain/kg/types";

const ROOT_A = "/w/projA";
const ROOT_B = "/w/projB";

const ioErr = (): Error => Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
const detailOf = (id: string): NodeDetail => ({ id, name: `节点 ${id}`, kind: "rule" } as unknown as NodeDetail);

/** KnowledgeGraphPort 最小 stub（读面方法按覆写注入）。 */
function graphStub(overrides: Partial<Record<keyof KnowledgeGraphPort, (...args: never[]) => unknown>>): KnowledgeGraphPort {
  return {
    getAttachmentSnapshot: () => ({ nodes: [] }),
    search: () => [],
    getDigestRows: () => [],
    reverseAnchorLookup: () => [],
    getNode: () => null,
    getIndexStatus: () => ({ baseline: "1", symbolCount: 0, degraded: false }),
    listCandidates: () => [],
    ...overrides,
  } as unknown as KnowledgeGraphPort;
}

describe("isIoError 判定", () => {
  test("SQLITE_IOERR 前缀 code / disk I/O error 文案命中；普通错误与非对象不命中", () => {
    expect(isIoError(Object.assign(new Error("x"), { code: "SQLITE_IOERR" }))).toBe(true);
    expect(isIoError(Object.assign(new Error("x"), { code: "SQLITE_IOERR_READ" }))).toBe(true);
    expect(isIoError(new Error("SQLiteError: disk I/O error"))).toBe(true);
    expect(isIoError(new Error("普通逻辑错"))).toBe(false);
    expect(isIoError(undefined)).toBe(false);
    expect(isIoError("disk I/O error")).toBe(false);
  });
});

describe("KgDatabase.evict（坏连接出缓存自愈）", () => {
  test("evict 后再取是新连接；无连接/重复 evict 幂等不抛", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kg-evict-"));
    const db = new KgDatabase();
    try {
      const c1 = db.knowledgeConnection(dir);
      db.evict(dir);
      db.evict(dir); // 幂等
      db.evict("/w/不存在的项目"); // 无连接 no-op
      const c2 = db.knowledgeConnection(dir);
      expect(c2).not.toBe(c1);
    } finally {
      db.closeAll();
      rmSyncWindowsSafe(dir);
    }
  });
});

describe("KgQueryService 读面容错", () => {
  test("locate：单库 IOERR 跳过不拖垮全局——可达库命中照常返回，onIoError 收到坏库", () => {
    const evicted: string[] = [];
    const warns: string[] = [];
    const svc = new KgQueryService({
      graph: graphStub({ getNode: (project: string, id: string) => (project === ROOT_A ? detailOf(id) : (() => { throw ioErr(); })()) }),
      projects: () => [ROOT_A, ROOT_B],
      onIoError: (root) => evicted.push(root),
      logger: { warn: (m) => warns.push(m) },
    });
    const hits = svc.locate("TR-1");
    expect(hits.map((h) => h.project)).toEqual([ROOT_A]);
    expect(evicted).toEqual([ROOT_B]);
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain(ROOT_B);
  });

  test("locate：IOERR evict 后同调用内重试一次——新连接成功则命中恢复（自愈透明）", () => {
    const evicted: string[] = [];
    let calls = 0;
    const svc = new KgQueryService({
      graph: graphStub({
        getNode: (project: string, id: string) => {
          if (project === ROOT_A) return detailOf(id);
          calls += 1;
          if (calls === 1) throw ioErr(); // 第一次：坏连接
          return detailOf(id); // evict 重建后的新连接成功
        },
      }),
      projects: () => [ROOT_A, ROOT_B],
      onIoError: (root) => evicted.push(root),
    });
    const hits = svc.locate("TR-1");
    expect(hits.map((h) => h.project)).toEqual([ROOT_A, ROOT_B]);
    expect(evicted).toEqual([ROOT_B]);
    expect(calls).toBe(2); // 重试发生且只一次
  });

  test("locate：IOERR 重试仍失败降级跳过；非 IOERR 错误同样跳过不炸", () => {
    const svc = new KgQueryService({
      graph: graphStub({
        getNode: (project: string, _id: string) => {
          if (project === ROOT_A) return detailOf("TR-1");
          if (project === ROOT_B) throw ioErr();
          throw new Error("逻辑错误");
        },
      }),
      projects: () => [ROOT_A, ROOT_B, "/w/projC"],
    });
    expect(svc.locate("TR-1").map((h) => h.project)).toEqual([ROOT_A]); // 三库坏二，可达一照常
  });

  test("search/affected/listCandidates：单库 IOERR 同容错——其余库聚合照常", () => {
    const svc = new KgQueryService({
      graph: graphStub({
        search: (project: string) => {
          if (project === ROOT_B) throw ioErr();
          return [{ id: "TR-1", name: "n", kind: "rule", digest: "d", status: "confirmed" }];
        },
        reverseAnchorLookup: (project: string) => {
          if (project === ROOT_B) throw ioErr();
          return [{ nodeId: "TR-1" }];
        },
        listCandidates: (project: string) => {
          if (project === ROOT_B) throw ioErr();
          return [{ id: "CAND-1", title: "t", status: "pending" }];
        },
      }),
      projects: () => [ROOT_A, ROOT_B],
    });
    expect(svc.search("q").map((h) => h.project)).toEqual([ROOT_A]);
    expect(svc.affected("src/x.ts").map((h) => h.project)).toEqual([ROOT_A]);
    expect(svc.listCandidates({}).map((h) => h.project)).toEqual([ROOT_A]);
  });
});

describe("KgQueryService.locate 定位短路", () => {
  test("onlyProject 指定时只查该库（其他库零调用）；该库无命中即空集（不扫别的库）", () => {
    const queried: string[] = [];
    const svc = new KgQueryService({
      graph: graphStub({
        getNode: (project: string, id: string) => {
          queried.push(project);
          return project === ROOT_A ? null : detailOf(id); // 命中在别的库
        },
      }),
      projects: () => [ROOT_A, ROOT_B],
    });
    expect(svc.locate("TR-1", ROOT_A)).toEqual([]); // 指定 A：A 无命中 → 空
    expect(queried).toEqual([ROOT_A]); // B 零调用（短路生效）

    const all = svc.locate("TR-1"); // 无 onlyProject：全扫撞号检测保留
    expect(all.map((h) => h.project)).toEqual([ROOT_B]);
    expect(queried).toEqual([ROOT_A, ROOT_A, ROOT_B]);
  });
});

describe("KgUpdateTool 定位短路接线（事故路径：addEdge 传 project 仍全扫）", () => {
  test("addEdge 带 project 参数 → query.locate 收到 onlyProject（短路定位），不再扫其他库", async () => {
    const locateCalls: Array<{ id: string; only: string | undefined }> = [];
    const writes: string[] = [];
    const tool = createKgUpdateTool({
      query: {
        locate: (id: string, only?: string) => {
          locateCalls.push({ id, only });
          return [{ project: ROOT_A, detail: detailOf(id) }];
        },
      },
      write: {
        write: (project: string, op: unknown) => {
          writes.push(project);
          return { ok: true, nodeId: (op as { srcId?: string }).srcId ?? "TR-9" };
        },
      },
      workspaceRoot: "/w",
      scanProjects: () => [ROOT_A, ROOT_B],
    });
    const result = await tool.execute(
      "tc-1",
      {
        op: "addEdge",
        srcId: "TR-1",
        dstId: "TR-2",
        verb: "dependsOn",
        project: "projA",
      },
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const body = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(body).toContain("已建边");
    expect(locateCalls.length).toBe(2); // src + dst 各一次
    expect(locateCalls.every((c) => c.only === ROOT_A)).toBe(true); // 短路参数到位
    expect(writes).toEqual([ROOT_A]);
  });
});
