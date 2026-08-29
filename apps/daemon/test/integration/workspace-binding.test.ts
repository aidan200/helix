/**
 * workspace 绑定闭环 I 层（W1）：unbound boot 防御契约 + open 重绑效应 +
 * KV 持久化/重启 restore + 广播 + 活跃 agent 拒绝。
 *
 * 形态：真组合根（createTestDaemon，kgWorkspaceRoot: null = 显式 unbound
 * boot 形态——W1 语义演进后的注入面）× loopback WS × tmp workspace 目录。
 * （kg 索引同步纯手动：启动/绑定/换绑零自动触发——2026-08-29 裁决。）
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION } from "@helix/protocol";
import type { Daemon } from "../../src/infrastructure/container";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";

interface Frame {
  v: string;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
}

/** 收帧 loopback WS 客户端（kg-handlers.test.ts 同构）。 */
class TestClient {
  readonly frames: Frame[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev: MessageEvent) => {
      this.frames.push(JSON.parse(String(ev.data)));
    };
  }

  async open(timeoutMs = 3000): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.OPEN, timeoutMs, "WS 连接建立");
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /**
   * 发命令并等回执：点对点结果帧（`<type>.result`）或 error 回执；
   * chat.send 草稿链无结果帧——回执 = session.snapshot（建会话成功）或
   * connection.error（门禁拒绝）。
   */
  async call(type: string, payload: Record<string, unknown>, timeoutMs = 5000): Promise<Frame | null> {
    const replyOf = (f: Frame): boolean =>
      f.type === `${type}.result` || f.type === "connection.error" || (type === "chat.send" && f.type === "session.snapshot");
    const at = this.frames.length;
    this.send({ v: PROTOCOL_VERSION, type, payload });
    await until(
      () => this.frames.slice(at).some(replyOf),
      timeoutMs,
      `等待 ${type}.result / connection.error`,
    );
    return this.frames.slice(at).find(replyOf) ?? null;
  }

  /** 等待某广播帧到达。 */
  async waitFor(type: string, timeoutMs = 5000): Promise<Frame | undefined> {
    await until(() => this.frames.some((f) => f.type === type), timeoutMs, `等待广播 ${type}`);
    return this.frames.find((f) => f.type === type);
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Rig {
  readonly home: string;
  readonly ws1: string;
  readonly ws2: string;
  readonly daemon: Daemon;
  readonly client: TestClient;
  readonly dispose: () => void;
}

async function startRig(opts: { kgWorkspaceRoot?: string | null; engine?: FakeAgentEngine; home?: string } = {}): Promise<Rig> {
  const home = opts.home ?? mkdtempSync(path.join(tmpdir(), "helix-ws-home-"));
  const ws1 = mkdtempSync(path.join(tmpdir(), "helix-ws-one-"));
  const ws2 = mkdtempSync(path.join(tmpdir(), "helix-ws-two-"));
  mkdirSync(path.join(ws1, "alpha"), { recursive: true });
  mkdirSync(path.join(ws1, "beta"), { recursive: true });
  mkdirSync(path.join(ws2, "gamma"), { recursive: true });
  const daemon = await createTestDaemon({
    home,
    engine: opts.engine ?? new FakeAgentEngine({ initialModel: "fake/model", replies: [] }),
    skipConfig: true,
    skipLock: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    ...(opts.kgWorkspaceRoot !== undefined ? { kgWorkspaceRoot: opts.kgWorkspaceRoot } : {}),
  });
  const client = new TestClient(`ws://127.0.0.1:${daemon.ws.port}`);
  await client.open();
  const token = readFileSync(path.join(home, "dev-token"), "utf8");
  client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
  await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
  return {
    home,
    ws1,
    ws2,
    daemon,
    client,
    dispose: () => {
      void client.close();
    },
  };
}

const cleaners: (() => void)[] = [];
afterAll(() => {
  for (const fn of cleaners) fn();
});

describe("workspace 绑定闭环（W1）I 层", () => {
  test("unbound boot：workspace.get 空 + kg 读面空集（非报错）+ 会话创建被拒 + 零 kg 栈物化", async () => {
    const rig = await startRig({ kgWorkspaceRoot: null });
    cleaners.push(rig.dispose);
    try {
      // ① 门禁读面：current null、recents 空、无 notice
      expect(rig.daemon.workspace.isBound()).toBe(false);
      expect(rig.daemon.workspace.stack()).toBe(null); // 零物化：无栈即无扫描/同步/开库通路
      const get = await rig.client.call("workspace.get", {});
      expect(get?.type).toBe("workspace.get.result");
      expect(get?.payload).toEqual({ current: null, recents: [] });

      // ② kg 读面防御契约：空集结果（非报错、非 unimplemented）
      const projects = await rig.client.call("kg.projects", {});
      expect(projects?.type).toBe("kg.projects.result");
      expect(projects?.payload).toEqual({ projects: [] });

      // ③ 会话创建依赖绑定：draft 链拒绝 + 指引文案
      const draft = await rig.client.call("chat.send", { text: "你好", draft: true });
      expect(draft?.type).toBe("connection.error");
      expect((draft?.payload as { code: string }).code).toBe("workspace.unbound");
      expect((draft?.payload as { message: string }).message).toContain("工作空间");
    } finally {
      rig.dispose();
    }
  }, 20000);

  test("open：绑定生效（项目域来自新 root）+ KV 落盘 + 广播 + 栈重绑跟随", async () => {
    const rig = await startRig({ kgWorkspaceRoot: null });
    cleaners.push(rig.dispose);
    try {
      const root1 = realpathSync(rig.ws1);
      const open1 = await rig.client.call("workspace.open", { root: rig.ws1 });
      expect(open1?.type).toBe("workspace.open.result");
      expect(open1?.payload.root).toBe(root1); // realpath 规范化（tmp symlink 消解）
      expect((open1?.payload.projects as { name: string }[]).map((p) => p.name).sort()).toEqual(["alpha", "beta"]);

      // 广播到达：workspace_changed { root }
      const changed = await rig.client.waitFor("workspace_changed");
      expect(changed?.payload).toEqual({ root: root1 });

      // kg 读面跟随新栈：项目域来自 root1
      const projects1 = await rig.client.call("kg.projects", {});
      expect((projects1?.payload.projects as { name: string }[]).map((p) => p.name).sort()).toEqual(["alpha", "beta"]);

      // KV 落盘（current + recents）
      expect(rig.daemon.workspace.get().current).toBe(root1);

      // 换绑：项目域切到 root2
      const root2 = realpathSync(rig.ws2);
      const open2 = await rig.client.call("workspace.open", { root: rig.ws2 });
      expect(open2?.payload.root).toBe(root2);
      expect((open2?.payload.projects as { name: string }[]).map((p) => p.name)).toEqual(["gamma"]);
      const projects2 = await rig.client.call("kg.projects", {});
      expect((projects2?.payload.projects as { name: string }[]).map((p) => p.name)).toEqual(["gamma"]);

      // 绑定后：会话创建放行（draft 链建会话成功——收到快照帧）
      const draft = await rig.client.call("chat.send", { text: "你好", draft: true, model: "fake/model" });
      expect(draft?.type).not.toBe("connection.error");
    } finally {
      rig.dispose();
      await rig.daemon.shutdown();
    }
  }, 20000);

  test("重启 restore：同 home 复起 → 直达绑定（current 恢复 + 项目域可用）", async () => {
    const rig = await startRig({ kgWorkspaceRoot: null });
    cleaners.push(rig.dispose);
    const root1 = realpathSync(rig.ws1);
    const open1 = await rig.client.call("workspace.open", { root: rig.ws1 });
    expect(open1?.type).toBe("workspace.open.result");
    await rig.client.waitFor("workspace_changed");
    rig.dispose();
    await rig.daemon.shutdown();

    // 同 home 复起：KV current 有效 → restore 直达绑定（无需再次 open）
    const rig2 = await startRig({ kgWorkspaceRoot: null, home: rig.home });
    cleaners.push(rig2.dispose);
    try {
      expect(rig2.daemon.workspace.isBound()).toBe(true);
      expect(rig2.daemon.workspace.get().current).toBe(root1);
      const get = await rig2.client.call("workspace.get", {});
      expect(get?.payload.current).toEqual({ root: root1 });
      // recents 携带且 valid
      const recents = (get?.payload.recents as { root: string; valid: boolean }[]) ?? [];
      expect(recents).toHaveLength(1);
      expect(recents[0]).toMatchObject({ root: root1, valid: true });
      const projects = await rig2.client.call("kg.projects", {});
      expect((projects?.payload.projects as { name: string }[]).map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
    } finally {
      rig2.dispose();
      await rig2.daemon.shutdown();
    }
  }, 30000);

  test("活跃 agent：运行态 open 被拒（WORKSPACE_E_ACTIVE_AGENT），收尾后放行", async () => {
    // 长流式回合维持 agentState 非 idle（chunkDelayMs 拉宽流式窗口）
    const engine = new FakeAgentEngine({
      initialModel: "fake/model",
      replies: [{ text: "流式长回合".repeat(40), chunkDelayMs: 120 }],
    });
    const rig = await startRig({ kgWorkspaceRoot: null, engine });
    cleaners.push(rig.dispose);
    try {
      const root2 = realpathSync(rig.ws2);
      await rig.client.call("workspace.open", { root: rig.ws1 });
      await rig.client.waitFor("workspace_changed");

      // 建会话 + 驱动运行态
      const draft = await rig.client.call("chat.send", { text: "开始", draft: true, model: "fake/model" });
      expect(draft?.type).not.toBe("connection.error");
      await until(
        () => rig.daemon.system.getStatus().agentState !== "idle",
        5000,
        "agentState 进入运行态",
      );

      // 运行态 open → 拒绝（错误码 + 指引）
      const blocked = await rig.client.call("workspace.open", { root: rig.ws2 });
      expect(blocked?.type).toBe("connection.error");
      expect((blocked?.payload as { code: string }).code).toBe("WORKSPACE_E_ACTIVE_AGENT");
      expect((blocked?.payload as { message: string }).message).toContain("运行");

      // 中止收尾 → idle → open 放行
      rig.daemon.chat.abort();
      await until(
        () => rig.daemon.system.getStatus().agentState === "idle",
        10000,
        "agentState 回落 idle",
      );
      const ok = await rig.client.call("workspace.open", { root: rig.ws2 });
      expect(ok?.type).toBe("workspace.open.result");
      expect(ok?.payload.root).toBe(root2);
    } finally {
      rig.dispose();
      await rig.daemon.shutdown();
    }
  }, 30000);

  test("toolCwd 基准（W1F-F1）：unbound 回落启动 cwd → open 后新会话工具执行 cwd = 绑定规范形", async () => {
    const rig = await startRig({ kgWorkspaceRoot: null });
    cleaners.push(rig.dispose);
    try {
      // unbound：动态面回落启动 cwd（bootToolCwd = process.cwd()）
      expect(rig.daemon.toolCwdNow()).toBe(process.cwd());

      // 绑定 ws1 → 新建会话（draft 链放行）→ 工具执行 cwd 基准 = 绑定规范形
      //（engineFor 每会话装配 CoreToolExecutor.cwd 与 toolCwdNow 同一求值单点）
      const root1 = realpathSync(rig.ws1);
      const open1 = await rig.client.call("workspace.open", { root: rig.ws1 });
      expect(open1?.type).toBe("workspace.open.result");
      const draft = await rig.client.call("chat.send", { text: "你好", draft: true, model: "fake/model" });
      expect(draft?.type).not.toBe("connection.error");
      expect(rig.daemon.toolCwdNow()).toBe(root1);

      // 换绑 ws2 → 新基准跟随（draft 回合收尾回 idle 后再切——活跃 agent 门禁）
      await until(
        () => rig.daemon.system.getStatus().agentState === "idle",
        10000,
        "draft 回合收尾 idle",
      );
      const root2 = realpathSync(rig.ws2);
      await rig.client.call("workspace.open", { root: rig.ws2 });
      expect(rig.daemon.toolCwdNow()).toBe(root2);
    } finally {
      rig.dispose();
      await rig.daemon.shutdown();
    }
  }, 20000);

  test("SubAgent HELIX_TOOL_CWD 现值化（W1F-F2）：production 装配 spawn env = 绑定 root（代际跟随）", async () => {
    // production 引擎形态（不注入 engine → 真 SubagentLauncher 装配）+
    // Bun.spawn 打桩（subagent-spawn-snapshot.test.ts 同构：捕获 env，
    // 不起真子进程）；WS 面不需要——open 走 daemon.workspace 直调。
    const home = mkdtempSync(path.join(tmpdir(), "helix-ws-f2-home-"));
    const ws1 = mkdtempSync(path.join(tmpdir(), "helix-ws-f2-root-"));
    const calls: { env: Record<string, string | undefined> }[] = [];
    // 按实例 id 取捕获 env：不能按位置索引取（防御共享打桩串扰）。
    const envOf = (instanceId: string): Record<string, string | undefined> | undefined =>
      calls.find((c) => c.env["HELIX_INSTANCE_ID"] === instanceId)?.env;
    const fakeProc = () =>
      ({
        pid: 42000 + Math.floor(Math.random() * 900),
        exited: Promise.resolve(0),
        stdout: (async function* () {})(),
        stdin: { write: () => true },
      }) as unknown as ReturnType<typeof Bun.spawn>;
    const realSpawn = Bun.spawn;
    (Bun as unknown as { spawn: unknown }).spawn = (opts: {
      cmd: readonly string[];
      env: Record<string, string | undefined>;
    }) => {
      calls.push({ env: { ...opts.env } });
      return fakeProc();
    };
    const makeInstance = (id: string): AgentInstance =>
      AgentInstance.create({
        instanceId: id,
        kind: "subagent",
        profileKind: "subagent-worker",
        sessionId: "s-w1f-f2",
        createdAt: "2026-08-27T00:00:00.000Z",
      });
    try {
      const daemon = await createTestDaemon({
        home,
        skipConfig: true,
        skipLock: true,
        port: 0,
        cliInput: new PassThrough(),
        cliOutput: new PassThrough(),
        kgWorkspaceRoot: null, // 显式 unbound boot（production 形态）
      });
      try {
        const launcher = daemon.subagentLauncher;
        expect(launcher).toBeDefined(); // production 形态装配真体
        // unbound：spawn env 回落启动 cwd（旧实现为启动定格值——恒不变；
        // 修复后 = 绑定面现值，unbound 时同为启动 cwd，绑定后跟随）
        launcher!.launch(makeInstance("agent-f2-a"), "任务一");
        expect(envOf("agent-f2-a")!["HELIX_TOOL_CWD"]).toBe(process.cwd());
        // 绑定后：新 spawn 的子进程 HELIX_TOOL_CWD = 绑定 root（规范形）
        const root1 = realpathSync(ws1);
        const open = await daemon.workspace.open(ws1);
        expect(open.ok).toBe(true);
        launcher!.launch(makeInstance("agent-f2-b"), "任务二");
        expect(envOf("agent-f2-b")!["HELIX_TOOL_CWD"]).toBe(root1);
        // 已 spawn 实例不重复 spawn（代际生效：同 id 二次 launch 零新增）
        launcher!.launch(makeInstance("agent-f2-a"), "任务一（重复）");
        expect(calls.filter((c) => c.env["HELIX_INSTANCE_ID"] === "agent-f2-a")).toHaveLength(1);
        expect(calls.filter((c) => c.env["HELIX_INSTANCE_ID"] === "agent-f2-b")).toHaveLength(1);
      } finally {
        await daemon.shutdown();
      }
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = realSpawn;
    }
  }, 30000);
});
