import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDaemon } from "../../src/infrastructure/container";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { buildModels, resolveConfigModel } from "../../src/adapters/driven/pi-engine/model-provider";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION } from "@helix/protocol";

/**
 * AD-2 set_model / model_changed 链（T2.3 brief TDD 组4）：
 * - 下一 turn 生效（机械判据：引擎收到的 model 参数序列——in-flight run 完成
 *   时仍是旧值，下一 run 起为新值）；
 * - model.changed 广播（channel=model，信封 sessionId，订阅该会话的连接收到）；
 * - per-session：切模不影响其他会话；重置语义经 set_default（SQLite 默认）。
 */

const tmpRoots: string[] = [];

function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-model-set-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** 剧本化 StreamFn：记录每次请求的 model id（机械判据断言源）+ 延迟流式收尾。 */
function recordingStreamFn(seen: string[], firstChunkDelayMs: number): StreamFn {
  return (model: Model<any>, _ctx, opts) => {
    seen.push(`${model.provider}/${model.id}`);
    const stream = createAssistantMessageEventStream();
    const final: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: `reply@${model.id}` }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    } as unknown as AssistantMessage;
    const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
    void (async () => {
      stream.push({ type: "start", partial: final });
      await new Promise((r) => setTimeout(r, firstChunkDelayMs)); // in-flight 时窗
      if (signal?.aborted) {
        stream.push({ type: "done", reason: "stop", message: { ...final, content: [] } });
        return;
      }
      stream.push({ type: "done", reason: "stop", message: final });
    })();
    return stream;
  };
}

function makeRecordingEngine(seen: string[], firstChunkDelayMs = 20): PiAgentEngineAdapter {
  const models = buildModels();
  return new PiAgentEngineAdapter({
    profile: MainSessionProfile,
    model: resolveConfigModel("anthropic/claude-sonnet-4-5", models),
    apiKeys: { anthropic: "sk-test" },
    models,
    streamFnOverride: recordingStreamFn(seen, firstChunkDelayMs),
  });
}

describe("set_model 下一 turn 生效（真引擎链，TDD 组4）", () => {
  test("引擎收到的 model 序列：in-flight 完成时旧值 → 下一 run 新值；currentModel/getModel 联动", async () => {
    const seen: string[] = [];
    const engine = makeRecordingEngine(seen);
    const home = tmpHome();
    const daemon = await createDaemon({
      home,
      engine,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      const sid = daemon.registry.currentSessionId();

      // run 1：旧模型
      await daemon.chat.sendMessage("first");
      expect(seen).toEqual(["anthropic/claude-sonnet-4-5"]);
      expect(daemon.registry.peek(sid)!.chatService.currentModel).toBe("anthropic/claude-sonnet-4-5");

      // set_model：ack 形状 + currentModel 即时变更（下一 turn 生效语义）
      const outcome = await daemon.model.setModel(sid, "anthropic/claude-haiku-4-5");
      expect(outcome).toEqual({
        accepted: true,
        effective: "next-turn",
        previous: "anthropic/claude-sonnet-4-5",
      });
      expect(daemon.registry.peek(sid)!.chatService.currentModel).toBe("anthropic/claude-haiku-4-5");

      // run 2：新模型生效
      await daemon.chat.sendMessage("second");
      expect(seen).toEqual(["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"]);

      // in-flight 不变：run 3 进行中（streamFn 已收到模型——loop config 已快照）
      // 切回旧模型 → run 3 仍完成于 haiku，run 4 起回到 sonnet
      const inFlight = daemon.chat.sendMessage("third");
      await until(() => seen.length === 3); // run 3 已开流（配置快照已定）
      const midSwitch = daemon.model.setModel(sid, "anthropic/claude-sonnet-4-5");
      await inFlight;
      await midSwitch;
      await daemon.chat.sendMessage("fourth");
      expect(seen).toEqual([
        "anthropic/claude-sonnet-4-5",
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-haiku-4-5", // in-flight run：切换不打断
        "anthropic/claude-sonnet-4-5", // 下一 turn 生效
      ]);

      // model.get：切回默认后 isDefault=true；再切走 → false（语义双覆盖）
      const info = await daemon.model.getModel(sid);
      expect(info).toEqual({
        model: "anthropic/claude-sonnet-4-5",
        isDefault: true, // 会话模型 == 全局默认（builtin 兜底）
        defaultModel: "anthropic/claude-sonnet-4-5",
      });
      await daemon.model.setModel(sid, "anthropic/claude-haiku-4-5");
      expect((await daemon.model.getModel(sid)).isDefault).toBe(false); // ≠ 默认

      // 非法模型 → ModelNotFoundError（model_not_found 语义）
      await expect(daemon.model.setModel(sid, "anthropic/no-such-model")).rejects.toThrow(/不在目录/);
    } finally {
      await daemon.shutdown();
    }
  });

  test("per-session：A 会话切模不影响 B 会话（引擎工厂形态）", async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const engineA = makeRecordingEngine(seenA);
    const engineB = makeRecordingEngine(seenB);
    const home = tmpHome();
    // 引擎按构建序分配（首个会话 = 启动恢复的 A；次个 = 草稿 B），
    // 分配表断言防口实
    const assigned = new Map<string, PiAgentEngineAdapter>();
    const daemon = await createDaemon({
      home,
      engine: (sessionId: string) => {
        const engine = assigned.size === 0 ? engineA : engineB;
        assigned.set(sessionId, engine);
        return engine;
      },
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      const a = daemon.registry.currentSessionId();
      await daemon.chat.sendMessage("warm A"); // A 会话先活动（剧本引擎记录）
      const { sessionId: b } = await daemon.directory.startDraftSession("B 会话");
      await until(() => daemon.registry.peek(b) !== undefined && daemon.registry.peek(b)!.chatService.agentState === "idle");
      expect(assigned.get(a)).toBe(engineA);
      expect(assigned.get(b)).toBe(engineB);

      await daemon.model.setModel(a, "anthropic/claude-haiku-4-5");
      expect(daemon.registry.peek(a)!.chatService.currentModel).toBe("anthropic/claude-haiku-4-5");
      // B 会话不受影响：仍为各自引擎的装配模型（sonnet）
      const infoB = await daemon.model.getModel(b);
      expect(infoB.model).toBe("anthropic/claude-sonnet-4-5");
    } finally {
      await daemon.shutdown();
    }
  });
});

describe("model.changed 广播（WS 集成，契约 C §2.1）", () => {
  test("model.set → 订阅该会话的连接收到 model.changed（model/previous/effective/sessionId 章印）", async () => {
    const home = tmpHome();
    const daemon = await createDaemon({
      home,
      engine: new FakeAgentEngine({ initialModel: "anthropic/claude-sonnet-4-5" }),
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    const url = `ws://127.0.0.1:${daemon.ws.port}`;
    const token = readFileSync(path.join(home, "dev-token"), "utf8");
    let ws: WebSocket | undefined;
    try {
      const frames: Record<string, unknown>[] = [];
      ws = new WebSocket(url);
      ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
      await until(() => ws!.readyState === WebSocket.OPEN);
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } }));
      // T4：零条目草稿握手不 attach 不推快照——显式订阅当前会话（v0 兼容面）
      await until(() => frames.some((f) => f.type === "connection.welcome"));
      const welcome = frames.find((f) => f.type === "connection.welcome")!;
      if ((welcome.payload as { draft?: boolean }).draft === true) {
        ws.send(JSON.stringify({ v: 0, type: "session.subscribe", payload: {} }));
      }
      await until(() => frames.some((f) => f.type === "session.snapshot"));
      const sid = daemon.registry.currentSessionId();

      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, sessionId: sid, type: "model.set", payload: { model: "anthropic/claude-haiku-4-5" } }));
      await until(() => frames.some((f) => f.type === "model.changed"));
      const changed = frames.find((f) => f.type === "model.changed")!;
      expect(changed.sessionId).toBe(sid); // 信封章印：目标会话
      expect(changed.channel).toBe("model"); // 通道族
      expect(changed.payload).toEqual({
        sessionId: sid,
        model: "anthropic/claude-haiku-4-5",
        previous: "anthropic/claude-sonnet-4-5",
        effective: "next-turn",
      });
      // 引擎观测面联动（fake 契约等价：setModel 即时改观测值）
      expect(daemon.registry.peek(sid)!.chatService.currentModel).toBe("anthropic/claude-haiku-4-5");
      // 会话快照主实例 model 槽位填充（AgentInstanceDto.model 链）
      const view = daemon.registry.currentView();
      expect(view.instances![0]!.model).toBe("anthropic/claude-haiku-4-5");
      // spawn 透传链：切模后 spawn 的 SubAgent 卡片 model 槽位 = 当前模型
      const spawned = daemon.orchestration.spawn("调研任务");
      expect(spawned.status === "run" || spawned.status === "queued").toBe(true);
      const agentId = spawned.status === "run" || spawned.status === "queued" ? spawned.agentId : "";
      const subInstance = daemon.registry.currentView().instances!.find((i) => i.instanceId === agentId);
      expect(subInstance?.model).toBe("anthropic/claude-haiku-4-5");
    } finally {
      ws?.close();
      await daemon.shutdown();
    }
  });
});

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时（${Date.now() - t0}ms）`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
