/**
 * 设置页「通用」分区（语言切换 + 管家开关 + 工作空间 + 压缩参数 + 调度预算 + 端口 + 沙箱开关 + 长期记忆 + 总结）。
 *
 * 语言切换：useI18n().setLang 直写（helix-lang localStorage 持久化 +
 * document.lang 同步），纯壳端偏好不走 daemon 配置命令。
 * 管家（管家配置并轨批）：启用开关 = daemon 权威（steward.get_config 进入拉取
 * + set_config 写、config.result 回执回填，不乐观）；语音播报 = 本地偏好
 * （helix.steward.speakReply，面板语音模式朗读闸逐次读）——仅启用后显示
 * （从属项，缩进一层），非平级。管家模型槽位在智能体页管家卡。
 * 长期记忆（设置页长期记忆组批）：memory.* 通用配置域六键独立组
 * （enabled/endpointId/judgeEndpointId/recallTopK/recallPool/recallMinScore）
 * ——写面 steward.set_config {memory} 转发（批B 裁决：该组非 deprecated，
 * 本组仍 shell UI 现役写面），回显 steward.config.result memory 组（回执回填
 * 不乐观）；记忆配置不再从属管家启用（通用域——未来不止管家使用记忆）。
 * 召回量两输入框 + 资格阈值输入框同 everyTurns 模式：失焦/回车提交、非法值
 * （召回量非 1-200 整数；阈值非 0-1 数）回落最近已提交值零命令；旧 daemon
 * 回执缺席 recallTopK/recallPool/recallMinScore（additive）→ 缺省 5/24/0.3
 * 兑底展示。管家卡记忆区（B2 起）随本批迁出——管家配置零记忆项。
 * 总结（会话总结器独立化批①）：「总结」组 = 三产物开关 + 轮次输入 + 总结
 * 模型下拉 + 任务总结两项——写面 config.set_summary（summary.* 通用域），
 * config.get/set_summary.result 回填不乐观；管家配置零总结项。总结模型显式
 * 配才产进展+记忆点（无默认纪律），标题回落默认模型。
 * 知识库（批2 WP-C「知识库」配置组）：查重阈值两输入（警告阈值/重复阈值）
 * ——写面 config.set_kg，config.get/set_kg.result 回填不乐观；**kg 展面配置
 * 的归宿**（后续 kg 新增可配置项落此组，不散落他组，D4）。
 * 工作空间：原独立分区撤项并入（单配置独占一页浪费），卡片本体在
 * WorkspaceSettingsSection（当前绑定 + 切换入口，F2 活跃禁用语义不变）。
 * 压缩参数数据面：topology.modelConfig.compaction（config.get/set_compaction
 * 帧驱动，无乐观更新——写面靠 result 帧回填）；进入分区时
 * requestCompactionConfig 拉取现值。两个 token 绝对值输入框 + 保存按钮
 * （非负整数校验）。
 * 调度预算/端口（config 瘦身批同构）：modelConfig.scheduling / port 帧驱动
 * 同模式；调度写入下一次预算判定即生效（无重启提示），端口写入下次启动
 * 生效（UI 标注 + argv 覆盖态展示）。
 * 沙箱开关（沙箱开关批）：modelConfig.sandbox 帧驱动同模式；布尔双按钮组
 * （lang-switch 同构）点击即发 set、回执驱动回填（无乐观更新）；生效时机 =
 * 新会话/新任务（装配期定格）——UI note 标注。
 *
 * 三卡状态机单点（M10 批⑤）：dirty/pending/saved 三件套 + 结果帧对账 +
 * 在途失败收口归 useConfigField（settings-hooks.ts）——config.set_* daemon
 * 失败走 connection.error（无结果帧），hook 内清 pending + 行内错误交代
 * （M10 批②：不假「已保存」、在途不永锁致后续读帧被误当保存回执）；
 * 本地校验失败（空串/非整数/越界）的行内提示归本组件三卡独立位，
 * 输入变更即清（code-review 低危：不再静默 return）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n, type Lang } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";
import { cn } from "@/shared/lib/cn";
import { readStewardSpeakReplyPref, writeStewardSpeakReplyPref } from "@/shared/lib/voice-pref";
import HotkeyRecorder from "./HotkeyRecorder";
import WorkspaceSettingsSection from "./WorkspaceSettingsSection";
import { useConfigField } from "./settings-hooks";
import { filterAvailableModels } from "@/features/model-switch/model/available-models";
import type { CatalogModel, EmbeddingEndpointView } from "@helix/protocol";

/** 语言选项（按钮文案自命名词条：chat.settings.general.langZh/langEn）。 */
const LANG_OPTIONS: { id: Lang; labelKey: string }[] = [
  { id: "zh-CN", labelKey: "chat.settings.general.langZh" },
  { id: "en-US", labelKey: "chat.settings.general.langEn" },
];

// ── 长期记忆组 UI 兑底常量（设置页长期记忆组批）────────────────────
// 与 daemon memoryConfig 缺省/上界对齐（shell 不跨包 import daemon——硬拷
// 落地注释对齐；生效值以回执为准，此处仅旧 daemon（additive 字段缺席）
// 兑底展示）。 */
const MEMORY_TOPK_FALLBACK = 5;
const MEMORY_POOL_FALLBACK = 24;
/** 召回资格阈值缺省（值域 0-1；与 daemon STEWARD_MEMORY_RECALL_MIN_SCORE
 *  常量对齐——同硬拷注释纪律）。 */
const MEMORY_SCORE_FALLBACK = 0.3;
/** 召回量上界（topK ≤ pool ≤ 200 传递上界；非法值 UI 侧回落零命令）。 */
const MEMORY_RECALL_INPUT_MAX = 200;

const GeneralSettingsSection = function GeneralSettingsSection({
  onOpenMemory,
  onOpenModelsEmbeddingTab,
}: {
  /** 入口②：跳记忆独立页 /steward/memory（SettingsPage 注入）。 */
  onOpenMemory: () => void;
  /** 引导链接：跳模型页向量 tab（SettingsPage 注入——同页切分区 + tab 位）。 */
  onOpenModelsEmbeddingTab: () => void;
}) {
  const { t, lang, setLang } = useI18n();
  const { state, topology, requestCompactionConfig, setCompactionConfig, requestSchedulingConfig, setSchedulingConfig, requestPortConfig, setPortConfig, requestSandboxConfig, setSandboxConfig, requestSummaryConfig, setSummaryConfig, requestKgConfig, setKgConfig, requestModelConfig, requestAuthList, subscribeConfigFrames, sendStewardGetConfig, sendStewardSetConfig, subscribeStewardFrames, sendEmbeddingList, subscribeEmbeddingFrames } = useSession();
  const compaction = topology.modelConfig.compaction;
  const scheduling = topology.modelConfig.scheduling;
  const portCfg = topology.modelConfig.port;
  const sandboxCfg = topology.modelConfig.sandbox;

  // 三卡同构状态机（M10 批⑤：useConfigField 单点承载——脏态门控 M46 /
  // 在途对账 M44 / connection.error 在途失败收口 M10-②）
  const compactionField = useConfigField(compaction, (c) => [
    String(c.reserveTokens),
    String(c.keepRecentTokens),
  ]);
  const schedulingField = useConfigField(scheduling, (s) => [
    String(s.maxConcurrent),
    String(s.maxQueued),
  ]);
  const portField = useConfigField(portCfg, (p) => [
    p.storedPort !== null ? String(p.storedPort) : "",
  ]);
  const [reserve = "", keepRecent = ""] = compactionField.inputs;
  const [maxConcurrent = "", maxQueued = ""] = schedulingField.inputs;
  const portInput = portField.inputs[0] ?? "";
  // 知识库组（批2 WP-C「知识库」配置组）：查重阈值两输入——useConfigField
  // 单点承载回执对账（TR-84：「已保存」结果帧驱动不乐观置位 / send false
  // 必消费 / connection.error 在途收口）；提交时机同长期记忆组：失焦/回车，
  // 非法值回落最近已提交值零命令
  const kgCfg = topology.modelConfig.kg;
  const kgField = useConfigField(kgCfg, (c) => [String(c.similarityWarn), String(c.similarityDup)]);
  const kgWarnDraft = kgField.inputs[0] ?? "";
  const kgDupDraft = kgField.inputs[1] ?? "";
  /** 沙箱开关 send 失败交代（code-review H8：断线窗口不静默——结果帧驱动的开关无在途态，行内错误即全部反馈面）。 */
  const [sandboxError, setSandboxError] = useState<string | null>(null);

  // ── 管家（管家配置并轨批：自退役的管家独立分区并入，两开关零描述文案）──
  // 启用 = daemon 权威（get_config 进入拉 + config.result 回执回填，不乐观）；
  // 语音播报 = 本地偏好（朗读闸在 useStewardVoice 逐次读，写后下一轮生效）
  const [stewardEnabled, setStewardEnabled] = useState<boolean | null>(null);
  const [stewardError, setStewardError] = useState<string | null>(null);
  const [speakReply, setSpeakReply] = useState<boolean>(() => readStewardSpeakReplyPref());
  // 总结组（总结器独立化批①）：daemon 权威现态——modelConfig.summary
  // （config.get/set_summary.result 帧驱动，回填不乐观）；everyTurns 草稿
  // 本地态，失焦/回车提交（回执前不乐观），非法值回落最近已提交值零命令
  const summaryCfg = topology.modelConfig.summary;
  const [turnsDraft, setTurnsDraft] = useState<string>("");
  const turnsCommitted = useRef<number>(3);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // 记忆（设置页长期记忆组批）：daemon 权威现态（steward.config.result 回执
  // 回填，不乐观）；批1：向量端点选择退役（恒用全局默认 embedding 端点——
  // embedding.defaultEndpointId，向量 tab 内「设为默认」），回执不再回
  // endpoint；判官端点下拉不动（judgeEndpointId，D1）；recallTopK/recallPool
  // 为批B additive 生效值（旧 daemon 缺席 → 缺省兑底）——独立组不级联管家
  // 启用（通用域）
  const [memoryCfg, setMemoryCfg] = useState<{
    enabled: boolean;
    available: boolean;
    judgeEndpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
    entryCount: number;
    dim: number | null;
    recallTopK?: number;
    recallPool?: number;
    recallMinScore?: number;
  } | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  // 召回量两键 + 资格阈值草稿（同 everyTurns 模式：本地草稿，失焦/回车提交；
  // 非法值回落最近已提交值零命令；回执生效值变化才覆写——不误伤在途草稿）
  const [topKDraft, setTopKDraft] = useState<string>("");
  const topKCommitted = useRef<number | null>(null);
  const [poolDraft, setPoolDraft] = useState<string>("");
  const poolCommitted = useRef<number | null>(null);
  const [scoreDraft, setScoreDraft] = useState<string>("");
  const scoreCommitted = useRef<number | null>(null);
  const [embeddingEndpoints, setEmbeddingEndpoints] = useState<readonly EmbeddingEndpointView[] | null>(null);
  // 全局默认 embedding 端点（批1：embedding.list.result.defaultEndpointId——
  //  记忆开关准入判据：无默认 → 开启置灰 + 引导去向量 tab 设默认）
  const [defaultEmbeddingEndpointId, setDefaultEmbeddingEndpointId] = useState<string | null>(null);
  // 分诊判官（分诊判官接入批）：daemon 权威现态（steward.config.result triage
  // 组回执回填，不乐观）；开关 + 分类端点下拉（数据源 = 模型页分类 tab 已
  // 配端点 embedding.list kind=classifier）
  const [triageCfg, setTriageCfg] = useState<{
    judgeEnabled: boolean;
    judgeEndpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
  } | null>(null);
  useEffect(() => {
    sendStewardGetConfig();
  }, [sendStewardGetConfig]);
  useEffect(
    () =>
      subscribeStewardFrames?.((e) => {
        if (e.type !== "steward.config.result") return;
        const payload = e.payload as {
          enabled?: boolean;
          memory?: {
            enabled: boolean;
            available: boolean;
            judgeEndpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
            entryCount: number;
            dim: number | null;
            recallTopK?: number;
            recallPool?: number;
            recallMinScore?: number;
          };
          triage?: {
            judgeEnabled: boolean;
            judgeEndpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
          };
        };
        setStewardEnabled(payload.enabled === true);
        if (payload.memory !== undefined) setMemoryCfg(payload.memory);
        if (payload.triage !== undefined) setTriageCfg(payload.triage);
      }),
    [subscribeStewardFrames],
  );
  // 向量模型下拉数据源（embedding.list 驱动——每次进入分区刷新）
  useEffect(() => {
    sendEmbeddingList();
  }, [sendEmbeddingList]);
  useEffect(
    () =>
      subscribeEmbeddingFrames?.((e) => {
        if (e.type === "embedding.list.result") {
          setEmbeddingEndpoints(e.payload.endpoints);
          setDefaultEmbeddingEndpointId(e.payload.defaultEndpointId ?? null);
          return;
        }
      }),
    [subscribeEmbeddingFrames],
  );
  const toggleSteward = (enabled: boolean): void => {
    if (sendStewardSetConfig({ enabled }) === false) {
      setStewardError(t("chat.settings.general.sendFail"));
      return;
    }
    setStewardError(null);
  };
  // ── 长期记忆组写面（设置页长期记忆组批）：steward.set_config {memory}
  // 部分更新（批B 转发写面裁决）；开关/下拉点击即发；召回量失焦/回车提交；
  // 空串 = 清除判官端点引用回未配置态；回执驱动回填不乐观。批1：
  // endpointId 退役（向量端点恒为全局默认——写面不传该位）
  const sendMemory = (patch: { enabled?: boolean; judgeEndpointId?: string; recallTopK?: number; recallPool?: number; recallMinScore?: number }): void => {
    if (sendStewardSetConfig({ memory: patch }) === false) {
      setMemoryError(t("chat.settings.general.sendFail"));
      return;
    }
    setMemoryError(null);
  };
  const toggleMemory = (enabled: boolean): void => sendMemory({ enabled });
  const selectJudgeEndpoint = (judgeEndpointId: string): void => sendMemory({ judgeEndpointId });
  // 分诊判官写面（分诊判官接入批）：steward.set_config {triage} 部分更新
  //（管家卡内同帧命令——send 失败归管家组行内错误位）；空串 = 清除端点引用；
  // 回执驱动回填不乐观
  const sendTriage = (patch: { judgeEnabled?: boolean; judgeEndpointId?: string }): void => {
    if (sendStewardSetConfig({ triage: patch }) === false) {
      setStewardError(t("chat.settings.general.sendFail"));
      return;
    }
    setStewardError(null);
  };
  // 分类端点清单（下拉数据源：仅 kind=classifier——模型页分类 tab 同域）
  const classifierEndpoints = useMemo(
    () => (embeddingEndpoints ?? []).filter((ep) => ep.kind === "classifier"),
    [embeddingEndpoints],
  );
  // 总结组写面（总结器独立化批①）：config.set_summary 部分更新；空串/null
  // = 清空槽位回未配置态；轮次失焦/回车提交（非法值回落最近已提交值零命令）；
  // 回执驱动回填不乐观
  const sendSummary = (patch: {
    enabled?: boolean;
    everyTurns?: number;
    model?: string | null;
    task?: { enabled?: boolean; model?: string | null };
  }): void => {
    if (setSummaryConfig(patch) === false) {
      setSummaryError(t("chat.settings.general.sendFail"));
      return;
    }
    setSummaryError(null);
  };
  const toggleSummary = (enabled: boolean): void => sendSummary({ enabled });
  const selectSummaryModel = (model: string): void => sendSummary({ model: model === "" ? null : model });
  const toggleSummaryTask = (enabled: boolean): void => sendSummary({ task: { enabled } });
  const selectSummaryTaskModel = (model: string): void => sendSummary({ task: { model: model === "" ? null : model } });
  // 轮次草稿随回执同步（everyTurns 生效值变化才覆写——不误伤在途草稿）
  useEffect(() => {
    if (summaryCfg === null) return;
    turnsCommitted.current = summaryCfg.everyTurns;
    setTurnsDraft(String(summaryCfg.everyTurns));
  }, [summaryCfg === null ? null : summaryCfg.everyTurns]);
  const commitSummaryTurns = (): void => {
    const parsed = Number.parseInt(turnsDraft, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
      setTurnsDraft(String(turnsCommitted.current)); // 非法回落零命令
      return;
    }
    if (parsed === turnsCommitted.current) {
      setTurnsDraft(String(parsed));
      return;
    }
    sendSummary({ everyTurns: parsed });
    turnsCommitted.current = parsed;
  };
  // 召回量草稿随回执同步（生效值变化才覆写——不误伤在途草稿；旧 daemon 缺席
  // additive 字段 → 缺省兑底展示）
  const memoryTopKEffective = memoryCfg?.recallTopK ?? MEMORY_TOPK_FALLBACK;
  const memoryPoolEffective = memoryCfg?.recallPool ?? MEMORY_POOL_FALLBACK;
  const memoryScoreEffective = memoryCfg?.recallMinScore ?? MEMORY_SCORE_FALLBACK;
  useEffect(() => {
    if (memoryCfg === null) return;
    topKCommitted.current = memoryTopKEffective;
    setTopKDraft(String(memoryTopKEffective));
  }, [memoryCfg === null ? null : memoryTopKEffective]);
  useEffect(() => {
    if (memoryCfg === null) return;
    poolCommitted.current = memoryPoolEffective;
    setPoolDraft(String(memoryPoolEffective));
  }, [memoryCfg === null ? null : memoryPoolEffective]);
  useEffect(() => {
    if (memoryCfg === null) return;
    scoreCommitted.current = memoryScoreEffective;
    setScoreDraft(String(memoryScoreEffective));
  }, [memoryCfg === null ? null : memoryScoreEffective]);
  const commitRecallDraft = (which: "topK" | "pool" | "score"): void => {
    const draft = which === "topK" ? topKDraft : which === "pool" ? poolDraft : scoreDraft;
    const committed = which === "topK" ? topKCommitted.current : which === "pool" ? poolCommitted.current : scoreCommitted.current;
    const setDraft = which === "topK" ? setTopKDraft : which === "pool" ? setPoolDraft : setScoreDraft;
    // Number 严校验（parseInt("2.5") 会截成 2 误当合法——小数/空串必须回落）
    const parsed = Number(draft);
    const valid =
      which === "score"
        ? draft.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
        : Number.isInteger(parsed) && parsed >= 1 && parsed <= MEMORY_RECALL_INPUT_MAX;
    if (!valid) {
      setDraft(committed === null ? "" : String(committed)); // 非法回落零命令
      return;
    }
    if (parsed === committed) {
      setDraft(String(parsed));
      return;
    }
    sendMemory(which === "topK" ? { recallTopK: parsed } : which === "pool" ? { recallPool: parsed } : { recallMinScore: parsed });
    if (which === "topK") topKCommitted.current = parsed;
    else if (which === "pool") poolCommitted.current = parsed;
    else scoreCommitted.current = parsed;
  };

  const toggleSandbox = (enabled: boolean): void => {
    if (setSandboxConfig({ enabled }) === false) {
      setSandboxError(t("chat.settings.general.sendFail"));
      return;
    }
    setSandboxError(null);
  };

  // 提权自动通过（autoApprove 配置）：部分更新只携带 autoApprove；结果帧
  // 驱动回填（无乐观更新——TR-84）；与 enabled/extraRoots 不同，立即生效
  const toggleSandboxAutoApprove = (autoApprove: boolean): void => {
    if (setSandboxConfig({ autoApprove }) === false) {
      setSandboxError(t("chat.settings.general.sendFail"));
      return;
    }
    setSandboxError(null);
  };

  // 查重阈值提交（失焦/回车）：Number 严校验（parseInt("2.5") 会截成 2 误当
  // 合法——小数/空串必须回落）；值域 [0,1]；非法/未变回落最近已提交值零命令
  const commitKgThreshold = (which: "warn" | "dup"): void => {
    const index = which === "warn" ? 0 : 1;
    const raw = which === "warn" ? kgWarnDraft : kgDupDraft;
    const committed = kgCfg !== null ? String(which === "warn" ? kgCfg.similarityWarn : kgCfg.similarityDup) : "";
    const parsed = Number(raw);
    const valid = raw.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1;
    if (!valid) {
      kgField.setInput(index, committed); // 非法回落最近已提交值零命令（长期记忆组同款）
      return;
    }
    if (String(parsed) === raw && String(parsed) === committed) return; // 未变零命令
    kgField.submit(() => setKgConfig(which === "warn" ? { similarityWarn: parsed } : { similarityDup: parsed }));
  };

  const { auth, authLoaded } = topology.modelConfig;
  // 总结模型下拉（总结器独立化批①：管家模型选择同款口径——filterAvailableModels
  // 可用性过滤 + provider optgroup，现值兑底 select 不说谎）
  const summaryModelsByProvider = useMemo(() => {
    const visible = filterAvailableModels({
      models: topology.modelConfig.catalog?.models ?? [],
      auth,
      authLoaded,
      currentModel: summaryCfg?.model ?? undefined,
      query: "",
    });
    const current = summaryCfg?.model ?? null;
    const withCurrent =
      current !== null && !visible.some((m) => m.id === current)
        ? [{ id: current, providerId: current.split("/", 1)[0] ?? current } as CatalogModel, ...visible]
        : visible;
    const map = new Map<string, CatalogModel[]>();
    for (const m of withCurrent) {
      const list = map.get(m.providerId);
      if (list) list.push(m);
      else map.set(m.providerId, [m]);
    }
    return map;
  }, [topology.modelConfig.catalog, auth, authLoaded, summaryCfg?.model]);
  // 任务总结模型下拉（总结器独立化批①：同款口径——filterAvailableModels
  // 可用性过滤 + provider optgroup，现值兑底 select 不说谎）
  const summaryTaskModelsByProvider = useMemo(() => {
    const visible = filterAvailableModels({
      models: topology.modelConfig.catalog?.models ?? [],
      auth,
      authLoaded,
      currentModel: summaryCfg?.task.model ?? undefined,
      query: "",
    });
    const current = summaryCfg?.task.model ?? null;
    const withCurrent =
      current !== null && !visible.some((m) => m.id === current)
        ? [{ id: current, providerId: current.split("/", 1)[0] ?? current } as CatalogModel, ...visible]
        : visible;
    const map = new Map<string, CatalogModel[]>();
    for (const m of withCurrent) {
      const list = map.get(m.providerId);
      if (list) list.push(m);
      else map.set(m.providerId, [m]);
    }
    return map;
  }, [topology.modelConfig.catalog, auth, authLoaded, summaryCfg?.task.model]);

  // 额外可写目录（B 全局清单）：本地编辑态 null = 未编辑（展示现值）；
  // 保存走部分更新（仅 extraRoots），结果帧回填后清编辑态。
  const [extraRootsDraft, setExtraRootsDraft] = useState<string | null>(null);
  const [extraRootsInvalid, setExtraRootsInvalid] = useState<string | null>(null);
  const extraRootsValue = extraRootsDraft ?? (sandboxCfg?.extraRoots ?? []).join("\n");
  const saveExtraRoots = (): void => {
    const lines = extraRootsValue.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (!lines.every((l) => /^([/\\]|[A-Za-z]:[/\\])/.test(l))) {
      setExtraRootsInvalid(t("chat.settings.general.sandboxExtraRootsInvalid"));
      return;
    }
    setExtraRootsInvalid(null);
    if (setSandboxConfig({ extraRoots: lines }) === false) {
      setSandboxError(t("chat.settings.general.sendFail"));
      return;
    }
    setExtraRootsDraft(null);
  };

  // code-review 族A：沙箱开关 daemon 拒绝交代——开关无在途位（结果帧驱动），
  // connection.error 以命令尾缀归因辨识本写面（「（命令 <type>）」单一构造点；
  // 无尾缀旧 daemon 容忍也交代——宁误交代不静默）；其他 config 命令尾缀不消费。
  useEffect(
    () =>
      subscribeConfigFrames((e) => {
        if (e.type !== "connection.error") return;
        const message = (e.payload as { message?: string } | undefined)?.message ?? "connection.error";
        const cmd = /\uFF08\u547D\u4EE4 ([\w.]+)\uFF09\s*$/.exec(message)?.[1];
        if (cmd === undefined) return;
        // steward.set_config 拒答双交代（命令名无法区分 payload 组）：管家组
        // （enabled/model）与长期记忆组（memory）同帧各自行内交代——归因粒度
        // 至命令级，两组都可能是发起者，宁两处显示不静默丢失
        if (cmd === "steward.set_config") {
          setStewardError(message);
          setMemoryError(message);
          return;
        }
        if (cmd !== "config.set_sandbox") return;
        setSandboxError(message);
      }),
    [subscribeConfigFrames],
  );

  // 进入分区拉取现值（未请求态才发）；模型目录 + auth（主题模型下拉
  // 可用性过滤数据源，管家模型选择同款）
  useEffect(() => {
    requestCompactionConfig();
    requestSchedulingConfig();
    requestPortConfig();
    requestSandboxConfig();
    requestSummaryConfig();
    requestKgConfig();
    requestModelConfig();
    requestAuthList();
  }, [requestCompactionConfig, requestSchedulingConfig, requestPortConfig, requestSandboxConfig, requestSummaryConfig, requestKgConfig, requestModelConfig, requestAuthList]);

  // 本地校验失败行内提示（code-review 低危：空串/非整数/越界不再静默
  // return）；三卡各自独立位——提示随本卡输入变更/保存成功清，与
  // saveError（在途失败/未发出）分通道
  const [compactionInvalid, setCompactionInvalid] = useState<string | null>(null);
  const [schedulingInvalid, setSchedulingInvalid] = useState<string | null>(null);
  const [portInvalid, setPortInvalid] = useState<string | null>(null);

  const save = () => {
    // M45：显式拒空串（Number("")===0 过整数校验会静默写 0）
    if (reserve.trim() === "" || keepRecent.trim() === "") {
      setCompactionInvalid(t("chat.settings.general.invalidNonNegInt"));
      return;
    }
    const r = Number(reserve);
    const k = Number(keepRecent);
    if (!Number.isInteger(r) || !Number.isInteger(k) || r < 0 || k < 0) {
      setCompactionInvalid(t("chat.settings.general.invalidNonNegInt"));
      return;
    }
    setCompactionInvalid(null);
    compactionField.submit(() => setCompactionConfig(r, k));
  };

  const saveScheduling = () => {
    if (maxConcurrent.trim() === "" || maxQueued.trim() === "") {
      setSchedulingInvalid(t("chat.settings.general.invalidSchedBudget"));
      return;
    }
    const c = Number(maxConcurrent);
    const q = Number(maxQueued);
    if (!Number.isInteger(c) || !Number.isInteger(q) || c < 1 || q < 0) {
      setSchedulingInvalid(t("chat.settings.general.invalidSchedBudget"));
      return;
    }
    setSchedulingInvalid(null);
    schedulingField.submit(() => setSchedulingConfig(c, q));
  };

  const savePort = () => {
    if (portInput.trim() === "") {
      setPortInvalid(t("chat.settings.general.invalidPort"));
      return;
    }
    const p = Number(portInput);
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      setPortInvalid(t("chat.settings.general.invalidPort"));
      return;
    }
    setPortInvalid(null);
    portField.submit(() => setPortConfig(p));
  };

  return (
    <div className="pg" data-general-section>
      <h2 className="pg-title">{t("chat.settings.general.title")}</h2>

      {/* 语言切换（壳端偏好：helix-lang 持久化，即切即生效） */}
      <h3 className="section-label gen-group-label first">{t("chat.settings.general.groupLanguage")}</h3>
      <div className="hud-card">
        <div className="fld">
          <span className="hud-label">{t("chat.settings.general.language")}</span>
          <div className="lang-switch" data-lang-switch role="group" aria-label={t("chat.settings.general.language")}>
            {LANG_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={cn("hud-btn sm", lang === opt.id ? "hud-btn-cyan" : "hud-btn-ghost")}
                data-lang-option={opt.id}
                aria-pressed={lang === opt.id}
                onClick={() => setLang(opt.id)}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 管家（管家配置并轨批：启用 = daemon 权威回执回填；语音播报 = 本地偏好，
          仅启用后显示的从属项——缩进一层非平级；模型槽位在智能体页管家卡） */}
      <h3 className="section-label gen-group-label">{t("chat.settings.general.groupSteward")}</h3>
      <div className="hud-card" data-steward-card>
        <div className="fld">
          <span className="hud-label">{t("chat.settings.general.stewardEnable")}</span>
          <label className="set-check" data-steward-enabled>
            <input
              type="checkbox"
              checked={stewardEnabled === true}
              onChange={(e) => toggleSteward(e.target.checked)}
            />
            {t("chat.settings.general.stewardSwitchOn")}
          </label>
          {stewardError !== null && (
            <span className="mcp-err" data-steward-save-error role="alert">
              {stewardError}
            </span>
          )}
        </div>
        {stewardEnabled === true && (
          <div className="fld fld-sub" data-steward-speak>
            <span className="hud-label">{t("chat.settings.general.stewardSpeak")}</span>
            <label className="set-check" data-steward-speak-reply>
              <input
                type="checkbox"
                checked={speakReply}
                onChange={(e) => {
                  setSpeakReply(e.target.checked);
                  writeStewardSpeakReplyPref(e.target.checked);
                }}
              />
              {t("chat.settings.general.stewardSwitchOn")}
            </label>
          </div>
        )}
        {/* B4 唤醒链（组合键手动开麦 + 唤醒词门槛）：两项均本地偏好（启用后
            从属项）——组合键注册面在 wake-hotkey（设置改动热更新），唤醒词
            判定在 webview 本地（matchWakeWord） */}
        {stewardEnabled === true && (
          <div className="fld fld-sub" data-steward-wake-hotkey>
            <span className="hud-label">{t("chat.settings.general.stewardHotkey")}</span>
            <HotkeyRecorder />
            <span className="ag-note">{t("chat.settings.general.stewardHotkeyNote")}</span>
          </div>
        )}
        {/* 分诊判官（分诊判官接入批）：判定面接 JudgePort——开关 + 分类端点
            下拉（数据源 = 模型页分类 tab）；开关开且端点有效时分诊判定走判官
            noul 校准概率、生成转纯文本两段制；关闭/未配/判官报错 daemon 回退
            现行 LLM 路径（写面 steward.set_config {triage}，回执回填不乐观） */}
        {stewardEnabled === true && (
          <div className="fld fld-sub" data-steward-triage>
            <span className="hud-label">{t("chat.settings.general.stewardTriageJudge")}</span>
            <label className="set-check" data-steward-triage-enabled>
              <input
                type="checkbox"
                checked={triageCfg?.judgeEnabled === true}
                onChange={(e) => sendTriage({ judgeEnabled: e.target.checked })}
              />
              {t("chat.settings.general.stewardSwitchOn")}
            </label>
            {triageCfg?.judgeEnabled === true && (
              <div className="sel-wrap" data-steward-triage-endpoint>
                <select
                  className="hud-input"
                  data-steward-triage-endpoint-select
                  disabled={classifierEndpoints.length === 0}
                  value={
                    triageCfg.judgeEndpoint !== null && classifierEndpoints.some((ep) => ep.id === triageCfg.judgeEndpoint?.id)
                      ? triageCfg.judgeEndpoint.id
                      : ""
                  }
                  onChange={(e) => sendTriage({ judgeEndpointId: e.target.value })}
                >
                  <option value="">{t("chat.settings.general.stewardTriageEndpointPlaceholder")}</option>
                  {classifierEndpoints.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      {`${ep.name} (${ep.model})`}
                    </option>
                  ))}
                </select>
                {classifierEndpoints.length === 0 ? (
                  <span className="ag-note" data-steward-triage-empty>
                    {t("chat.settings.general.stewardTriageEndpointEmpty")}
                  </span>
                ) : (
                  <span className="ag-note">{t("chat.settings.general.stewardTriageEndpointNote")}</span>
                )}
              </div>
            )}
          </div>
        )}
        {/* M3-c 声纹校验（管家组第五件）：注册引导（3-5 句生成模板）/测试/
            删除——从属启用（与语音播报/唤醒链/判官同构 fld-sub 形态）；
            授权点校验只对已注册生效（未注册零劣化）。 */}
        {/* 声纹区已迁语音设置页（声纹 v2 录入位置裁决）：语音设置页
            「声纹校验」组承载（注册/导入/测试/删除）。 */}
        {/* 记忆区已迁出（设置页长期记忆组批）：memory.* 通用域五键归通用分区
            「长期记忆」组（不级联管家启用）——管家配置零记忆项 */}
      </div>

      {/* 工作空间卡（原独立分区并入；绑定展示 + 切换入口语义不变） */}
      <h3 className="section-label gen-group-label">{t("chat.settings.general.groupWorkspace")}</h3>
      <WorkspaceSettingsSection />

      <h3 className="section-label gen-group-label">{t("chat.settings.general.groupCompaction")}</h3>
      <div className="hud-card">
        <div className="fld">
          <label className="hud-label" htmlFor="compaction-reserve">
            {t("chat.settings.general.reserveTokens")}
          </label>
          <input
            id="compaction-reserve"
            className="hud-input"
            type="number"
            min={0}
            value={reserve}
            data-compaction-reserve
            onChange={(e) => {
              setCompactionInvalid(null);
              compactionField.setInput(0, e.target.value);
            }}
          />
        </div>
        <div className="fld">
          <label className="hud-label" htmlFor="compaction-keep-recent">
            {t("chat.settings.general.keepRecentTokens")}
          </label>
          <input
            id="compaction-keep-recent"
            className="hud-input"
            type="number"
            min={0}
            value={keepRecent}
            data-compaction-keep-recent
            onChange={(e) => {
              setCompactionInvalid(null);
              compactionField.setInput(1, e.target.value);
            }}
          />
        </div>
        <button type="button" className="hud-btn hud-btn-cyan" data-compaction-save onClick={save}>
          {t("chat.settings.general.save")}
        </button>
        {compactionField.saved && (
          <span className="ag-note" data-compaction-saved>
            {t("chat.settings.general.saved")}
          </span>
        )}
        {compactionField.saveError !== null && (
          <span className="mcp-err" data-compaction-save-error role="alert">
            {compactionField.saveError}
          </span>
        )}
        {compactionInvalid !== null && (
          <span className="mcp-err" data-compaction-invalid role="alert">
            {compactionInvalid}
          </span>
        )}
      </div>

      {/* SubAgent 调度预算（config 瘦身批：运行期可调，下一次预算判定生效） */}
      <h3 className="section-label gen-group-label">{t("chat.settings.general.groupScheduling")}</h3>
      <div className="hud-card">
        <div className="fld">
          <label className="hud-label" htmlFor="sched-max-concurrent">
            {t("chat.settings.general.maxConcurrent")}
          </label>
          <input
            id="sched-max-concurrent"
            className="hud-input"
            type="number"
            min={1}
            value={maxConcurrent}
            data-sched-max-concurrent
            onChange={(e) => {
              setSchedulingInvalid(null);
              schedulingField.setInput(0, e.target.value);
            }}
          />
        </div>
        <div className="fld">
          <label className="hud-label" htmlFor="sched-max-queued">
            {t("chat.settings.general.maxQueued")}
          </label>
          <input
            id="sched-max-queued"
            className="hud-input"
            type="number"
            min={0}
            value={maxQueued}
            data-sched-max-queued
            onChange={(e) => {
              setSchedulingInvalid(null);
              schedulingField.setInput(1, e.target.value);
            }}
          />
        </div>
        <button type="button" className="hud-btn hud-btn-cyan" data-sched-save onClick={saveScheduling}>
          {t("chat.settings.general.save")}
        </button>
        {schedulingField.saved && (
          <span className="ag-note" data-sched-saved>
            {t("chat.settings.general.saved")}
          </span>
        )}
        {schedulingField.saveError !== null && (
          <span className="mcp-err" data-sched-save-error role="alert">
            {schedulingField.saveError}
          </span>
        )}
        {schedulingInvalid !== null && (
          <span className="mcp-err" data-sched-invalid role="alert">
            {schedulingInvalid}
          </span>
        )}
        <span className="ag-note">{t("chat.settings.general.schedNote")}</span>
      </div>

      {/* WS 端口（config 瘦身批：下次启动生效；argv 覆盖态展示） */}
      <h3 className="section-label gen-group-label">{t("chat.settings.general.groupPort")}</h3>
      <div className="hud-card">
        <div className="fld">
          <label className="hud-label" htmlFor="ws-port">
            {t("chat.settings.general.wsPort")}
          </label>
          <input
            id="ws-port"
            className="hud-input"
            type="number"
            min={0}
            max={65535}
            value={portInput}
            placeholder="7333"
            data-ws-port
            onChange={(e) => {
              setPortInvalid(null);
              portField.setInput(0, e.target.value);
            }}
          />
        </div>
        <button type="button" className="hud-btn hud-btn-cyan" data-port-save onClick={savePort}>
          {t("chat.settings.general.save")}
        </button>
        {portField.saved && (
          <span className="ag-note" data-port-saved>
            {t("chat.settings.general.saved")}
          </span>
        )}
        {portField.saveError !== null && (
          <span className="mcp-err" data-port-save-error role="alert">
            {portField.saveError}
          </span>
        )}
        {portInvalid !== null && (
          <span className="mcp-err" data-port-invalid role="alert">
            {portInvalid}
          </span>
        )}
        <span className="ag-note">{t("chat.settings.general.portNote")}</span>
        {portCfg !== null && portCfg.overriddenByArgv && (
          <span className="ag-note" data-port-argv-override>
            {t("chat.settings.general.portArgvOverride", { port: portCfg.effectivePort })}
          </span>
        )}
      </div>

      {/* 沙箱开关（沙箱开关批：新会话/新任务生效；lang-switch 双按钮同构） */}
      <h3 className="section-label gen-group-label">{t("chat.settings.general.groupSandbox")}</h3>
      <div className="hud-card">
        <div className="fld">
          <span className="hud-label">{t("chat.settings.general.sandbox")}</span>
          <div className="lang-switch" data-sandbox-switch role="group" aria-label={t("chat.settings.general.sandbox")}>
            <button
              type="button"
              className={cn("hud-btn sm", sandboxCfg?.enabled === true ? "hud-btn-cyan" : "hud-btn-ghost")}
              data-sandbox-option="on"
              aria-pressed={sandboxCfg?.enabled === true}
              onClick={() => toggleSandbox(true)}
            >
              {t("chat.settings.general.sandboxOn")}
            </button>
            <button
              type="button"
              className={cn("hud-btn sm", sandboxCfg?.enabled === false ? "hud-btn-cyan" : "hud-btn-ghost")}
              data-sandbox-option="off"
              aria-pressed={sandboxCfg?.enabled === false}
              onClick={() => toggleSandbox(false)}
            >
              {t("chat.settings.general.sandboxOff")}
            </button>
          </div>
          {sandboxError !== null && (
            <span className="mcp-err" data-sandbox-save-error role="alert">
              {sandboxError}
            </span>
          )}
        </div>
        <div className="fld">
          <span className="hud-label">{t("chat.settings.general.sandboxAutoApprove")}</span>
          <div className="lang-switch" data-sandbox-auto-approve-switch role="group" aria-label={t("chat.settings.general.sandboxAutoApprove")}>
            <button
              type="button"
              className={cn("hud-btn sm", sandboxCfg?.autoApprove === true ? "hud-btn-cyan" : "hud-btn-ghost")}
              data-sandbox-auto-approve-option="on"
              aria-pressed={sandboxCfg?.autoApprove === true}
              onClick={() => toggleSandboxAutoApprove(true)}
            >
              {t("chat.settings.general.sandboxOn")}
            </button>
            <button
              type="button"
              className={cn("hud-btn sm", sandboxCfg?.autoApprove === false ? "hud-btn-cyan" : "hud-btn-ghost")}
              data-sandbox-auto-approve-option="off"
              aria-pressed={sandboxCfg?.autoApprove === false}
              onClick={() => toggleSandboxAutoApprove(false)}
            >
              {t("chat.settings.general.sandboxOff")}
            </button>
          </div>
          <span className="ag-note" data-sandbox-auto-approve-note>
            {t("chat.settings.general.sandboxAutoApproveNote")}
          </span>
        </div>
        <div className="fld">
          <label className="hud-label" htmlFor="sandbox-extra-roots">
            {t("chat.settings.general.sandboxExtraRoots")}
          </label>
          <textarea
            id="sandbox-extra-roots"
            className="hud-input"
            rows={3}
            value={extraRootsValue}
            placeholder={t("chat.settings.general.sandboxExtraRootsPlaceholder")}
            data-sandbox-extra-roots
            onChange={(e) => {
              setExtraRootsInvalid(null);
              setExtraRootsDraft(e.target.value);
            }}
          />
        </div>
        <button
          type="button"
          className="hud-btn hud-btn-cyan"
          data-sandbox-extra-roots-save
          disabled={extraRootsDraft === null}
          onClick={saveExtraRoots}
        >
          {t("chat.settings.general.save")}
        </button>
        {extraRootsInvalid !== null && (
          <span className="mcp-err" data-sandbox-extra-roots-invalid role="alert">
            {extraRootsInvalid}
          </span>
        )}
        <span className="ag-note">{t("chat.settings.general.sandboxExtraRootsNote")}</span>
        <span className="ag-note">{t("chat.settings.general.sandboxNote")}</span>
      </div>

      {/* 总结（会话总结器独立化批①）：三产物开关 + 轮次输入 + 总结模型
          （显式配才产进展+记忆点）+ 任务总结子功能两项；写面 config.set_summary
          ——config.get/set_summary.result 回填不乐观（不翻本地态）；运行期即热 */}
      <h3 className="section-label gen-group-label">{t("chat.settings.general.groupSummary")}</h3>
      <div className="hud-card" data-summary-card>
        <div className="fld">
          <span className="hud-label">{t("chat.settings.general.summaryEnable")}</span>
          <div className="lang-switch" data-summary-switch role="group" aria-label={t("chat.settings.general.summaryEnable")}>
            <button
              type="button"
              className={cn("hud-btn sm", summaryCfg?.enabled === true ? "hud-btn-cyan" : "hud-btn-ghost")}
              data-summary-option="on"
              aria-pressed={summaryCfg?.enabled === true}
              onClick={() => toggleSummary(true)}
            >
              {t("chat.settings.general.sandboxOn")}
            </button>
            <button
              type="button"
              className={cn("hud-btn sm", summaryCfg?.enabled === false ? "hud-btn-cyan" : "hud-btn-ghost")}
              data-summary-option="off"
              aria-pressed={summaryCfg?.enabled === false}
              onClick={() => toggleSummary(false)}
            >
              {t("chat.settings.general.sandboxOff")}
            </button>
          </div>
          {summaryError !== null && (
            <span className="mcp-err" data-summary-save-error role="alert">
              {summaryError}
            </span>
          )}
        </div>
        {summaryCfg?.enabled === true && (
          <>
            <div className="fld fld-sub" data-summary-turns>
              <label className="hud-label" htmlFor="summary-turns-input">
                {t("chat.settings.general.summaryTurnsLabel")}
              </label>
              <input
                id="summary-turns-input"
                className="hud-input"
                type="number"
                min={1}
                max={20}
                data-summary-turns-input
                value={turnsDraft}
                onChange={(e) => setTurnsDraft(e.target.value)}
                onBlur={commitSummaryTurns}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitSummaryTurns();
                }}
              />
              <span className="ag-note">{t("chat.settings.general.summaryTurnsNote")}</span>
            </div>
            <div className="fld fld-sub" data-summary-model>
              <label className="hud-label" htmlFor="summary-model-select">
                {t("chat.settings.general.summaryModelLabel")}
              </label>
              <div className="sel-wrap">
                <select
                  id="summary-model-select"
                  className="hud-input"
                  data-summary-model-select
                  value={summaryCfg.model ?? ""}
                  onChange={(e) => selectSummaryModel(e.target.value)}
                >
                  <option value="">{t("chat.settings.general.summaryModelPlaceholder")}</option>
                  {[...summaryModelsByProvider.entries()].map(([providerId, models]) => (
                    <optgroup label={providerId} key={providerId}>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <span className="ag-note">{t("chat.settings.general.summaryModelNote")}</span>
            </div>
          </>
        )}
        {/* 任务总结（语音播报摘要 + 感知分诊 gate 共用；独立开关——无默认模型：
            未配 = 播报/分诊均回退极简终态通知） */}
        <div className="fld" data-summary-task>
          <span className="hud-label">{t("chat.settings.general.summaryTaskEnable")}</span>
          <label className="set-check" data-summary-task-enabled>
            <input
              type="checkbox"
              checked={summaryCfg?.task.enabled === true}
              onChange={(e) => toggleSummaryTask(e.target.checked)}
            />
            {t("chat.settings.general.sandboxOn")}
          </label>
        </div>
        {summaryCfg?.task.enabled === true && (
          <div className="fld fld-sub" data-summary-task-model>
            <label className="hud-label" htmlFor="summary-task-model-select">
              {t("chat.settings.general.summaryTaskModelLabel")}
            </label>
            <div className="sel-wrap">
              <select
                id="summary-task-model-select"
                className="hud-input"
                data-summary-task-model-select
                value={summaryCfg.task.model ?? ""}
                onChange={(e) => selectSummaryTaskModel(e.target.value)}
              >
                <option value="">{t("chat.settings.general.summaryTaskModelPlaceholder")}</option>
                {[...summaryTaskModelsByProvider.entries()].map(([providerId, models]) => (
                  <optgroup label={providerId} key={providerId}>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <span className="ag-note">{t("chat.settings.general.summaryTaskModelNote")}</span>
          </div>
        )}
      </div>

      {/* 长期记忆（设置页长期记忆组批）：memory.* 通用配置域五键独立组——
          开关双按钮 + 向量端点 + 判官端点 + 召回量两输入框（enabled 展开从属
          四项）；写面 steward.set_config {memory} 转发，回执回填不乐观；
          不级联管家启用（通用域）*/}
      <h3 className="section-label gen-group-label">{t("chat.settings.general.groupMemory")}</h3>
      <div className="hud-card" data-memory-card>
        <div className="fld">
          <span className="hud-label">{t("chat.settings.general.memoryEnable")}</span>
          <div className="lang-switch" data-memory-switch role="group" aria-label={t("chat.settings.general.memoryEnable")}>
            <button
              type="button"
              className={cn("hud-btn sm", memoryCfg?.enabled === true ? "hud-btn-cyan" : "hud-btn-ghost")}
              data-memory-option="on"
              aria-pressed={memoryCfg?.enabled === true}
              disabled={defaultEmbeddingEndpointId === null}
              onClick={() => toggleMemory(true)}
            >
              {t("chat.settings.general.sandboxOn")}
            </button>
            <button
              type="button"
              className={cn("hud-btn sm", memoryCfg?.enabled === false ? "hud-btn-cyan" : "hud-btn-ghost")}
              data-memory-option="off"
              aria-pressed={memoryCfg?.enabled === false}
              onClick={() => toggleMemory(false)}
            >
              {t("chat.settings.general.sandboxOff")}
            </button>
          </div>
          {/* 批1：无默认 embedding 端点 → 记忆不可开启（开关置灰 + 引导去向量
              tab 设默认——与服务闸同判据：默认端点在场才可用） */}
          {defaultEmbeddingEndpointId === null && (
            <span className="ag-note" data-memory-no-default role="note">
              {t("chat.settings.general.memoryNoDefaultEndpoint")}
            </span>
          )}
          {memoryError !== null && (
            <span className="mcp-err" data-memory-save-error role="alert">
              {memoryError}
            </span>
          )}
        </div>
        {memoryCfg?.enabled === true && (
          <>
            {/* 判官端点（B4a：kind=classifier 端点——查重精判；未配 = 精判静默
                回退纯向量高阈值） */}
            <div className="fld fld-sub" data-memory-judge>
              {embeddingEndpoints !== null && embeddingEndpoints.filter((ep) => ep.kind === "classifier").length > 0 ? (
                <div className="sel-wrap">
                  <select
                    className="hud-input"
                    data-memory-judge-select
                    value={memoryCfg.judgeEndpoint?.id ?? ""}
                    onChange={(e) => selectJudgeEndpoint(e.target.value)}
                  >
                    <option value="">{t("chat.settings.general.memoryJudgePlaceholder")}</option>
                    {embeddingEndpoints
                      .filter((ep) => ep.kind === "classifier")
                      .map((ep) => (
                        <option key={ep.id} value={ep.id}>
                          {`${ep.name} (${ep.model})`}
                        </option>
                      ))}
                  </select>
                </div>
              ) : (
                <button
                  type="button"
                  className="hud-btn hud-btn-ghost sm"
                  data-memory-judge-go-config
                  onClick={onOpenModelsEmbeddingTab}
                >
                  {t("chat.settings.general.memoryGoConfig")}
                </button>
              )}
              <span className="ag-note">{t("chat.settings.general.memoryJudgeNote")}</span>
            </div>
            {/* 召回量两键（memory.recallTopK / memory.recallPool——缺省 5/24；
                非法值（非 1-200 整数）失焦回落最近已提交值零命令；组合语义
                （topK ≤ pool）由 daemon 读面裁决回执生效值回显） */}
            <div className="fld fld-sub" data-memory-topk>
              <label className="hud-label" htmlFor="memory-topk-input">
                {t("chat.settings.general.memoryTopKLabel")}
              </label>
              <input
                id="memory-topk-input"
                className="hud-input"
                type="number"
                min={1}
                max={MEMORY_RECALL_INPUT_MAX}
                data-memory-topk-input
                value={topKDraft}
                onChange={(e) => setTopKDraft(e.target.value)}
                onBlur={() => commitRecallDraft("topK")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRecallDraft("topK");
                }}
              />
              <span className="ag-note">{t("chat.settings.general.memoryTopKNote")}</span>
            </div>
            <div className="fld fld-sub" data-memory-pool>
              <label className="hud-label" htmlFor="memory-pool-input">
                {t("chat.settings.general.memoryPoolLabel")}
              </label>
              <input
                id="memory-pool-input"
                className="hud-input"
                type="number"
                min={1}
                max={MEMORY_RECALL_INPUT_MAX}
                data-memory-pool-input
                value={poolDraft}
                onChange={(e) => setPoolDraft(e.target.value)}
                onBlur={() => commitRecallDraft("pool")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRecallDraft("pool");
                }}
              />
              <span className="ag-note">{t("chat.settings.general.memoryPoolNote")}</span>
            </div>
            {/* 召回资格阈值（memory.recallMinScore——缺省 0.3，值域 0-1；
                非法值失焦回落最近已提交值零命令；生效值由 daemon 读面裁决
                回执回显——闸砍在裸相似度上、融合排序之前） */}
            <div className="fld fld-sub" data-memory-score>
              <label className="hud-label" htmlFor="memory-score-input">
                {t("chat.settings.general.memoryScoreLabel")}
              </label>
              <input
                id="memory-score-input"
                className="hud-input"
                type="number"
                min={0}
                max={1}
                step={0.1}
                data-memory-score-input
                value={scoreDraft}
                onChange={(e) => setScoreDraft(e.target.value)}
                onBlur={() => commitRecallDraft("score")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRecallDraft("score");
                }}
              />
              <span className="ag-note">{t("chat.settings.general.memoryScoreNote")}</span>
            </div>
          </>
        )}
        {/* 观测与入口：条目计数（零条目不显示）+ 待命提示（开启但端点未就绪）
            + 管理记忆链接（跳记忆独立页 /steward/memory） */}
        {memoryCfg !== null && memoryCfg.entryCount > 0 && (
          <span className="ag-note" data-memory-count>
            {t("chat.settings.general.memoryEntries", { count: memoryCfg.entryCount })}
          </span>
        )}
        {memoryCfg !== null && memoryCfg.enabled && !memoryCfg.available && (
          <span className="ag-note" data-memory-pending>
            {t("chat.settings.general.memoryPending")}
          </span>
        )}
        {memoryCfg?.enabled === true && (
          <div className="fld fld-sub" data-memory-manage>
            <button
              type="button"
              className="hud-btn hud-btn-ghost sm"
              data-memory-manage-link
              onClick={onOpenMemory}
            >
              {t("chat.settings.general.memoryManage")}
            </button>
          </div>
        )}
      </div>

      {/* 知识库（批2 WP-C「知识库」配置组）：查重阈值两输入——写面
          config.set_kg，回执对账驱动（TR-84：「已保存」结果帧驱动不乐观置位 /
          send false 必消费 / connection.error 在途收口——useConfigField 单点）。
          **配置组归宿纪律（D4）**：本组是 kg 展面配置的归宿——后续 kg 新增
          可配置项（不限于查重阈值）一律落此组，不散落他组。 */}
      <h3 className="section-label gen-group-label">{t("chat.settings.general.groupKg")}</h3>
      <div className="hud-card" data-kg-card>
        <div className="fld" data-kg-warn>
          <label className="hud-label" htmlFor="kg-warn-input">
            {t("chat.settings.general.kgWarnLabel")}
          </label>
          <input
            id="kg-warn-input"
            className="hud-input"
            type="number"
            min={0}
            max={1}
            step={0.01}
            data-kg-warn-input
            value={kgWarnDraft}
            onChange={(e) => kgField.setInput(0, e.target.value)}
            onBlur={() => commitKgThreshold("warn")}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitKgThreshold("warn");
            }}
          />
          <span className="ag-note">{t("chat.settings.general.kgWarnNote")}</span>
        </div>
        <div className="fld" data-kg-dup>
          <label className="hud-label" htmlFor="kg-dup-input">
            {t("chat.settings.general.kgDupLabel")}
          </label>
          <input
            id="kg-dup-input"
            className="hud-input"
            type="number"
            min={0}
            max={1}
            step={0.01}
            data-kg-dup-input
            value={kgDupDraft}
            onChange={(e) => kgField.setInput(1, e.target.value)}
            onBlur={() => commitKgThreshold("dup")}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitKgThreshold("dup");
            }}
          />
          <span className="ag-note">{t("chat.settings.general.kgDupNote")}</span>
        </div>
        {kgField.saved && (
          <span className="ag-note" data-kg-saved>
            {t("chat.settings.general.saved")}
          </span>
        )}
        {kgField.saveError !== null && (
          <span className="mcp-err" data-kg-save-error role="alert">
            {kgField.saveError}
          </span>
        )}
      </div>

      {/* 关于 daemon（stale-indicator 批，§17.15）：连接信息区——welcome
          daemonFreshness.startedAt 人话时间（未握手/旧 daemon 兑底文案） */}
      <h3 className="section-label gen-group-label">{t("chat.settings.general.groupAbout")}</h3>
      <div className="hud-card" data-daemon-info>
        <div className="fld">
          <span className="hud-label">{t("chat.settings.general.daemonStartedAt")}</span>
          <span className="ag-note" data-daemon-started-at>
            {state.daemonFreshness !== null
              ? new Date(state.daemonFreshness.startedAt).toLocaleString()
              : t("chat.settings.general.daemonStartedUnknown")}
          </span>
        </div>
      </div>
    </div>
  );
};

export default GeneralSettingsSection;
