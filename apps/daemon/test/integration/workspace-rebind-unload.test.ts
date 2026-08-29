/**
 * workspace 重绑旧会话债清偿 I 层（W4 Part A；评审挂账 W1R boundary）。
 *
 * 债的由来：重绑（open 换根）时旧栈 dispose，但旧会话 executor 闭包持旧栈
 * 服务（kgTools/editDeps 在 buildRuntime 时定格——buildSessionStack
 * engineFor 工厂逐会话求值一次）。W4 切换 UI 上线后「换绑→回旧会话用
 * kg/edit 工具」是正常路径，会打到已 dispose 的死栈。
 *
 * 修法观测（WorkspaceService.bind 重绑效应 → SessionRegistry.unloadAll）：
 * ① 绑定 ws1 建会话（热注册表可见）；② open(ws2) 重绑 → 全部现有会话
 * 卸载（registry 观测面：peek/hotRuntimes 空）；③ 回访旧会话可用（定向
 * chat.send → 懒加载重建 + 轮次完成）；④ 重建按新栈：toolCwdNow = ws2
 * 规范形 + 绑定栈项目域 = ws2（重建读持有者现值——kgTools/editDeps 工厂
 * 闭包在 buildRuntime 时取 workspace.stack()，重载晚于重绑故得新栈）。
 *
 * 形态：真组合根 × loopback WS × tmp workspace（workspace-binding.test.ts
 * 同构 rig）；FakeAgentEngine（非草稿首条亦走真 ChatService 轮次链）。
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

interface Frame {
  v: string;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
}

/** 收帧 loopback WS 客户端（workspace-binding.test.ts 同构）。 */
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

  /** 发命令并等回执（chat.send 草稿链回执 = session.snapshot）。 */
  async call(type: string, payload: Record<string, unknown>, timeoutMs = 5000): Promise<Frame | null> {
    const replyOf = (f: Frame): boolean =>
      f.type === `${type}.result` || f.type === "connection.error" || (type === "chat.send" && f.type === "session.snapshot");
    const at = this.frames.length;
    this.send({ v: PROTOCOL_VERSION, type, payload });
    await until(() => this.frames.slice(at).some(replyOf), timeoutMs, `等待 ${type}.result / connection.error`);
    return this.frames.slice(at).find(replyOf) ?? null;
  }

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

async function startRig(engine: FakeAgentEngine): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-w4-home-"));
  const ws1 = mkdtempSync(path.join(tmpdir(), "helix-w4-one-"));
  const ws2 = mkdtempSync(path.join(tmpdir(), "helix-w4-two-"));
  mkdirSync(path.join(ws1, "alpha"), { recursive: true });
  mkdirSync(path.join(ws2, "gamma"), { recursive: true });
  const daemon = await createTestDaemon({
    home,
    engine,
    skipConfig: true,
    skipLock: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    kgWorkspaceRoot: null, // 显式 unbound boot（绑定全部走 workspace.open）
  });
  const client = new TestClient(`ws://127.0.0.1:${daemon.ws.port}`);
  await client.open();
  const token = readFileSync(path.join(home, "dev-token"), "utf8");
  client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
  await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
  return { home, ws1, ws2, daemon, client, dispose: () => void client.close() };
}

const cleaners: (() => void)[] = [];
afterAll(() => {
  for (const fn of cleaners) fn();
});

describe("workspace 重绑旧会话卸载（W4 Part A 债清偿）I 层", () => {
  test("绑定建会话 → open 换根 → 全部会话卸载 → 回访懒加载可用且打新栈", async () => {
    const engine = new FakeAgentEngine({
      initialModel: "fake/model",
      replies: [
        { text: "第一条回复" },
        { text: "ws2 下的回访回复" },
      ],
    });
    const rig = await startRig(engine);
    cleaners.push(rig.dispose);
    try {
      const root1 = realpathSync(rig.ws1);
      const root2 = realpathSync(rig.ws2);

      // ① 绑定 ws1（首绑——不卸载：无旧栈可死）+ 建会话 s1（草稿链）
      const open1 = await rig.client.call("workspace.open", { root: rig.ws1 });
      expect(open1?.type).toBe("workspace.open.result");
      const draft1 = await rig.client.call("chat.send", { text: "在 ws1 下的第一条消息", draft: true, model: "fake/model" });
      expect(draft1?.type).not.toBe("connection.error");
      const s1 = (draft1?.payload as { snapshot: { sessionId: string } }).snapshot.sessionId;
      await until(() => rig.daemon.registry.peek(s1) !== undefined, 5000, "s1 热注册");
      expect(rig.daemon.registry.hotRuntimes().some((r) => r.sessionId === s1)).toBe(true);
      // 轮次收尾（重绑前置 = 全员 idle——F2 活跃 agent 门禁）
      await until(() => rig.daemon.registry.peek(s1)!.chatService.agentState === "idle", 10000, "s1 回落 idle");

      // ② open(ws2) 重绑：旧栈 dispose + 全部现有会话卸载（债清偿面）
      const open2 = await rig.client.call("workspace.open", { root: rig.ws2 });
      expect(open2?.type).toBe("workspace.open.result");
      expect(open2?.payload.root).toBe(root2);
      await rig.client.waitFor("workspace_changed");
      // registry 观测面：s1 已卸载、注册表无热会话（含 boot 草稿同卸）
      expect(rig.daemon.registry.peek(s1)).toBeUndefined();
      expect(rig.daemon.registry.hotRuntimes()).toEqual([]);
      // 绑定面跟随：新栈项目域 = ws2（gamma）+ 会话工具 cwd 基准 = ws2 规范形
      expect(rig.daemon.workspace.get().current).toBe(root2);
      expect(rig.daemon.workspace.stack()!.projectService.listProjects().map((p) => p.name)).toEqual(["gamma"]);
      expect(rig.daemon.toolCwdNow()).toBe(root2);

      // ③ 回访 s1（定向 chat.send）：懒加载重建 + 历史延续 + 轮次完成
      rig.client.send({ v: PROTOCOL_VERSION, type: "chat.send", sessionId: s1, payload: { text: "ws2 下回访" } });
      await until(() => rig.daemon.registry.peek(s1) !== undefined, 5000, "s1 懒加载重建");
      const rebuilt = rig.daemon.registry.peek(s1)!;
      // 历史延续（快照 + 事件流重放：首轮 user/assistant 在场——非空壳新会话）
      const restoredEntries = rebuilt.chatService.sessionView.entryList().length;
      expect(restoredEntries).toBeGreaterThanOrEqual(2);
      // 回访轮次：新条目落聚合 + 回 idle（轮次链可用——重建运行时行为等价）
      await until(
        () => {
          const rt = rig.daemon.registry.peek(s1);
          return (
            rt !== undefined &&
            rt.chatService.agentState === "idle" &&
            rt.chatService.sessionView.entryList().length > restoredEntries
          );
        },
        10000,
        "回访轮次完成（新条目 + 回 idle）",
      );

      // ④ 重建按新栈（结构保证）：重建晚于重绑——kgTools/editDeps/工具 cwd
      // 均在 buildRuntime 时读 workspace 持有者现值（container 工厂闭包），
      // 此刻持有者 = ws2 栈（上方断言）。重建会话与新建会话在新栈上等价，
      // 旧栈引用零残留（旧 record 整体销毁，见 ② peek 断言）。
    } finally {
      rig.dispose();
      await rig.daemon.shutdown();
      rmSync(rig.home, { recursive: true, force: true });
      rmSync(rig.ws1, { recursive: true, force: true });
      rmSync(rig.ws2, { recursive: true, force: true });
    }
  }, 30000);

  test("unbound boot 首绑不卸载：恢复会话连续性保全（CLI bindCwd 同语义）", async () => {
    // 首绑（bound === null）无旧栈可死——不卸载：保全装配期 initialize 恢复
    // 的最近会话（CLI bindCwd 路径靠此连续性；W4 语义：卸载只在栈替换时）。
    const engine = new FakeAgentEngine({ initialModel: "fake/model", replies: [{ text: "ok" }] });
    const rig = await startRig(engine);
    cleaners.push(rig.dispose);
    try {
      // unbound boot：initialize 新建零条目草稿（空 home）——热在场
      const bootHot = rig.daemon.registry.hotRuntimes().length;
      expect(bootHot).toBeGreaterThan(0);
      // 首绑 ws1：热会话不被卸载（首绑不触发卸载面）
      const open1 = await rig.client.call("workspace.open", { root: rig.ws1 });
      expect(open1?.type).toBe("workspace.open.result");
      expect(rig.daemon.registry.hotRuntimes().length).toBe(bootHot);
    } finally {
      rig.dispose();
      await rig.daemon.shutdown();
      rmSync(rig.home, { recursive: true, force: true });
      rmSync(rig.ws1, { recursive: true, force: true });
      rmSync(rig.ws2, { recursive: true, force: true });
    }
  }, 20000);
});
