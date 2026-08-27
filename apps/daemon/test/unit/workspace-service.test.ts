/**
 * WorkspaceService 单元（W1 workspace 绑定闭环）。
 *
 * 覆盖面（brief 验收 2 全分支）：
 * - 校验：不存在 / 非目录 / 危险根（文件系统根 + homedir）/ realpath 规范化
 *   （symlink 消解 /tmp → /private/tmp）；
 * - open：成功（rebind + KV + 广播 + projects 透传）/ 幂等（同 root 状态零变
 *   + 仍广播一次 + 不重复写 KV）/ 活跃 agent 拒绝；
 * - MRU：去重 + 上限 8 + 最新在前；
 * - restore：无 KV → 未绑定无 notice；有效 current → 绑定（rebind 效应）；
 *   无效 current → 未绑定 + notice；
 * - bindCwd（CLI 例外条款）：绑定注入的 cwd、不校验、不持久化、不广播；
 * - get：recents 惰性探测标 valid（失效不删除）。
 *
 * IO 全 fake（application 层零直接 fs 的注入面验证）：kv 内存实现 +
 * fs 端口假实现 + buildStack/startSync 计数替身。
 */
import { describe, expect, test } from "bun:test";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import {
  WorkspaceService,
  type WorkspaceFsPort,
  type WorkspaceStack,
} from "../../src/application/services/workspace/WorkspaceService";

/** 内存 KV（写入即留存；restore 读面）。 */
class FakeKv implements RuntimeConfigPort {
  readonly map = new Map<string, string>();
  get(key: string): string | undefined {
    return this.map.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
}

/** 可编程 fs 端口：realpath 映射表 + 可读目录集合。 */
function makeFs(opts: {
  realpaths?: Record<string, string>;
  readableDirs?: Set<string>;
  homeDir?: string;
  fsRoot?: string;
}): WorkspaceFsPort {
  return {
    realpath: (p) => opts.realpaths?.[p],
    isReadableDir: (p) => opts.readableDirs?.has(p) ?? false,
    homeDir: () => opts.homeDir ?? "/home/tester",
    fsRoot: () => opts.fsRoot ?? "/",
  };
}

/** 栈替身：计数 build/dispose + 固定 projects 行。 */
interface StackSpy {
  builtRoots: string[];
  disposed: number;
}

function makeRig() {
  const kv = new FakeKv();
  const spy: StackSpy = { builtRoots: [], disposed: 0 };
  const broadcasts: string[] = [];
  let activeAgent = false;
  const stackOf = (root: string): WorkspaceStack => ({
    viewerService: {} as never,
    projectService: { listProjects: () => [{ name: root, path: root, status: "absent" as const }] },
    queryService: {} as never,
    writeService: {} as never,
    syncService: {} as never,
    attachmentService: {} as never,
    dispose: () => {
      spy.disposed += 1;
    },
  });
  const stacks: WorkspaceStack[] = [];
  function makeService(fsOpts: Parameters<typeof makeFs>[0], more: Partial<ConstructorParameters<typeof WorkspaceService>[0]> = {}) {
    const service = new WorkspaceService({
      kv,
      fs: makeFs(fsOpts),
      clock: { now: () => "2026-08-27T00:00:00.000Z" },
      cwd: () => "/cli/cwd",
      buildStack: (root) => {
        spy.builtRoots.push(root);
        const s = stackOf(root);
        stacks.push(s);
        return s;
      },
      startSync: () => ({ stop: () => {} }),
      broadcast: (root) => broadcasts.push(root),
      hasActiveAgent: () => activeAgent,
      ...more,
    });
    return { service, stacks };
  }
  return { kv, spy, broadcasts, stacks, makeService, setActive: (v: boolean) => (activeAgent = v) };
}

const WS_A = "/private/tmp/ws-a";
const WS_B = "/private/tmp/ws-b";

describe("WorkspaceService：校验规则全分支", () => {
  test("路径不存在 → WORKSPACE_E_INVALID_ROOT（文案含原路径）", async () => {
    const rig = makeRig();
    const { service } = rig.makeService({ readableDirs: new Set([WS_A]) });
    const out = await service.open("/nope/missing");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("WORKSPACE_E_INVALID_ROOT");
      expect(out.error.message).toContain("/nope/missing");
    }
    expect(service.isBound()).toBe(false);
  });

  test("存在但非目录（realpath 命中、可读目录集合不含）→ 拒绝", async () => {
    const rig = makeRig();
    const { service } = rig.makeService({ realpaths: { "/tmp/file": WS_A }, readableDirs: new Set([]) });
    const out = await service.open("/tmp/file");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("WORKSPACE_E_INVALID_ROOT");
  });

  test("危险根：文件系统根 → 拒绝并引导选具体目录", async () => {
    const rig = makeRig();
    const { service } = rig.makeService({ realpaths: { "/": "/" }, readableDirs: new Set(["/"]) });
    const out = await service.open("/");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("WORKSPACE_E_INVALID_ROOT");
      expect(out.error.message).toContain("具体");
    }
  });

  test("危险根：homedir → 拒绝并引导选具体目录", async () => {
    const rig = makeRig();
    const { service } = rig.makeService({
      realpaths: { "/home/tester": "/home/tester" },
      readableDirs: new Set(["/home/tester"]),
      homeDir: "/home/tester",
    });
    const out = await service.open("/home/tester");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("WORKSPACE_E_INVALID_ROOT");
      expect(out.error.message).toContain("具体");
    }
  });

  test("realpath 规范化：symlink 路径绑定到规范形（/tmp → /private/tmp）", async () => {
    const rig = makeRig();
    const { service } = rig.makeService({
      realpaths: { "/tmp/ws-a": WS_A },
      readableDirs: new Set([WS_A]),
    });
    const out = await service.open("/tmp/ws-a");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.root).toBe(WS_A);
    expect(service.boundRoot()).toBe(WS_A);
    expect(rig.kv.get("workspace.current")).toBe(WS_A);
  });
});

describe("WorkspaceService：open 语义", () => {
  test("成功：rebind（建栈）+ KV 落盘 + 广播 + projects 透传", async () => {
    const rig = makeRig();
    const { service } = rig.makeService({ realpaths: { [WS_A]: WS_A }, readableDirs: new Set([WS_A]) });
    const out = await service.open(WS_A);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.projects.map((p) => p.name)).toEqual([WS_A]);
    }
    expect(rig.spy.builtRoots).toEqual([WS_A]);
    expect(rig.broadcasts).toEqual([WS_A]);
    expect(rig.kv.get("workspace.current")).toBe(WS_A);
    const recents = JSON.parse(rig.kv.get("workspace.recents")!) as { root: string; name: string; lastUsedAt: string }[];
    expect(recents).toEqual([{ root: WS_A, name: "ws-a", lastUsedAt: "2026-08-27T00:00:00.000Z" }]);
  });

  test("换绑：旧栈 dispose + 旧 background 停 + 新栈建到新 root", async () => {
    const rig = makeRig();
    const { service, stacks } = rig.makeService({
      realpaths: { [WS_A]: WS_A, [WS_B]: WS_B },
      readableDirs: new Set([WS_A, WS_B]),
    });
    await service.open(WS_A);
    await service.open(WS_B);
    expect(rig.spy.builtRoots).toEqual([WS_A, WS_B]);
    expect(rig.spy.disposed).toBe(1); // 旧栈 dispose 一次
    expect(service.boundRoot()).toBe(WS_B);
    expect(service.stack()).toBe(stacks[1]!);
  });

  test("幂等：同 root 重复 open = 状态零变（不重建不重写 KV）+ 仍广播一次", async () => {
    const rig = makeRig();
    const { service } = rig.makeService({ realpaths: { [WS_A]: WS_A }, readableDirs: new Set([WS_A]) });
    await service.open(WS_A);
    const writesBefore = rig.kv.map.size;
    const out = await service.open(WS_A);
    expect(out.ok).toBe(true);
    expect(rig.spy.builtRoots).toEqual([WS_A]); // 未重建
    expect(rig.spy.disposed).toBe(0);
    expect(rig.kv.map.size).toBe(writesBefore); // 未重写 KV
    expect(rig.broadcasts).toEqual([WS_A, WS_A]); // 仍广播一次（前端对齐用）
  });

  test("活跃 agent 存在 → WORKSPACE_E_ACTIVE_AGENT 拒绝（含指引文案）", async () => {
    const rig = makeRig();
    const { service } = rig.makeService({
      realpaths: { [WS_A]: WS_A, [WS_B]: WS_B },
      readableDirs: new Set([WS_A, WS_B]),
    });
    await service.open(WS_A);
    rig.setActive(true);
    const out = await service.open(WS_B);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("WORKSPACE_E_ACTIVE_AGENT");
      expect(out.error.message).toContain("运行");
    }
    expect(service.boundRoot()).toBe(WS_A); // 状态未变
    rig.setActive(false);
    const retry = await service.open(WS_B);
    expect(retry.ok).toBe(true);
  });
});

describe("WorkspaceService：MRU recents", () => {
  test("去重 + 最新在前 + 上限 8", async () => {
    const rig = makeRig();
    const roots = Array.from({ length: 9 }, (_, i) => `/private/tmp/ws-${i}`);
    const realpaths = Object.fromEntries(roots.map((r) => [r, r]));
    const { service } = rig.makeService({ realpaths, readableDirs: new Set(roots) });
    for (const r of roots) await service.open(r);
    await service.open(roots[0]!); // 回访最旧的 → 升到 MRU 首
    const snap = service.get();
    expect(snap.recents).toHaveLength(8);
    expect(snap.recents[0]!.root).toBe(roots[0]!);
    expect(snap.recents[1]!.root).toBe(roots[8]!); // 第 9 个次新
    expect(snap.recents.some((r) => r.root === roots[1])).toBe(false); // 最旧被挤出
  });
});

describe("WorkspaceService：restore（启动恢复）", () => {
  test("无 KV → 未绑定、无 notice、零建栈（unbound boot 零物化）", async () => {
    const rig = makeRig();
    const { service } = rig.makeService({});
    await service.restore();
    expect(service.isBound()).toBe(false);
    expect(service.stack()).toBe(null);
    expect(rig.spy.builtRoots).toEqual([]);
    const snap = service.get();
    expect(snap.notice).toBeUndefined();
  });

  test("KV current 有效 → 绑定（rebind 效应）+ 不重写 KV", async () => {
    const rig = makeRig();
    rig.kv.map.set("workspace.current", WS_A);
    const { service } = rig.makeService({ realpaths: { [WS_A]: WS_A }, readableDirs: new Set([WS_A]) });
    await service.restore();
    expect(service.isBound()).toBe(true);
    expect(rig.spy.builtRoots).toEqual([WS_A]);
    expect(rig.kv.map.size).toBe(1); // 未新增写入
    expect(rig.broadcasts).toEqual([]);
  });

  test("KV current 失效（目录已删）→ 未绑定 + notice 说明", async () => {
    const rig = makeRig();
    rig.kv.map.set("workspace.current", "/gone/workspace");
    const { service } = rig.makeService({ realpaths: {}, readableDirs: new Set() });
    await service.restore();
    expect(service.isBound()).toBe(false);
    expect(rig.spy.builtRoots).toEqual([]);
    const snap = service.get();
    expect(snap.notice).toContain("/gone/workspace");
    expect(snap.current).toBe(null);
  });

  test("KV recents 恢复 + get 惰性探测 valid（失效不删除）", async () => {
    const rig = makeRig();
    rig.kv.map.set("workspace.recents", JSON.stringify([
      { root: WS_A, name: "ws-a", lastUsedAt: "2026-08-26T00:00:00.000Z" },
      { root: "/gone/ws", name: "ws", lastUsedAt: "2026-08-25T00:00:00.000Z" },
    ]));
    const { service } = rig.makeService({ realpaths: { [WS_A]: WS_A }, readableDirs: new Set([WS_A]) });
    await service.restore();
    const snap = service.get();
    expect(snap.recents).toHaveLength(2);
    expect(snap.recents[0]).toMatchObject({ root: WS_A, valid: true });
    expect(snap.recents[1]).toMatchObject({ root: "/gone/ws", valid: false });
    // 失效项不自动删除：再次快照仍在
    expect(service.get().recents).toHaveLength(2);
  });
});

describe("WorkspaceService：bindCwd（CLI 例外条款）", () => {
  test("绑定注入的 cwd：不校验、不持久化、不广播", async () => {
    const rig = makeRig();
    // fs 端口对 /cli/cwd 无任何登记（不校验也绑定）
    const { service } = rig.makeService({});
    await service.bindCwd();
    expect(service.isBound()).toBe(true);
    expect(service.boundRoot()).toBe("/cli/cwd");
    expect(rig.kv.map.size).toBe(0); // 不持久化
    expect(rig.broadcasts).toEqual([]); // 不广播
    expect(rig.spy.builtRoots).toEqual(["/cli/cwd"]); // rebind 效应照常（kg 栈可用）
  });
});

describe("WorkspaceService：bindInitial（组合根初始绑定注入面）", () => {
  test("原样绑定（restore 预置等价）：不校验不持久化", async () => {
    const rig = makeRig();
    const { service } = rig.makeService({});
    service.bindInitial(WS_A);
    expect(service.boundRoot()).toBe(WS_A);
    expect(rig.kv.map.size).toBe(0);
    expect(rig.broadcasts).toEqual([]);
    expect(rig.spy.builtRoots).toEqual([WS_A]);
  });
});
