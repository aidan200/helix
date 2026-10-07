/**
 * 设置页「通用」分区（语言切换 + 管家开关 + 工作空间 + 压缩参数 + 调度预算 + 端口 + 沙箱开关）。
 *
 * 语言切换：useI18n().setLang 直写（helix-lang localStorage 持久化 +
 * document.lang 同步），纯壳端偏好不走 daemon 配置命令。
 * 管家（管家配置并轨批）：启用开关 = daemon 权威（steward.get_config 进入拉取
 * + set_config 写、config.result 回执回填，不乐观）；语音播报 = 本地偏好
 * （helix.steward.speakReply，面板语音模式朗读闸逐次读）——仅启用后显示
 * （从属项，缩进一层），非平级。管家模型槽位在智能体页管家卡。
 * 总结（会话总结器独立化批①）：「总结」组 = 三产物开关 + 轮次输入 + 总结
 * 模型下拉 + 任务总结两项——写面 config.set_summary（summary.* 通用域），
 * config.get/set_summary.result 回填不乐观；管家配置零总结项。总结模型显式
 * 配才产进展+记忆点（无默认纪律），标题回落默认模型。
 * 管家记忆区（B2 瘦身）：开关 + 「向量模型」下拉（embedding.list 驱动，
 * 选中写 steward.set_config {memory:{endpointId}}）+ 待命提示 + 「管理记忆」
 * 链接（跳记忆独立页 /steward/memory）；端点 CRUD 收编模型页向量 tab
 * （B1 的三字段 + 预置选择器形态退役）；空列表 → 引导链接跳向量 tab。
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
  const { state, topology, requestCompactionConfig, setCompactionConfig, requestSchedulingConfig, setSchedulingConfig, requestPortConfig, setPortConfig, requestSandboxConfig, setSandboxConfig, requestSummaryConfig, setSummaryConfig, requestModelConfig, requestAuthList, subscribeConfigFrames, sendStewardGetConfig, sendStewardSetConfig, subscribeStewardFrames, sendEmbeddingList, subscribeEmbeddingFrames } = useSession();
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
  // 记忆（管家记忆 B2 瘦身）：daemon 权威现态（config.result 回执回填，不乐观）；
  // 端点选择 = embedding 配置域引用（下拉写 endpointId，回执引用态回填）
  const [memoryCfg, setMemoryCfg] = useState<{
    enabled: boolean;
    available: boolean;
    endpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
    judgeEndpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
    entryCount: number;
    dim: number | null;
  } | null>(null);
  const [embeddingEndpoints, setEmbeddingEndpoints] = useState<readonly EmbeddingEndpointView[] | null>(null);
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
            endpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
            judgeEndpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
            entryCount: number;
            dim: number | null;
          };
        };
        setStewardEnabled(payload.enabled === true);
        if (payload.memory !== undefined) setMemoryCfg(payload.memory);
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
  const toggleMemory = (enabled: boolean): void => {
    if (sendStewardSetConfig({ memory: { enabled } }) === false) {
      setStewardError(t("chat.settings.general.sendFail"));
      return;
    }
    setStewardError(null);
  };
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
  // 向量模型选择（写 endpointId 引用；空串 = 清除引用）；回执驱动回填不乐观
  const selectMemoryEndpoint = (endpointId: string): void => {
    if (sendStewardSetConfig({ memory: { endpointId } }) === false) {
      setStewardError(t("chat.settings.general.sendFail"));
      return;
    }
    setStewardError(null);
  };
  // 判官端点选择（B4a：写 judgeEndpointId 引用——kind=classifier 端点才可选）
  const selectJudgeEndpoint = (judgeEndpointId: string): void => {
    if (sendStewardSetConfig({ memory: { judgeEndpointId } }) === false) {
      setStewardError(t("chat.settings.general.sendFail"));
      return;
    }
    setStewardError(null);
  };

  const toggleSandbox = (enabled: boolean): void => {
    if (setSandboxConfig({ enabled }) === false) {
      setSandboxError(t("chat.settings.general.sendFail"));
      return;
    }
    setSandboxError(null);
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
        // 管家记忆 B1：steward.set_config 校验失败（如开启记忆前端点未配）
        // 同面交代——命令尾缀归因辨识写面
        if (cmd === "steward.set_config") {
          setStewardError(message);
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
    requestModelConfig();
    requestAuthList();
  }, [requestCompactionConfig, requestSchedulingConfig, requestPortConfig, requestSandboxConfig, requestSummaryConfig, requestModelConfig, requestAuthList]);

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
        {/* 记忆（管家记忆 B2 瘦身）：启用管家的从属项（缩进一层）——开关 +
            「向量模型」下拉（embedding.list 驱动，选中写 endpointId 引用）；
            端点 CRUD 收编模型页向量 tab，空列表显示引导链接 */}
        {stewardEnabled === true && (
          <div className="fld fld-sub" data-steward-memory>
            <span className="hud-label">{t("chat.settings.general.stewardMemory")}</span>
            <label className="set-check" data-steward-memory-enabled>
              <input
                type="checkbox"
                checked={memoryCfg?.enabled === true}
                onChange={(e) => toggleMemory(e.target.checked)}
              />
              {t("chat.settings.general.stewardSwitchOn")}
            </label>
            {memoryCfg !== null && memoryCfg.entryCount > 0 && (
              <span className="ag-note" data-steward-memory-count>
                {t("chat.settings.general.stewardMemoryEntries", { count: memoryCfg.entryCount })}
              </span>
            )}
            {memoryCfg !== null && memoryCfg.enabled && !memoryCfg.available && (
              <span className="ag-note" data-steward-memory-pending>
                {t("chat.settings.general.stewardMemoryPending")}
              </span>
            )}
          </div>
        )}
        {stewardEnabled === true && memoryCfg?.enabled === true && (
          <div className="fld fld-sub" data-steward-memory-endpoint>
            {embeddingEndpoints !== null && embeddingEndpoints.filter((ep) => (ep.kind ?? "embedding") === "embedding").length > 0 ? (
              <div className="sel-wrap">
                <select
                  className="hud-input"
                  data-steward-memory-endpoint-select
                  value={memoryCfg.endpoint?.id ?? ""}
                  onChange={(e) => selectMemoryEndpoint(e.target.value)}
                >
                  <option value="">{t("chat.settings.general.stewardMemoryEndpointPlaceholder")}</option>
                  {embeddingEndpoints
                    .filter((ep) => (ep.kind ?? "embedding") === "embedding")
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
                data-steward-memory-go-config
                onClick={onOpenModelsEmbeddingTab}
              >
                {t("chat.settings.general.stewardMemoryGoConfig")}
              </button>
            )}
            <span className="ag-note">{t("chat.settings.general.stewardMemoryEndpointNote")}</span>
          </div>
        )}
        {/* 判官端点下拉（B4a：kind=classifier 端点；未配 = 自动沉淀静默不挂） */}
        {stewardEnabled === true && memoryCfg?.enabled === true && (
          <div className="fld fld-sub" data-steward-memory-judge>
            {embeddingEndpoints !== null && embeddingEndpoints.filter((ep) => ep.kind === "classifier").length > 0 ? (
              <div className="sel-wrap">
                <select
                  className="hud-input"
                  data-steward-memory-judge-select
                  value={memoryCfg.judgeEndpoint?.id ?? ""}
                  onChange={(e) => selectJudgeEndpoint(e.target.value)}
                >
                  <option value="">{t("chat.settings.general.stewardMemoryJudgePlaceholder")}</option>
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
                data-steward-memory-judge-go-config
                onClick={onOpenModelsEmbeddingTab}
              >
                {t("chat.settings.general.stewardMemoryGoConfig")}
              </button>
            )}
            <span className="ag-note">{t("chat.settings.general.stewardMemoryJudgeNote")}</span>
          </div>
        )}
        {/* 入口②：管理记忆链接（跳记忆独立页 /steward/memory——mock 内嵌区退役） */}
        {stewardEnabled === true && memoryCfg?.enabled === true && (
          <div className="fld fld-sub" data-steward-memory-manage>
            <button
              type="button"
              className="hud-btn hud-btn-ghost sm"
              data-steward-memory-manage-link
              onClick={onOpenMemory}
            >
              {t("chat.settings.general.stewardMemoryManage")}
            </button>
          </div>
        )}
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
