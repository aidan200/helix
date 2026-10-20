import type { EventStream } from "../../adapters/driving/ws-server/EventStream";
import type { SessionRegistry } from "../../application/services/SessionRegistry";
import type { StewardMemoryService } from "../../application/steward/StewardMemoryService";
import type { Logger } from "../logging";
import {
  SessionSummaryService,
  recentUserTextsOf,
  recentTurnPairsOf,
} from "../../application/services/session-summary/SessionSummaryService";
import { SummaryConfigStore } from "../../adapters/driven/sqlite-session/SummaryConfigStore";
import { KgConfigStore } from "../../adapters/driven/sqlite-session/KgConfigStore";
import { PiStewardLlmAdapter, STEWARD_DEFAULT_MODEL } from "../../adapters/driven/loop/PiStewardLlmAdapter";
import { readSummaryConfig } from "../../application/summary/summaryConfig";
import type { DomainEvent } from "../../domain/events/DomainEvent";
import type { PersistenceStack } from "./buildPersistence";
import type { ModelStack } from "./buildModelStack";

/**
 * 装配函数 ⑥ 总结/知识库配置组（P5 体量门拆分，自组合根 container.ts 原样
 * 迁出）：组合根的一部分（AG-02④ 豁免面 infrastructure/assembly/**）。
 * 成员：summary.* 配置域（SummaryConfigStore 五键）+ kg.* 配置域
 * （KgConfigStore 查重阈值组，批2 WP-C）+ SessionSummaryService
 * （fan-out 目标 session-summary-bridge 的服务体）。
 *
 * 装配序契约：位于 buildStewardStack 之后（消费 stewardMemory 写面——
 * progress/记忆点 store 缺席即降级不产）、wireEventFanout 之前（本服务
 * 是六目标之一）。kgConfig 的晚绑引用回填（kgConfigRef——workspace
 * buildStack 闭包读现值）归组合根：本函数返回后立即写入，闭包只在运行期
 * 触发，语义与迁出前等义。
 */
export interface SummaryStack {
  /** summary.* 配置域（ws config.get/set_summary 回口与总结器同源单例）。 */
  readonly summaryConfig: SummaryConfigStore;
  /** kg.* 配置域（ws config.get/set_kg 回口与写入口查重闸同源单例）。 */
  readonly kgConfig: KgConfigStore;
  readonly sessionSummaryService: { onDomainEvent(event: DomainEvent): void };
}

export interface BuildSummaryStackDeps {
  readonly persistence: PersistenceStack;
  readonly modelStack: ModelStack;
  readonly registry: SessionRegistry;
  readonly eventStream: EventStream;
  /** 长期记忆写面（progress/记忆点 store；undefined = 总结器降级不产）。 */
  readonly stewardMemory: StewardMemoryService | undefined;
  readonly logger: Logger;
  /** 测试注入口（缺省 = SessionSummaryService 真体）。 */
  readonly sessionSummaryOverride?: { onDomainEvent(event: DomainEvent): void };
}

export function buildSummaryStack(deps: BuildSummaryStackDeps): SummaryStack {
  const { persistence, modelStack, registry, eventStream, stewardMemory, logger } = deps;
  // ── 会话总结器批①：SessionSummaryService（fanout 目标 session-summary-bridge
  //    的服务体）。配置面 = summary.* 通用域（SummaryConfigStore 五键——键位/
  //    解析/迁移单源 application/summary/summaryConfig.ts，运行期即热）；
  //    生成面复用管家 LLM 适配器形态（独立实例——模型槽位 = summary.model →
  //    adapter 默认 flash，显式配才产进展+记忆点）；同一锚点一次调用三产物
  //    （topic/progress/记忆点），记忆点入库走 remember 两段查重闸（E-214，
  //    source=session-summary）+ 显式 remember 防双写闸；烂输出整体丢弃下
  //    锚点幂等重试。判官（漂移判定）随「只出标题」降级形态评估退役——
  //    「保持」哨兵在 topic 字段内自带判别（findings：TR-234 supersede）。──
  const summaryConfig = new SummaryConfigStore(persistence.runtimeConfig);
  // ── 知识库配置组（批2 WP-C「知识库」配置组：config.get/set_kg 回口——
  //    查重阈值 kg.similarityWarn/kg.similarityDup；KV 单源 + 读面裁决单点
  //    application/services/kg/kgConfig.ts，运行期即热；**后续 kg 新增可配置
  //    项归宿同组**（D4））。──
  const kgConfig = new KgConfigStore(persistence.runtimeConfig);
  // kgConfig 晚绑引用（kgConfigRef）回填归组合根：返回后写入（装配窗口零调用）。
  const sessionSummaryService =
    deps.sessionSummaryOverride ??
    new SessionSummaryService({
      readConfig: () => summaryConfig.current(),
      llm: new PiStewardLlmAdapter({
        models: modelStack.catalog.modelsView(),
        // 槽位回落链（批①收编后单源）：summary.model → adapter 默认 flash
        modelSlot: () => readSummaryConfig(persistence.runtimeConfig).model ?? undefined,
        defaultModel: STEWARD_DEFAULT_MODEL,
        getApiKey: (provider) => modelStack.authStore.apiKeyOf(provider),
      }),
      resolveTarget: (sessionId) => {
        const runtime = registry.peekHotRuntime(sessionId);
        if (runtime === undefined) return undefined;
        const view = runtime.chatService.sessionView;
        const entries = view.entryList();
        const firstUser = entries.find((e): e is (typeof e) & { role?: string; text?: string } => "role" in e && e.role === "user");
        const firstAssistant = entries.find((e): e is (typeof e) & { role?: string; text?: string } => "role" in e && e.role === "assistant");
        return {
          title: view.title,
          topic: view.currentTopic(),
          turnCount: view.turnCount,
          recentUserTexts: recentUserTextsOf(entries, 10),
          // 总结素材：轮次对投影（user + 同轮末条 assistant = 最终结论）
          recentTurnPairs: recentTurnPairsOf(entries, 6),
          ...(firstAssistant !== undefined && typeof firstAssistant.text === "string"
            ? { firstAssistantText: [...firstAssistant.text].slice(0, 500).join("") }
            : {}),
          firstUserText: firstUser?.text ?? null,
          updateTopic: (topic, previous, anchorTurn) => runtime.chatService.updateTopic(topic, previous, anchorTurn),
        };
      },
      // progress/记忆点写面（stewardMemory 缺席 = 降级不产——总结器 deps 可选语义）
      ...(stewardMemory !== undefined
        ? {
            progressStore: {
              recordSessionProgress: (sessionId: string, text: string) =>
                stewardMemory.recordSessionProgress(sessionId, text),
            },
            memoryPointsStore: {
              rememberMemoryPoint: (point: { text: string; kind: "fact" | "preference"; domain: "habit" | "general" | "project" }, sessionId: string) =>
                stewardMemory.rememberSessionMemoryPoint(point.text, point.kind, point.domain, sessionId),
              explicitRememberedSince: (since: number) => stewardMemory.explicitRememberedSince(since),
            },
          }
        : {}),
      // 记忆落盘通知（memory_written 通知卡链——自动沉淀换轨后沿用 B5 契约）
      emitMemoryWritten: (payload) => eventStream.broadcastStewardMemoryWritten(payload),
      announceTopicChanged: (sessionId) => registry.announceTopicChanged(sessionId),
      logger: { warn: (message) => logger.warn(message) },
    });
  return { summaryConfig, kgConfig, sessionSummaryService };
}
