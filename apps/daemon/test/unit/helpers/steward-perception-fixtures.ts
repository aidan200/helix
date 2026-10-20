/**
 * StewardPerceptionService 单测共享夹具（steward-perception*.test.ts 两文件共用）——
 * 纯位置迁移自 steward-perception.test.ts（P1 体量门拆分批，测试逻辑零改动）：
 * fake TTS / 分诊 / 分诊判官 / 记忆面 + 全链 makeStack 装配 + 测试辅助。
 */
import type { DomainEvent } from "../../../src/domain/events/DomainEvent";
import type { TtsPort, TtsRequest, TtsResult } from "../../../src/application/ports/outbound/TtsPort";
import type {
  StewardDiagnosisPort,
  StewardDiagnosisPrompt,
  StewardDiagnosisResult,
} from "../../../src/application/ports/outbound/StewardDiagnosisPort";
import {
  StewardPerceptionService,
  type ProactiveDialogReport,
} from "../../../src/application/steward/StewardPerceptionService";
import type { TriageJudgeFace } from "../../../src/application/steward/StewardTriageJudge";
import { BroadcastService } from "../../../src/application/voice/BroadcastService";
import type { StewardNotifyPayload, VoiceBroadcastPayload } from "@helix/protocol";

export const closure = (summary: string) => ({ status: "done" as const, summary, reportPath: null, findings: null, taskId: null });

export function agentEvent(type: string, payload: unknown, sessionId = "sess-1"): DomainEvent {
  return {
    type: type as DomainEvent["type"],
    sessionId,
    instanceId: "agent-2",
    payload,
    occurredAt: "2026-10-10T06:00:00.000Z",
  };
}

export function fakeTts(): TtsPort & { calls: TtsRequest[] } {
  const calls: TtsRequest[] = [];
  return {
    providerId: "dashscope",
    calls,
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      calls.push(req);
      return { audio: `data:audio/wav;base64,${btoa(String(calls.length))}` };
    },
  } as TtsPort & { calls: TtsRequest[] };
}

/** fake 分诊 port：记录调用；行为可构造后重编程（setBehavior）。判官批新增
 *  generateText 纯文本面（text/textError 可编程——判定路径生成段）。 */
export function fakeDiagnose(
  behavior?: { result?: Partial<StewardDiagnosisResult>; error?: Error; available?: boolean; text?: string; textError?: Error },
): StewardDiagnosisPort & {
  calls: StewardDiagnosisPrompt[];
  textCalls: StewardDiagnosisPrompt[];
  setBehavior(b: { result?: Partial<StewardDiagnosisResult>; error?: Error; available?: boolean; text?: string; textError?: Error }): void;
} {
  const calls: StewardDiagnosisPrompt[] = [];
  const textCalls: StewardDiagnosisPrompt[] = [];
  let current = behavior ?? {};
  return {
    calls,
    textCalls,
    setBehavior: (b) => {
      current = b;
    },
    isAvailable: () => current.available !== false,
    async diagnose(prompt) {
      calls.push({ ...prompt });
      if (current.error !== undefined) throw current.error;
      return {
        notify: true,
        urgency: "normal",
        present: "M0.5 感知链路已交付，测试全部通过。",
        ingest:
          "做了什么：落地管家感知链路（感知服务+分诊+notify）。\n" +
          "改动面：daemon 侧 StewardPerceptionService/BroadcastService。\n" +
          "发现统计：测试全绿，呈现轨即 M0.5 感知链路已交付，测试全部通过。\n" +
          "下一步：M1 浏览器 adapter。",
        suggestions: [],
        ...(current.result ?? {}),
      };
    },
    async generateText(prompt) {
      textCalls.push({ ...prompt });
      if (current.textError !== undefined) throw current.textError;
      return current.text ?? "默认口语句。\n\n默认正文要点。";
    },
  };
}

/** fake 分诊判官判定面（管家分诊判官接入批）：noul 双判可编程
 *  （worth/risk/error）；enabled/ready 缺省双 true（开启且就绪）。窄面
 *  Pick<enabled/ready/noul>——与感知服务判定依赖同形。 */
export function fakeTriageJudge(behavior?: {
  enabled?: boolean;
  ready?: boolean;
  verbose?: number;
  error?: Error;
}): Pick<TriageJudgeFace, "enabled" | "ready" | "noul"> & {
  calls: { state: string; question: string }[];
  setBehavior(b: { enabled?: boolean; ready?: boolean; verbose?: number; error?: Error }): void;
} {
  const calls: { state: string; question: string }[] = [];
  let current = behavior ?? {};
  return {
    calls,
    setBehavior: (b) => {
      current = b;
    },
    enabled: () => current.enabled !== false,
    ready: () => current.ready !== false,
    noul: async (state, question) => {
      calls.push({ state, question });
      if (current.error !== undefined) throw current.error;
      return current.verbose ?? 0.9;
    },
  };
}

/** 记忆面 fake：记录 recordSessionProgress 调用（覆盖更新路径入口断言）。 */
export function fakeMemory() {
  const progress: { sessionId: string; text: string }[] = [];
  return {
    progress,
    async recordSessionProgress(sessionId: string, text: string): Promise<boolean> {
      progress.push({ sessionId, text });
      return true;
    },
  };
}

/** 全链装配：BroadcastService（content 源 = perception）+ StewardPerceptionService。
 *  构造环（content → perception / voice → broadcast）经晚绑闭合——与生产
 *  container 同构形态。 */
export function makeStack(opts?: {
  diagnose?: ReturnType<typeof fakeDiagnose>;
  subscribers?: number;          // voice 订阅（0 = 闸门关）
  stewardSubscribed?: boolean;   // feed 订阅在场（激活信号①）
  recentAsk?: boolean;           // 近期 ask（激活信号②，缺省 true）
  memory?: ReturnType<typeof fakeMemory>;
  now?: number;
  readReply?: (sessionId: string) => Promise<string | undefined>;
  kv?: ReturnType<typeof makeFakeKv>;
  triageJudge?: ReturnType<typeof fakeTriageJudge>;
}) {
  const tts = fakeTts();
  const frames: VoiceBroadcastPayload[] = [];
  const notifies: StewardNotifyPayload[] = [];
  const dialogReports: ProactiveDialogReport[] = [];
  const warns: string[] = [];
  let clockNow = opts?.now ?? 1_000_000;
  const diagnose = opts?.diagnose ?? fakeDiagnose();
  const memory = opts?.memory ?? fakeMemory();
  let perceptionRef: StewardPerceptionService | undefined;
  const broadcast = new BroadcastService({
    tts,
    gate: {
      hasVoiceSubscribers: () => opts?.subscribers !== 0,
      voicePreference: () => undefined,
    },
    emit: (payload) => frames.push(payload),
    logger: { warn: (m) => warns.push(m) },
  });
  const perception = new StewardPerceptionService({
    diagnose,
    feedGate: { hasStewardSubscribers: () => opts?.stewardSubscribed !== false },
    memory,
    emitNotify: (payload) => notifies.push(payload),
    reportDialog: (report) => dialogReports.push(report),
    voice: broadcast, // 直供面（enqueueDiagnosed 窄接口）
    clock: () => clockNow,
    logger: { warn: (m) => warns.push(m) },
    ...(opts?.readReply !== undefined ? { readReply: opts.readReply } : {}),
    ...(opts?.kv !== undefined ? { kv: opts.kv } : {}),
    ...(opts?.triageJudge !== undefined ? { triageJudge: opts.triageJudge } : {}),
  });
  perceptionRef = perception; // 晚绑闭合
  if (opts?.recentAsk !== false) perception.noteUserActivity();
  return {
    perception,
    broadcast,
    diagnose,
    memory,
    frames,
    notifies,
    dialogReports,
    warns,
    tts,
    advance: (ms: number) => {
      clockNow += ms;
    },
    kvFlush: async () => {
      await opts?.kv?.flush();
    },
  };
}
/** BroadcastService 队列清空等待（生产 fire-and-forget；测试收口面）。 */
export async function broadcast_drain(perception: StewardPerceptionService): Promise<void> {
  await perception.drain();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/** kv 假实现（RuntimeConfigPort 窄面：同步 get + 异步 set）+ 写收口面。 */
export function makeFakeKv() {
  const store = new Map<string, string>();
  const pending: Promise<void>[] = [];
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: string) => {
      const p = Promise.resolve().then(() => {
        store.set(key, value);
      });
      pending.push(p);
      return p;
    },
    flush: async () => {
      await Promise.all(pending);
    },
  };
}
