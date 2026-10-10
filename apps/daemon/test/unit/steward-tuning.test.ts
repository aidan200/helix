/**
 * StewardTuning 配置域单测（DDD 重构批 0：阈值搬家 KV 化——TDD 红→绿）。
 *
 * 断言面：
 * 1. 缺省零行为：KV 未配置 → 各生效值与原硬编码常量逐项相等（批 0 是纯
 *    搬家——缺省路径行为零变化是不变量，设计文档 §6 批 0 验收锚）。
 * 2. 配置生效：KV 写入合法值 → 生效值跟随（运行期即热——tuningOf 现拍）。
 * 3. 非法回退：非数/负数/小数/零 → 静默回退缺省 + warn 不抛错（与
 *    memoryConfig.resolveMemoryRecallParams 同款哲学：配置绝不挡对话）。
 * 4. 边界守护：每键域 [min,max]（防误配把看门狗调成疯狂 abort/把队列
 *    上限调到失控量级）。
 * 5. StewardService 注入面：tuningOf 注入生效（看门狗按注入值触发——
 *    缺省 180s 不触发 vs 注入合法短值触发，一正一反）。
 * 6. StewardComponent 契约：start/stop 幂等（生命周期登记表的前提）。
 *
 * 约束（设计文档 docs/temp/steward-ddd-redesign.md §3.3/§3.4）：存储介质
 * = helix.db runtime KV（steward.tuning.* 键族）；先不上设置页 UI。
 */
import { describe, expect, test } from "bun:test";
import {
  resolveStewardTuning,
  STEWARD_TUNING_DEFAULTS,
  STEWARD_TUNING_KEYS,
  STEWARD_TUNING_BOUNDS,
} from "../../src/domain/steward/tuning/StewardTuning";
import { StewardService } from "../../src/application/steward/StewardService";
import { StewardDialogMemory } from "../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./helpers/fake-steward-dialog-store";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { AgentOrchestrationPort, AgentInstanceStatus } from "../../src/application/ports/inbound/AgentOrchestrationPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";

// ── fakes（reliability.test 同款最小面）──────────────────────

function makeConfig(map: Record<string, string> = {}): Pick<RuntimeConfigPort, "get"> {
  return { get: (key: string) => map[key] };
}

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort {
  const kv = new Map(Object.entries(initial));
  return {
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  } as unknown as RuntimeConfigPort;
}

function fakeOrchestration(statuses: readonly AgentInstanceStatus[]): AgentOrchestrationPort {
  return {
    status: () => [...statuses],
    send: () => ({ delivered: false, detail: "unused" }),
  } as unknown as AgentOrchestrationPort;
}

/** 挂起剧本 fake LLM：round 0 永不收口（provider 流挂死形态）。 */
function hangingLlm(): StewardLlmPort {
  let round = 0;
  return {
    async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
      void request;
      const current = round;
      round += 1;
      if (current === 0) return new Promise<StewardLlmResponse>(() => {}); // 永不收口
      throw new Error("剧本耗尽");
    },
  } as unknown as StewardLlmPort;
}

function fakeLogger() {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    info: (m: string) => infos.push(m),
    warn: (m: string) => warns.push(m),
  };
}

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** tuning 注入面装配（reliability harness 缩水版——tuningOf 探针唯一变量）。 */
function makeService(opts: { tuningOf?: () => ReturnType<typeof resolveStewardTuning>; nowRef: { now: number } }) {
  const aborts: number[] = [];
  const innerCreate = createEngineFromPort(hangingLlm());
  const svc = new StewardService({
    llm: hangingLlm(),
    orchestration: fakeOrchestration([]),
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    dialog: new StewardDialogMemory(fakeDialogStore()),
    clock: () => opts.nowRef.now,
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => undefined,
    ...(opts.tuningOf !== undefined ? { tuningOf: opts.tuningOf } : {}),
    logger: fakeLogger(),
    createEngine: (engineOpts) => {
      const inner = innerCreate(engineOpts);
      return {
        start: (input: string, listener: unknown, images?: readonly string[]) => inner.start(input, listener as never, images),
        steer: (text: string) => inner.steer(text),
        abort: () => {
          aborts.push(opts.nowRef.now);
          inner.abort();
        },
        isStreaming: () => inner.isStreaming(),
        ...(inner.resume !== undefined ? { resume: (t: string, d: never) => inner.resume!(t, d) } : {}),
        ...(inner.setSystemPrompt !== undefined ? { setSystemPrompt: (t: string) => inner.setSystemPrompt!(t) } : {}),
      };
    },
  });
  return { svc, aborts };
}

// ── 1. 缺省零行为（纯搬家不变量）────────────────────────────

describe("StewardTuning 缺省零行为", () => {
  test("KV 未配置 → 全字段等于原硬编码常量值", () => {
    const t = resolveStewardTuning(makeConfig());
    expect(t.run.watchdogMs).toBe(180_000);
    expect(t.run.watchdogTickMs).toBe(5_000);
    expect(t.run.watchdogAbortGraceMs).toBe(15_000);
    expect(t.run.manualAbortGraceMs).toBe(8_000);
    expect(t.run.maxToolRounds).toBe(6);
    expect(t.ask.queueMax).toBe(3);
    expect(t.confirm.ttlMs).toBe(300_000);
    expect(t.confirm.remindAfterMs).toBe(30_000);
    expect(t.activation.windowMs).toBe(300_000);
  });

  test("空串（未配置态）与缺席等价 → 缺省", () => {
    const t = resolveStewardTuning(makeConfig({ [STEWARD_TUNING_KEYS.runWatchdogMs]: "" }));
    expect(t.run.watchdogMs).toBe(STEWARD_TUNING_DEFAULTS.run.watchdogMs);
  });
});

// ── 2/3/4. 配置生效 / 非法回退 / 边界守护 ─────────────────────

describe("StewardTuning 解析（表驱动逐键）", () => {
  test("合法配置生效（逐键）", () => {
    const t = resolveStewardTuning(
      makeConfig({
        [STEWARD_TUNING_KEYS.runWatchdogMs]: "60000",
        [STEWARD_TUNING_KEYS.runWatchdogTickMs]: "10000",
        [STEWARD_TUNING_KEYS.runWatchdogAbortGraceMs]: "20000",
        [STEWARD_TUNING_KEYS.runManualAbortGraceMs]: "5000",
        [STEWARD_TUNING_KEYS.runMaxToolRounds]: "10",
        [STEWARD_TUNING_KEYS.askQueueMax]: "5",
        [STEWARD_TUNING_KEYS.confirmTtlMs]: "600000",
        [STEWARD_TUNING_KEYS.confirmRemindAfterMs]: "60000",
        [STEWARD_TUNING_KEYS.activationWindowMs]: "120000",
        [STEWARD_TUNING_KEYS.activationPresenceTtlMs]: "120000",
      }),
    );
    expect(t.run.watchdogMs).toBe(60_000);
    expect(t.run.watchdogTickMs).toBe(10_000);
    expect(t.run.watchdogAbortGraceMs).toBe(20_000);
    expect(t.run.manualAbortGraceMs).toBe(5_000);
    expect(t.run.maxToolRounds).toBe(10);
    expect(t.ask.queueMax).toBe(5);
    expect(t.confirm.ttlMs).toBe(600_000);
    expect(t.confirm.remindAfterMs).toBe(60_000);
    expect(t.activation.windowMs).toBe(120_000);
    expect(t.activation.presenceTtlMs).toBe(120_000);
  });

  test("非法值（非数/负数/小数/零）静默回退缺省 + warn 不抛错", () => {
    const warns: string[] = [];
    const t = resolveStewardTuning(
      makeConfig({
        [STEWARD_TUNING_KEYS.runWatchdogMs]: "abc",
        [STEWARD_TUNING_KEYS.askQueueMax]: "-1",
        [STEWARD_TUNING_KEYS.runMaxToolRounds]: "2.5",
        [STEWARD_TUNING_KEYS.confirmTtlMs]: "0",
      }),
      (m) => warns.push(m),
    );
    expect(t.run.watchdogMs).toBe(STEWARD_TUNING_DEFAULTS.run.watchdogMs);
    expect(t.ask.queueMax).toBe(STEWARD_TUNING_DEFAULTS.ask.queueMax);
    expect(t.run.maxToolRounds).toBe(STEWARD_TUNING_DEFAULTS.run.maxToolRounds);
    expect(t.confirm.ttlMs).toBe(STEWARD_TUNING_DEFAULTS.confirm.ttlMs);
    expect(warns.length).toBe(4);
  });

  test("边界守护：域外值回退缺省（每键 [min,max] 表）", () => {
    const cases: readonly [keyof typeof STEWARD_TUNING_KEYS, string][] = [
      ["runWatchdogMs", String(STEWARD_TUNING_BOUNDS.runWatchdogMs.min - 1)],
      ["runWatchdogMs", String(STEWARD_TUNING_BOUNDS.runWatchdogMs.max + 1)],
      ["askQueueMax", "99"],
      ["runMaxToolRounds", "500"],
      ["runWatchdogTickMs", "100"],
    ];
    for (const [key, raw] of cases) {
      const t = resolveStewardTuning(makeConfig({ [STEWARD_TUNING_KEYS[key]]: raw }));
      expect(t).toEqual(STEWARD_TUNING_DEFAULTS); // 单键域外 → 整体回缺省（其余键本就缺省）
    }
  });
});

// ── 5. StewardService 注入面 ─────────────────────────────────

describe("StewardService tuningOf 注入生效", () => {
  test("注入合法短 watchdogMs → 挂起 run 后 tick 按注入值触发看门狗", async () => {
    const nowRef = { now: 1_000_000 };
    const { svc, aborts } = makeService({
      nowRef,
      tuningOf: () => ({
        ...STEWARD_TUNING_DEFAULTS,
        run: { ...STEWARD_TUNING_DEFAULTS.run, watchdogMs: 10_000 },
      }),
    });
    void svc.ask("看看情况");
    await settle(6); // driveAsk 前置（快照/召回）settle 后 runActive 置位、推进锚定格

    nowRef.now += 10_001; // 越过注入的 10s（缺省 180s 不触发）
    svc.reliabilityTick();
    expect(aborts.length).toBe(1);
  });

  test("缺省（未注入 tuningOf）→ 同样 advance 不触发（180s 才触发）", async () => {
    const nowRef = { now: 1_000_000 };
    const { svc, aborts } = makeService({ nowRef });
    void svc.ask("看看情况");
    await settle(6);
    nowRef.now += 10_001;
    svc.reliabilityTick();
    expect(aborts.length).toBe(0);
  });
});

// ── 6. StewardComponent 契约 ─────────────────────────────────

describe("StewardComponent 生命周期契约", () => {
  test("start/stop 幂等（二调不炸不二启）+ 可重启", () => {
    const nowRef = { now: Date.now() };
    const { svc } = makeService({ nowRef });
    expect(typeof svc.start).toBe("function");
    expect(typeof svc.stop).toBe("function");
    svc.start();
    svc.start(); // 幂等：不二启
    svc.stop();
    svc.stop(); // 幂等：不二炸
    svc.start(); // 可重启
    svc.stop();
  });
});
