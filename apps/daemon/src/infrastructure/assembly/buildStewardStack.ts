import path from "node:path";
import { existsSync } from "node:fs";
import { getLoadablePath as sqliteVecLoadablePath } from "sqlite-vec";
import type { BrowserPort } from "../../application/ports/outbound/BrowserPort";
import type { ClockPort } from "../../application/ports/outbound/ClockPort";
import type { StewardDiagnosisPort } from "../../application/ports/outbound/StewardDiagnosisPort";
import type { StewardLlmPort } from "../../application/ports/outbound/StewardLlmPort";
import type { TtsPort } from "../../application/ports/outbound/TtsPort";
import type { EventStream, FrameSender } from "../../adapters/driving/ws-server/EventStream";
import type { SessionRegistry } from "../../application/services/SessionRegistry";
import type { WriteFactRegistry } from "../../application/services/WriteFactRegistry";
import type { SchedulerService } from "../../application/services/scheduler/SchedulerService";
import type { WorkspaceService } from "../../application/services/workspace/WorkspaceService";
import type { Logger } from "../logging";
import type { HelixPaths } from "../paths";
import { DashScopeTtsAdapter, DASHSCOPE_PROVIDER_ID as DASHSCOPE_TTS_PROVIDER_ID } from "../../adapters/driven/tts/dashscope";
import { DashScopeStreamingTtsAdapter } from "../../adapters/driven/tts/streaming";
import { TtsStreamService } from "../../application/tts/TtsStreamService";
import { BroadcastService } from "../../application/voice/BroadcastService";
import {
  StewardService,
  STEWARD_ENABLED_KEY,
  STEWARD_MODEL_KEY,
  formatDeliverReceipt,
  SNAPSHOT_ACTIVITY_MAX_ENTRIES,
} from "../../application/steward/StewardService";
import {
  StewardMemoryService,
  STEWARD_MEMORY_EMBEDDING_KEY,
} from "../../application/steward/StewardMemoryService";
import {
  MEMORY_ENDPOINT_ID_KEY,
  MEMORY_JUDGE_ENDPOINT_ID_KEY,
  migrateLegacyStewardMemoryKeys,
  migrateMemoryEndpointToDefault,
} from "../../application/memory/memoryConfig";
import { EmbeddingConfigService, resolveJudgeRecord } from "../../application/embedding/EmbeddingConfigService";
import { OpenAiCompatEmbeddingAdapter } from "../../adapters/driven/embedding/OpenAiCompatEmbeddingAdapter";
import { makeJudgeAdapter } from "../../adapters/driven/embedding/JudgeAdapterFactory";
import { makeTriageJudgeFace, resolveTriageJudgeRecord } from "../../application/steward/StewardTriageJudge";
import { makeIntentJudgeFace } from "../../application/steward/StewardIntentJudge";
import { SqliteVecMemoryStore } from "../../adapters/driven/steward-memory/SqliteVecMemoryStore";
import { SqliteStewardDialogStore, migrateStewardDialogKv } from "../../adapters/driven/steward-memory/SqliteStewardDialogStore";
import { SqliteActivityLedgerStore } from "../../adapters/driven/steward-memory/SqliteActivityLedgerStore";
import { StewardActivityService } from "../../application/steward/StewardActivityService";
import { StewardDialogMemory } from "../../application/steward/StewardDialogMemory";
import { resolveVec0Path } from "../../adapters/driven/steward-memory/resolve-vec0";
import { PiStewardLlmAdapter, STEWARD_DEFAULT_MODEL } from "../../adapters/driven/loop/PiStewardLlmAdapter";
import { buildStewardEngine } from "../../adapters/driven/steward/StewardEngineBuilder";
import { resolveModel } from "../../adapters/driven/llm";
import { stewardEngineTraceBridge } from "./stewardEngineTraceBridge";
import { StewardDiagnosisAdapter } from "../../adapters/driven/voice/StewardDiagnosisAdapter";
import { StewardPerceptionService, REPLY_CONTEXT_MAX_CHARS } from "../../application/steward/StewardPerceptionService";
import type { StewardComponent } from "../../application/steward/StewardComponent";
import { migrateLegacySummaryKeys, readSummaryConfig } from "../../application/summary/summaryConfig";
import { SurfaceRegistry } from "../../application/surface/SurfaceRegistry";
import { SurfaceActionService } from "../../application/surface/SurfaceActionService";
import { BrowserSurfaceAdapter, SURFACE_AWARENESS_KEY } from "../../adapters/driven/cdp/BrowserSurfaceAdapter";
import { CdpConnectionManager } from "../../adapters/driven/cdp/CdpConnectionManager";
import { createStewardKgSource } from "../../adapters/driven/tools/kg/StewardKgTool";
import { scanProjectEntries } from "../../adapters/driven/workspace-scan";
import { singleProjectDirOf } from "./singleProjectDir";
import type { PersistenceStack } from "./buildPersistence";
import type { ModelStack } from "./buildModelStack";
import type { TaskStack } from "./buildTaskStack";
import type { FanoutPublisher } from "./wireEventFanout";

/**
 * 装配函数 ⑤ 管家域（P5 体量门拆分，自组合根 container.ts 原样迁出）：
 * 组合根的一部分（AG-02④ 豁免面 infrastructure/assembly/**）。成员按原
 * 装配序排列——语音播报（TTS adapter + BroadcastService）→ 文本管家 LLM 面
 * → 管家记忆 B2 域（embedding 配置 / 分诊判官 / 意图判官）→ 活动账（M3-d1）
 * → 感知服务（M0.5）→ 语音广播服务 → 配置迁移链（记忆域两次级链）→
 * 短期记忆（B6）+ 长期记忆（B1 vec0）→ surface 表面协议（M0/M1）→
 * StewardService → 生命周期登记表启停。
 *
 * 装配序契约（§4.2.2）：位于 buildSessionStack 之后（消费 eventStream/
 * registry/scheduler/taskStack/workspace 现值）、wireEventFanout 之前
 * （本域服务是六目标之三的服务体）。构造顺序/单例语义与迁出前逐行等义
 * ——晚绑引用（voiceBroadcastRef/stewardServiceRef）仍在原位置回填。
 */
export interface StewardStack {
  readonly voiceTts: TtsPort;
  readonly ttsStream: TtsStreamService;
  /** embedding 配置域服务体（端点 CRUD + verify + 解析；ws 回口与
   * buildTaskOrchestrator 硬闸同源单例）。 */
  readonly embeddingConfig: EmbeddingConfigService;
  readonly stewardActivity: StewardActivityService;
  readonly stewardPerception: StewardPerceptionService;
  readonly stewardService: StewardService;
  /** 长期记忆编排面（vec0 缺席/开库失败 = undefined 降级语义）。 */
  readonly stewardMemory: StewardMemoryService | undefined;
  /** surface 表面协议注册表（ws surface 族回口 + 动作路由单源）。 */
  readonly surfaceRegistry: SurfaceRegistry;
  /** 生命周期登记表（管家域统一启停——shutdown 消费）。 */
  readonly stewardComponents: readonly StewardComponent[];
}

export interface BuildStewardStackDeps {
  readonly paths: HelixPaths;
  readonly logger: Logger;
  readonly clock: ClockPort;
  readonly persistence: PersistenceStack;
  readonly modelStack: ModelStack;
  readonly taskStack: TaskStack;
  /** 会话栈产出的广播面（voice/feed/notify/health 帧出口 + 订阅闸）。 */
  readonly eventStream: EventStream;
  readonly scheduler: SchedulerService;
  readonly registry: SessionRegistry;
  readonly workspace: WorkspaceService;
  /** 会话足迹读面（progress 写入 scope / memory_search scope 单点归约）。 */
  readonly writeFacts: WriteFactRegistry;
  readonly browserPort: BrowserPort;
  readonly fanoutPublisher: FanoutPublisher;
  /** vec0 扩展包路径定格（bootPrelude 二级解析产物之一；AG-08 env 例外键）。 */
  readonly vec0BundlePath: string | undefined;
  // ── 测试注入口（容器接缝透传；缺省 = 真体） ──
  readonly voiceTtsOverride?: TtsPort;
  readonly voiceTtsStreamOverride?: TtsStreamService;
  readonly stewardDiagnoseOverride?: StewardDiagnosisPort;
  readonly stewardPerceptionOverride?: StewardPerceptionService;
  readonly stewardLlmOverride?: StewardLlmPort;
}

export function buildStewardStack(deps: BuildStewardStackDeps): StewardStack {
  const { paths, persistence, modelStack, taskStack, eventStream, scheduler, registry, workspace, browserPort, fanoutPublisher, clock, logger, vec0BundlePath } = deps;
  // ── 语音播报批（V2 TTS + ③层 LLM 摘要）：TTS adapter + BroadcastService
  //    （fanout 目标 voice-broadcast-bridge 的服务体；闸门读面 = eventStream
  //    连接级 voice 订阅表——零订阅连接 = 零 LLM 零合成零花费，播报开关
  //    默认 off 的落地面）──
  const voiceTts = deps.voiceTtsOverride ?? new DashScopeTtsAdapter({
    getApiKey: () => modelStack.authStore.apiKeyOf(DASHSCOPE_TTS_PROVIDER_ID),
    // 模型配置接入 P0：getModel getter 每次调用读现值（KV voice_model_config
    // 运行期即热；空/未配回落默认常量）
    getModel: () => persistence.voiceModelConfig.current().ttsModel,
  });
  // 流式 TTS 批（V3b-2）：单句流式合成服务（连接池复用 adapter；key 读面
  // 与一次性合成同源——每次调用重读 auth.json，换 key 自动跟随；哑帧修复批
  // 注入 voiceTtsStreamOverride 测试缝）
  const ttsStream =
    deps.voiceTtsStreamOverride ??
    new TtsStreamService({
      adapters: [
        new DashScopeStreamingTtsAdapter({
          getApiKey: () => modelStack.authStore.apiKeyOf(DASHSCOPE_TTS_PROVIDER_ID),
          // 模型配置接入 P0：流式 TTS 模型同源配置（ttsStreamModel 槽位）
          getModel: () => persistence.voiceModelConfig.current().ttsStreamModel,
        }),
      ],
      apiKeyOf: (providerId) => modelStack.authStore.apiKeyOf(providerId),
    });

  // ── 文本管家批（V2.5）：StewardService（fanout 目标 steward-feed-bridge
  //    的服务体 + steward.* 命令族回口）。LLM 面复用 provider 体系：
  //    模型目录 = modelStack 合并目录（modelsView），key = auth.json getter
  //    （每次调用重读，换 key 自动跟随）；模型槽位独立配置（RuntimeConfig
  //    steward.model KV，未设置 = flash 级默认）。money gate：开关关 =
  //    steward.ask 直接拒答零 LLM 调用（服务内单点，服务端权威）──
  const stewardLlm = deps.stewardLlmOverride ?? new PiStewardLlmAdapter({
    models: modelStack.catalog.modelsView(),
    modelSlot: () => persistence.runtimeConfig.get(STEWARD_MODEL_KEY),
    defaultModel: STEWARD_DEFAULT_MODEL,
    getApiKey: (provider) => modelStack.authStore.apiKeyOf(provider),
  });

  // ── 管家记忆 B2：embedding 配置域服务体（端点 CRUD + verify + 解析）。
  //    KV embedding_endpoints；apiKey 明文存储对齐 auth.json 同款（不另造
  //    加密）。（分诊判官接入批上提：判官 face 装配在感知服务之前——
  //    原落位于管家记忆 B6 块，依赖面仅 runtimeConfig/modelStack，上提零
  //    行为变化；后续迁移链原位保留。）
  // 判官目录依赖面（pi-ai variant 消费：目录合并视图 + provider key——与
  // PiStewardLlmAdapter 同源；每判调用惰性重读，换 key/换目录零重启跟随）。
  const judgeServices = {
    getModels: () => modelStack.catalog.modelsView(),
    getApiKey: (provider: string) => modelStack.authStore.apiKeyOf(provider),
  };
  const embeddingConfig = new EmbeddingConfigService({
    config: persistence.runtimeConfig,
    createProbe: (cfg) => new OpenAiCompatEmbeddingAdapter({ getConfig: () => cfg }),
    // B4a：classifier 端点 verify 探测面（分类模型注册表分派——variant
    // 区分实现）——与 createProbe 同构（按目标端点现配一次性构造，探测完即弃）
    createJudgeProbe: (cfg) => makeJudgeAdapter(() => cfg, judgeServices),
  });
  // 晚绑闭合（kg 向量面 buildStack 闭包读现值）：回填面归组合根（P5——
  // 本函数返回后 container 把 embeddingConfig 写入晚绑引用；闭包只在运行期
  // 触发，装配窗口零调用，语义与迁出前等义）。

  // 分诊器 LLM 面（管家感知批 M0.5 归一）：任务总结子功能专用槽位沿用
  //（summary.task.model，**无默认模型**——未配置 = 分诊面不可用，语音
  // 播报/notify 走极简终态通知）；可用性三条件在 adapter 处收口：管家开
  // ∧ 总结开 ∧ 模型槽位非空 = **启用**（v2.9 D12-⑫：LLM 分诊启用态恒做，
  // 不看激活）；激活判定不在此处（归感知服务单点，投递面判据）。
  // 原③层独立摘要调用（StewardVoiceSummarizerAdapter）已归一退役。
  const stewardDiagnose =
    deps.stewardDiagnoseOverride ??
    new StewardDiagnosisAdapter({
      llm: new PiStewardLlmAdapter({
        models: modelStack.catalog.modelsView(),
        modelSlot: () => readSummaryConfig(persistence.runtimeConfig).task.model ?? undefined,
        defaultModel: "",
        getApiKey: (provider) => modelStack.authStore.apiKeyOf(provider),
      }),
      enabled: () =>
        persistence.runtimeConfig.get(STEWARD_ENABLED_KEY) === "1" &&
        readSummaryConfig(persistence.runtimeConfig).task.enabled,
    });
  // 感知服务（M0.5 + M0.5-R）：ring 沉淀 + 激活判定 + 分诊编排 + notify 限流。
  // 晚绑闭包（voice sink 在下方 voiceBroadcast 构造后回填——构造环：
  // BroadcastService content 源又指向本服务 supplyBroadcastText；
  // reportDialog 汇报面在下方 stewardService 构造后回填——同款晚绑）。
  // 分诊判官判定面（分诊判官接入批，E-199 第四消费面）：steward.triage.*
  // 配置 + noul 判定收口；judge 真体经 makeJudgeAdapter 注册表分派（换
  // 端点/换变体零重启跟随——与管家记忆判官同款接线形态）；感知服务判定
  // 依赖与 steward.set_config {triage} 组读写同源真体。
  const triageJudge = makeTriageJudgeFace({
    config: persistence.runtimeConfig,
    embeddingConfig,
    judge: makeJudgeAdapter(
      () => resolveTriageJudgeRecord(persistence.runtimeConfig, embeddingConfig),
      judgeServices,
    ),
  });
  // ── M3-a：管家意图判别判定面（判官第五消费面——E-199 注册表预言三次
  //    验证：零改 JudgeAdapterFactory 任何一行，仅组合根新增一次
  //    makeJudgeAdapter 调用 + Pick<JudgePort,"noul"> 窄注入）。与分诊
  //    判官共享开关与端点（steward.triage.* 两键 + 端点解析单源闭包——
  //    「判官判定」一个开关管全部管家判官判定，零新增配置面零 UI）。 */
  const intentJudge = makeIntentJudgeFace({
    config: persistence.runtimeConfig,
    embeddingConfig,
    judge: makeJudgeAdapter(
      () => resolveTriageJudgeRecord(persistence.runtimeConfig, embeddingConfig),
      judgeServices,
    ),
  });
  let voiceBroadcastRef: BroadcastService | undefined;
  let stewardServiceRef: StewardService | undefined;
  // ── M3-d1 感知兑现批：管家活动账（一个账本）────────────────────
  //    ring 六类条目沉淀 + notify 记账 → 统一条目 {at,domain,attribution,text}
  //    （白话铁律）→ 三出口：落盘回看/清理（时间线查询面）+ ask 投影
  //    （StewardService recentActivity）+ 实时帧（broadcastStewardActivity）。
  //    存储形态（AG-06/TR-20 调研裁决）：steward_memory.db 第三连接行式存储
  //    （steward_activity 表——管家域单库聚合 B6 先例；避免 helix.db
  //    runtime_config kv 高频整包重写污染会话/任务热库）；开库失败降级纯
  //    内存（记录不丢、回看降级——对话存储同构兑底）。
  let activityLedgerStore: SqliteActivityLedgerStore | undefined;
  try {
    activityLedgerStore = new SqliteActivityLedgerStore(paths.stewardMemoryDbPath());
  } catch (err) {
    logger.warn(`管家活动账落盘降级（纯内存，重启即失）：${(err as Error).message}`);
  }
  const stewardActivity = new StewardActivityService({
    ...(activityLedgerStore !== undefined ? { store: activityLedgerStore } : {}),
    emit: (payload) => eventStream.broadcastStewardActivity(payload),
    logger,
  });
  const stewardPerception =
    deps.stewardPerceptionOverride ??
    new StewardPerceptionService({
      diagnose: stewardDiagnose,
      triageJudge,
      feedGate: eventStream, // hasStewardSubscribers 窄接口（激活信号①；M0 surface 后升级）
      // progress 薄条目写面（stewardMemory 在下方构造——晚绑闭包；缺席/未装配 = 静默 false）
      memory: {
        recordSessionProgress: (sessionId, text) =>
          stewardMemory !== undefined
            ? stewardMemory.recordSessionProgress(sessionId, text)
            : Promise.resolve(false),
      },
      // M3-d1：notify 发出即旁挂记账（只记不触发——通知链行为零改动）
      emitNotify: (payload) => {
        eventStream.broadcastStewardNotify(payload);
        stewardActivity.recordNotify({ title: payload.title, body: payload.body });
      },
      // M3-d1：ring 六类条目沉淀活动账（既有索引的落盘投影——零新采集面）
      onRingEntry: (entry) => stewardActivity.recordRingEntry(entry),
      // 对话内主动汇报面（M0.5-R：激活态投递面——工作记忆 assistant 记录，
      // 对话回放与 LLM 记忆同源）
      reportDialog: (report) => {
        void stewardServiceRef?.reportProactive(report).catch((err) => {
          logger.warn(`管家对话内主动汇报写入失败（${report.title}）：${(err as Error).message}`);
        });
      },
      voice: {
        enqueueDiagnosed: (item) => voiceBroadcastRef?.enqueueDiagnosed(item),
      },
      // 修复①：回合终态分诊读回复正文（尾投影取末条 assistant——与管家
      // read_session 工具同数据源）。2026-10-11 参数化批：单条改全文入诊
      // （用户裁决去 300 码点截断——回递播报凭全文；REPLY_CONTEXT_MAX_CHARS
      // 仅作病理体量防御，正常回复等效全文）。
      readReply: async (sessionId) => {
        const tail = await persistence.repository.readSessionTail(sessionId, 8, {
          maxEntryChars: REPLY_CONTEXT_MAX_CHARS,
        });
        if (tail === undefined) return undefined;
        for (let i = tail.length - 1; i >= 0; i -= 1) {
          if (tail[i]!.role === "assistant" && tail[i]!.text.trim() !== "") return tail[i]!.text;
        }
        return undefined;
      },
      // 修复②：投递关注持久化（runtime_config kv 单键快照——跨重启恢复）
      kv: persistence.runtimeConfig,
      logger,
    });
  const voiceBroadcast = new BroadcastService({
    tts: voiceTts,
    gate: eventStream, // hasVoiceSubscribers/voicePreference 窄接口（EventStream 实现 BroadcastGate）
    emit: (payload) => eventStream.broadcastVoice(payload),
    logger,
  });
  voiceBroadcastRef = voiceBroadcast; // 晚绑闭合（感知服务 voice sink 回填）
  // ── 管家记忆 B2：embedding 配置域服务体已在上方构造（分诊判官接入批
  //    上提）；两条一次性迁移链（批B 两级链式，幂等可重跑）：① 旧
  //    steward.memory.* 三键 → memory.* 通用记忆配置域（清旧键，新域已有
  //    值不覆盖）；② 旧 steward.memory.embedding（B1 三字段）→ 首条端点 +
  //    memory.endpointId 指向 + 清旧键（新域非空零动作）。先键位后端点：
  //    B1 老用户的旧 endpointId 指向悬空时，② 产出的新条目 id 优先，防迁移
  //    产物互相覆盖。
  void migrateLegacyStewardMemoryKeys(persistence.runtimeConfig)
    .then((migratedKeys) => {
      if (migratedKeys) logger.info("管家记忆迁移：steward.memory.* 三键已迁入 memory.* 通用记忆配置域（旧键已清）");
      return embeddingConfig.migrateLegacyStewardEndpoint(STEWARD_MEMORY_EMBEDDING_KEY, MEMORY_ENDPOINT_ID_KEY);
    })
    .then((migrated) => {
      if (migrated !== null) logger.info(`管家记忆迁移：旧端点配置已收编为 embedding 配置域首条端点（${migrated}）`);
      // 批1：memory.endpointId 退役迁移（序在键位/端点两级之后——② 产出的
      // memory.endpointId 也要被收编为全局默认端点）；幂等，二次启动零改写
      return migrateMemoryEndpointToDefault(persistence.runtimeConfig, embeddingConfig, (m) => logger.warn(m));
    })
    .then((outcome) => {
      if (outcome === "migrated") logger.info("默认 embedding 端点迁移：memory.endpointId 已收编为 embedding.defaultEndpointId（旧键已清）");
    })
    .catch((err) => logger.warn(`管家记忆迁移失败（旧配置保留，可重试）：${(err as Error).message}`));
  // 总结配置域迁移（一次性幂等；topic_config JSON + steward.sessionmemory.* +
  // steward.summary.* → summary.*，旧键清理——判官 classifyEndpointId 随
  // 判官退役丢弃）。与记忆迁移链并列同款 fire-and-forget（失败旧键保留可重试）。
  void migrateLegacySummaryKeys(persistence.runtimeConfig)
    .then((migrated) => {
      if (migrated) logger.info("总结配置迁移：topic_config/steward.sessionmemory.* /steward.summary.* 已迁入 summary.* 通用域（旧键已清）");
    })
    .catch((err) => logger.warn(`总结配置迁移失败（旧配置保留，可重试）：${(err as Error).message}`));

  // ── 管家记忆 B6：短期记忆消息落盘（steward_memory.db 行式 steward_messages
  //    替代 helix.db runtime_config 整包 KV——append 单行写/可查询/水位独立，
  //    与长期记忆同库不同表）；开库失败降级纯内存（对话照常，重启即失）；
  //    A1 旧 KV 一次性拆行迁移（幂等墓碑）。
  let dialog: StewardDialogMemory | undefined;
  try {
    const dialogStore = new SqliteStewardDialogStore(paths.stewardMemoryDbPath());
    if (migrateStewardDialogKv(dialogStore, persistence.runtimeConfig)) {
      logger.info("管家对话迁移：A1 KV 整包已拆行导入 steward_messages（旧键墓碑）");
    }
    dialog = new StewardDialogMemory(dialogStore);
    logger.info(`管家对话存储就绪：${paths.stewardMemoryDbPath()}`);
  } catch (err) {
    logger.warn(`管家对话存储降级（纯内存，重启即失）：${(err as Error).message}`);
  }

  // 管家记忆 B1：长期记忆编排面装配（全部失败面降级为未装配/缺席——
  // 对话主链路零影响）：vec0 扩展路径二级解析（① 壳 env HELIX_VEC_PATH
  // 注入——AG-08 例外面同 HELIX_RG_PATH 收束本域；② dev 形态 node_modules
  // 平台包 getLoadablePath()，编译单文件形态解析失败靠 ① 级兜底）→
  // better-sqlite3 开库（构造抛错 = 扩展加载失败 → 捕获降级）。
  const stewardMemory: StewardMemoryService | undefined = (() => {
      const vec0Resolution = resolveVec0Path({
        bundlePath: vec0BundlePath,
        nodeModulesPath: (() => {
          try {
            // dev 形态：sqlite-vec npm 包按平台解析 vec0.dylib/.so/.dll
            // （编译单文件形态 import.meta.resolve 失败 → undefined）。
            return sqliteVecLoadablePath();
          } catch {
            return undefined;
          }
        })(),
        probe: (p) => existsSync(p),
      });
      if (vec0Resolution.kind !== "resolved") {
        logger.info(`管家记忆降级（vec0 扩展不可解析）：${vec0Resolution.reasons.join("；")}`);
        return undefined;
      }
      let store: SqliteVecMemoryStore;
      try {
        store = new SqliteVecMemoryStore(paths.stewardMemoryDbPath(), vec0Resolution.path);
        logger.info(`管家记忆存储就绪（source=${vec0Resolution.source}）：${paths.stewardMemoryDbPath()}`);
      } catch (err) {
        logger.warn(`管家记忆降级（vec0 扩展加载失败）：${(err as Error).message}`);
        return undefined;
      }
      const embedding = new OpenAiCompatEmbeddingAdapter({
        // B2：端点配置经 EmbeddingConfigService 解析（endpointId → 条目——
        // 换端点零重建，下一次调用自动跟随）
        getConfig: () => {
          // 批1：向量端点取用改走全局默认端点单点（embedding.defaultEndpointId
          //  ——resolveDefault 全消费面唯一取用；悬空/未设 → null → embed 抛错
          //  降级，与旧 endpointId 引用同款失败语义）
          return embeddingConfig.resolveDefault();
        },
      });
      return new StewardMemoryService({
        config: persistence.runtimeConfig,
        embedding,
        embeddingConfig,
        store,
        // 项目隔离批：progress 写时项目解析——会话写足迹（writeFacts）单项目
        // 归约 → workspace 一级目录名；多项目/无足迹 → undefined（回落
        // global）。总结器/感知两 progress 入口共用（入库点收口，调用面零
        // 签名变化）。批E：memory_search scope 同口径（singleProjectDirOf
        // 单点——复用不复制）。
        resolveSessionProject: (sessionId) =>
          singleProjectDirOf(deps.writeFacts.projectFootprint(sessionId)),
        // B4a 判官真体（分类模型注册表分派，variant 区分实现）：
        // judgeEndpointId 惰性解析 + D1 判官端点兑底层单点（resolveJudgeRecord
        // ——显式引用优先，未配置兑底全局默认分类端点；误指 embedding 端点 /
        // 悬空 / 无默认 → null → noul 抛错降级——判官与召回端点不串用）；
        // judge 挂在同一 service 上语义正确：vec0 缺席时判了也存不了，不如不判。
        judge: makeJudgeAdapter(
          () => resolveJudgeRecord(persistence.runtimeConfig.get(MEMORY_JUDGE_ENDPOINT_ID_KEY), embeddingConfig),
          judgeServices,
        ),
        logger: { warn: (message) => logger.warn(message) },
      });
  })();
  // 记忆 GC 定时器：批 0 起收编 stewardComponents 登记表统一启动（下方
  //  for-of component.start()——60s 首跑 + 24h 周期；TR-152 定时器纪律不变）。
  // 管家引擎模型解析（与 PiStewardLlmAdapter 同一链：steward.model KV →
  // 目录解析 → 缺省 STEWARD_DEFAULT_MODEL——同轨单点）
  const resolveStewardEngineModel = (): ReturnType<typeof resolveModel> =>
    resolveModel(
      modelStack.catalog.modelsView(),
      persistence.runtimeConfig.get(STEWARD_MODEL_KEY) ?? STEWARD_DEFAULT_MODEL,
    );
  // ── surface 批（M0 表面协议地基）：SurfaceRegistry（组合根）——
  //    注册/observe 归一/act 路由/回执销账；sendAction 定向发帧（与广播面
  //    正交），emitLegacyNavigate = 兼容期双发镜像（D8 ③——**M1 前检查点
  //    删除点**，本行是旧帧广播的唯一非 EventStream 接线）。
  const surfaceRegistry = new SurfaceRegistry({
    sendAction: (key, action) => eventStream.sendSurfaceAction(key as FrameSender, action),
    emitLegacyNavigate: (args) => eventStream.broadcastStewardNavigate(args),
  });
  // ── browser adapter 感知批（M1）：BrowserSurfaceAdapter（CDP 事件 →
  //    SurfaceRegistry 归一 surfaceId=`browser:<targetId>` → 感知 ring）。
  //    感知开关 surface.awareness KV（D1 默认 off：off = 零注入零上报）；
  //    第三源接线 = Registry 观察者订阅（D10「生产者不直喂」——管家订阅
  //    总线形态）；FocusState 前台 tab 读面在 adapter（后续消费面接）。
  //    setAwarenessSink 晚绑（CdpConnectionManager 在入口处先构造）。
  const browserSurfaceAdapter = new BrowserSurfaceAdapter({
    registry: surfaceRegistry,
    awarenessOn: () => persistence.runtimeConfig.get(SURFACE_AWARENESS_KEY) === "1",
    // M2 act 执行面：CDP 操作面窄接口（BrowserPort 结构性子集）
    browser: browserPort,
    logger,
  });
  // M2：browser 表面动作执行面注册（SurfaceRegistry act 路由 → adapter.act
  //  ——同一动作管道，D8 不另开通道；回声窗口在 adapter 执行面内开关）。
  surfaceRegistry.registerLocal(browserSurfaceAdapter);
  // M2：管家消费面四泛型工具执行体（surface_list/snapshot/read/act）
  const surfaceActionService = new SurfaceActionService({
    registry: surfaceRegistry,
    browser: browserSurfaceAdapter,
  });
  surfaceRegistry.addObserver((event) => stewardPerception.onSurfaceEvent(event));
  if (browserPort instanceof CdpConnectionManager) {
    browserPort.setAwarenessSink(browserSurfaceAdapter);
  }
  const stewardService = new StewardService({
    llm: stewardLlm,
    ...(dialog !== undefined ? { dialog } : {}),
    memory: stewardMemory,
    triageJudge,
    intentJudge,
    // 项目隔离批：当前项目口径解析（workspace 绑定根 + 一级目录扫描，
    // 与 codegraph/kg 的 projectPath 同源口径；kg 缺省范围批起双消费：记忆
    // 召回 + kg_search/kg_get 缺省范围——resolveKgScope 直接取本口径，不另
    // 造判定）；单项目 → 该项目，多项目/未绑定 → undefined（召回只 global /
    // kg 缺省聚合兑底）。每次 ask/kg 工具调用现扫（毫秒级，重绑跟随）。
    memoryProject: () => {
      const root = workspace.boundRoot();
      if (root === null) return undefined;
      const entries = scanProjectEntries(root);
      return entries.length === 1 ? entries[0]!.name : undefined;
    },
    // 段B翻转：pi 引擎唯一配方装配（driven/steward buildStewardEngine——
    // 生产与测试共用；模型槽位与管家 LLM 同一解析链：steward.model KV →
    // 目录解析 → 缺省 STEWARD_DEFAULT_MODEL）
    createEngine: (opts) =>
      buildStewardEngine({
        systemPrompt: opts.systemPrompt,
        model: resolveStewardEngineModel(),
        apiKeys: () => {
          const table: Record<string, string> = {};
          for (const m of modelStack.catalog.modelsView().getModels()) {
            const key = modelStack.authStore.apiKeyOf(m.provider);
            if (key !== undefined) table[m.provider] = key;
          }
          return table;
        },
        // OAuth 分流（订阅登录批）：oauth 凭据存在 → getApiKey 不覆盖，
        // 交 pi-ai store 解析 + 自动 refresh（与主会话同轨）
        getCredentialType: (providerId) => modelStack.authStore.credentialTypeOf(providerId),
        models: modelStack.catalog.modelsView(),
        tools: opts.tools,
        gatedTools: opts.gatedTools,
        persistentListener: opts.persistentListener,
        ...(opts.initialMessages.length > 0 ? { initialMessages: opts.initialMessages } : {}),
        ...(opts.compaction !== undefined
          ? {
              compaction: {
                enabled: true,
                trigger: "request" as const,
                // pi 预留语义映射管家阈值：contextWindow - reserve = threshold
                reserveTokens: Math.max(
                  1024,
                  resolveStewardEngineModel().contextWindow - opts.compaction.thresholdTokens,
                ),
                keepRecentTokens: opts.compaction.keepRecent * 512,
                ...(opts.compaction.summarizeInstructions !== undefined
                  ? { customInstructions: opts.compaction.summarizeInstructions }
                  : {}),
                ...(opts.compaction.summarize !== undefined ? { summarize: opts.compaction.summarize } : {}),
              },
            }
          : {}),
      }),
    // 引擎事件 → domain_events 投影（追踪可见性——instanceId=steward，里程碑
    // 子集；广播面 default→null 不接，防自激语义保持）+ 工具调用监控入账
    //（kind='steward'：__system__ 会话无状态投影，直书口经 SessionRepository
    // → WriteQueue 单写链 __system__ 仓）
    emitEngineEvent: stewardEngineTraceBridge({
      publish: (event) => fanoutPublisher.publish(event),
      nowIso: () => clock.now(),
      recordToolCall: (sessionId, record) => void persistence.repository.recordToolCall(sessionId, record),
    }),
    orchestration: scheduler, // status 只读 + send 写注入（agent_send 等价 steer 通道）
    tasks: taskStack.query, // 任务清单只读面（TaskQueryService.listTasks）
    config: persistence.runtimeConfig, // steward.enabled / steward.model KV 持久化
    feedGate: eventStream, // hasStewardSubscribers 窄接口（连接级订阅闸门）
    // 管家感知批（M0.5）：ask 即激活信号②——感知服务衰减窗点亮（一问即
    // 入激活，响应环点亮主动环，D12-⑪）
    onUserActivity: () => stewardPerception.noteUserActivity(),
    // M3-d1：ask 对话投影——最近活动白话行注入 context_snapshot 活动段
    recentActivity: () => stewardActivity.recent(SNAPSHOT_ACTIVITY_MAX_ENTRIES),
    // 回合终态感知批：投递成功注册关注——目标会话回合结束命中分诊锚
    onDelivered: (sessionId, text) => stewardPerception.noteDelivered(sessionId, text),
    emitFeed: (payload) => eventStream.broadcastStewardFeed(payload),
    // 管家可靠性根修批：确认卡 TTL 作废的 action.completed 广播（与 feed 同
    // 订阅闸——多窗卡栈同步收口）+ 用户提醒帧出口（挂起恢复/确认可达性/TTL
    // 作废三提醒）
    emitActionCompleted: (payload) => eventStream.broadcastStewardActionCompleted(payload),
    // M3-d1：notify 发出即旁挂记账（可靠性提醒同入账——只记不触发）
    emitNotify: (payload) => {
      eventStream.broadcastStewardNotify(payload);
      stewardActivity.recordNotify({ title: payload.title, body: payload.body });
    },
    // 光球健康角标批：子系统健康上报（同态去重/seq 在 EventStream 出口把门）
    emitHealth: (component, status, reason) => eventStream.reportStewardHealth(component, status, reason),
    // M3-a（CAND-601 闭环）：对话内主动汇报实时帧出口（reportProactive 双写
    // ——开着的面板实时冒条目；与 feed/notify 同订阅闸）
    emitProactive: (payload) => eventStream.broadcastStewardProactive(payload),
    // B4a 自动沉淀提案帧出口（与 feed 同订阅闸——判官判定后轮外投递确认卡）
    emitMemoryWritten: (payload) => eventStream.broadcastStewardMemoryWritten(payload),
    // M0 表面协议地基批（D8 navigate 收编）：emitNavigate 域出口改经
    // SurfaceRegistry.act 路由 surface.action {verb:"navigate"}（域工具执行
    // 体不再直接广播页面指令帧）；旧 steward.navigate 由 Registry 兼容镜像
    // 双发（M1 前检查点删除）。risk=write——D3 挂动作（呈现面用户点按闸）。
    emitNavigate: (payload) => surfaceRegistry.act("navigate", { sessionId: payload.sessionId }, { risk: "write" }),
    // M2 表面消费面（四泛型工具执行体——act 经确认闸后走同一动作管道）
    surfaces: surfaceActionService,
    // A2：L1 感知面（快照 + query_recent_work 读面 + create_session 执行面
    // ——与 shell 新建会话同一 startDraftSession 服务路径；entryCount additive）。
    sessions: {
      listSessionMetadata: async () =>
        (await persistence.repository.listSessionMetadata()).map((r) => ({
          sessionId: r.sessionId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          // L1 投影修复批：显式标题列透传（此前在此断链——repo 已返回、
          // 管家投影拿不到，标题会话全部显示「（无主题）」）；动态主题批：
          // 演进主题 topic 同步透传（displayTitle 管家侧组装 title > topic > firstUserText）。
          ...(r.title != null ? { title: r.title } : {}),
          ...(r.topic != null ? { topic: r.topic } : {}),
          firstUserText: r.firstUserText,
          entryCount: r.entryCount ?? null,
        })),
      startDraftSession: (text, mode) => registry.startDraftSession(text, undefined, undefined, mode),
      // 修复批① 死锁链：createSession 执行体改调同轨专用入口——零消息零引擎，
      // 显式建立即 INSERT（title 进 meta 列）
      createTitledSession: (title) => registry.createTitledSession(title),
      // 驾驶舱批：session 存在性 + session 级投递执行面——投递走目标会话
      // ChatService.sendMessage（内部自动分流：运行中 → steer 队列（复用主
      // 会话 steer 机制）、空闲 → 新轮次——与用户在该会话页直接输入同语义）。
      // 冷会话经 registry.get 懒加载（不存在抛 SessionNotFoundError → 引导式
      // detail）；chatRouter 不在此处接（构建序在其后，且 registry 即同一路由源）。
      // B1 两段式（设计稿 §3.4）：source="steward"（投递与手动输入可辨）+
      // fireAndForget 受理即回（对齐手动 chat.send handler void 模式——idle
      // 全轮不再阻塞确认链；同步拒绝段照常抛错经 action.completed 交代，
      // 轮次内失败走会话事件面）。
      sessionExists: (sessionId) => registry.sessionExists(sessionId),
      // 语音闭环批 ④：轻量单会话标题查询（提案短名/在途摘要数据源——repo 点读
      // 不拉全表；title > topic > firstUserText）
      sessionTitleOf: (sessionId) => persistence.repository.readSessionTitle(sessionId),
      // progress 批 M3：尾部消息投影透传（repo 单行点读；opts 参数化批——
      // entryOffset 翻页 / maxEntryChars 覆盖，缺省仍截 300）
      readSessionTail: (sessionId, tailEntries, opts) =>
        persistence.repository.readSessionTail(sessionId, tailEntries, opts),
      deliverToSession: async (sessionId, text) => {
        try {
          const runtime = registry.peek(sessionId) ?? (await registry.get(sessionId));
          const outcome = await runtime.chatService.sendMessage(text, undefined, "steward", { fireAndForget: true });
          // 语音闭环批 ④：回执带目标会话短标题（查表直拼零 LLM——不念
          // sessionId；标题缺失回退现文案）
          const title = await persistence.repository.readSessionTitle(sessionId);
          return {
            delivered: true,
            detail:
              outcome.mode === "steered"
                ? formatDeliverReceipt(title, "steered", sessionId)
                : formatDeliverReceipt(title, "new", sessionId),
          };
        } catch (err) {
          return { delivered: false, detail: (err as Error).message };
        }
      },
    },
    // A2：kg 项目解析面（workspace 持有者读现值——重绑跟随新栈；未绑定 →
    //  resolve undefined / hasIndex false，引导式引导用户先绑 workspace）。
    projects: {
      resolve: (project) => workspace.stack()?.projectService.resolve(project),
      hasIndex: (projectRoot) => workspace.stack()?.projectService.hasIndex(projectRoot) ?? false,
    },
    // 批A：kg 只读检索面（管家开放 kg_search/kg_get——只挂 query 面零写，
    // 与 CoreToolExecutor 同先例；渲染语义复用 createKgTool；workspace 重绑
    // 跟随——读口惰性取现值，未绑定 = 引导式降级）。
    kg: createStewardKgSource({
      queryOf: () => workspace.stack()?.queryService,
      kgProjects: () =>
        workspace
          .stack()
          ?.projectService.listProjects()
          .filter((row) => row.status !== "absent")
          .map((row) => row.path) ?? [],
    }),
    // A2：任务创建面（task_create 同款引擎通道——paramsSchema 校验在引擎，
    //  TaskError message 原样透传；createdBy 词表封闭 "page"|"chat"，管家
    //  归 chat 宿主语义）。code-review 前置 git 仓判定（fs 注入——application
    //  零直接 IO）。
    taskEngine: taskStack.taskEngine,
    // .git 存在性（目录或文件——worktree 形态 .git 是文件）均算 git 仓
    hasGitRepo: (projectRoot) => existsSync(path.join(projectRoot, ".git")),
    logger,
  });
  stewardServiceRef = stewardService; // 晚绑闭合（感知服务对话内主动汇报面回填）
  // ── 批 0（DDD 重构）生命周期登记表：管家域服务统一启停（原两处手工挂
  //    点——reliability 定时器/GC 定时器——收编一处；后续新增管家域服务
  //    实现 StewardComponent 登记即入，不再各自挂 shutdown，排查 #11 根修）──
  const stewardComponents: readonly StewardComponent[] = [
    stewardService,
    ...(stewardMemory !== undefined ? [stewardMemory] : []),
  ];
  for (const component of stewardComponents) component.start();
  // 确认链路修复批④：daemon 启动清场广播——此刻内存 pending 必空集（不持久
  //  化），对启动时已在册的订阅连接撤旧卡（通常零连接；主清场路径 =
  //  steward.subscribe 受理回发快照对账——跨重启 shell 重连即收）。
  eventStream.broadcastStewardPendingSnapshot({ actionIds: stewardService.pendingSnapshot() });
  return {
    voiceTts,
    ttsStream,
    embeddingConfig,
    stewardActivity,
    stewardPerception,
    stewardService,
    stewardMemory,
    surfaceRegistry,
    stewardComponents,
  };
}
