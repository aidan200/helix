/**
 * 设置页「通用」分区（语言切换 + 管家开关 + 工作空间 + 压缩参数 + 调度预算 + 端口 + 沙箱开关）。
 *
 * 语言切换：useI18n().setLang 直写（helix-lang localStorage 持久化 +
 * document.lang 同步），纯壳端偏好不走 daemon 配置命令。
 * 管家（管家配置并轨批）：启用开关 = daemon 权威（steward.get_config 进入拉取
 * + set_config 写、config.result 回执回填，不乐观）；语音播报 = 本地偏好
 * （helix.steward.speakReply，面板语音模式朗读闸逐次读）——仅启用后显示
 * （从属项，缩进一层），非平级。管家模型槽位在智能体页管家卡。
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
import { useEffect, useState } from "react";
import { useI18n, type Lang } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";
import { cn } from "@/shared/lib/cn";
import { readStewardSpeakReplyPref, writeStewardSpeakReplyPref } from "@/shared/lib/voice-pref";
import WorkspaceSettingsSection from "./WorkspaceSettingsSection";
import { useConfigField } from "./settings-hooks";
import MemoryManageSection from "./MemoryManageSection";

/** 语言选项（按钮文案自命名词条：chat.settings.general.langZh/langEn）。 */
const LANG_OPTIONS: { id: Lang; labelKey: string }[] = [
  { id: "zh-CN", labelKey: "chat.settings.general.langZh" },
  { id: "en-US", labelKey: "chat.settings.general.langEn" },
];

const GeneralSettingsSection = function GeneralSettingsSection() {
  const { t, lang, setLang } = useI18n();
  const { state, topology, requestCompactionConfig, setCompactionConfig, requestSchedulingConfig, setSchedulingConfig, requestPortConfig, setPortConfig, requestSandboxConfig, setSandboxConfig, subscribeConfigFrames, sendStewardGetConfig, sendStewardSetConfig, subscribeStewardFrames } = useSession();
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
  // 记忆（管家记忆 B1）：daemon 权威现态（config.result 回执回填，不乐观）；
  // 端点三字段 = 本地编辑态 null 未编辑（展示现值），保存走部分更新
  const [memoryCfg, setMemoryCfg] = useState<{
    enabled: boolean;
    available: boolean;
    endpoint: { baseUrl: string; model: string; hasApiKey: boolean } | null;
    entryCount: number;
    dim: number | null;
  } | null>(null);
  const [memBaseUrlDraft, setMemBaseUrlDraft] = useState<string | null>(null);
  const [memModelDraft, setMemModelDraft] = useState<string | null>(null);
  const [memApiKeyDraft, setMemApiKeyDraft] = useState<string | null>(null);
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
            endpoint: { baseUrl: string; model: string; hasApiKey: boolean } | null;
            entryCount: number;
            dim: number | null;
          };
        };
        setStewardEnabled(payload.enabled === true);
        if (payload.memory !== undefined) setMemoryCfg(payload.memory);
      }),
    [subscribeStewardFrames],
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
  // 预置接入方式（选中即自动保存端点两字段——本地 Ollama 用户一键可用；
  // 自定义 = 只切到手动填模式不动配置；apiKey 不携带 = daemon 合并现值）
  const applyMemoryPreset = (preset: string): void => {
    const presetValues: Record<string, { baseUrl: string; model: string }> = {
      ollama: { baseUrl: "http://localhost:11434/v1", model: "bge-m3" },
      openai: { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small" },
    };
    const picked = presetValues[preset];
    if (picked === undefined) return;
    if (sendStewardSetConfig({ memory: picked }) === false) {
      setStewardError(t("chat.settings.general.sendFail"));
      return;
    }
    setStewardError(null);
    setMemBaseUrlDraft(null);
    setMemModelDraft(null);
  };
  const saveMemoryEndpoint = (): void => {
    if (
      sendStewardSetConfig({
        memory: {
          baseUrl: memBaseUrlDraft ?? memoryCfg?.endpoint?.baseUrl ?? "",
          model: memModelDraft ?? memoryCfg?.endpoint?.model ?? "",
          // apiKey 未编辑 = 不动（daemon 侧合并现值——凭据只进不出，
          // 回执无原值可回填）；显式编辑（含清空）才携带
          ...(memApiKeyDraft !== null ? { apiKey: memApiKeyDraft } : {}),
        },
      }) === false
    ) {
      setStewardError(t("chat.settings.general.sendFail"));
      return;
    }
    setStewardError(null);
    setMemBaseUrlDraft(null);
    setMemModelDraft(null);
    setMemApiKeyDraft(null);
  };

  const toggleSandbox = (enabled: boolean): void => {
    if (setSandboxConfig({ enabled }) === false) {
      setSandboxError(t("chat.settings.general.sendFail"));
      return;
    }
    setSandboxError(null);
  };

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

  // 进入分区拉取现值（未请求态才发）
  useEffect(() => {
    requestCompactionConfig();
    requestSchedulingConfig();
    requestPortConfig();
    requestSandboxConfig();
  }, [requestCompactionConfig, requestSchedulingConfig, requestPortConfig, requestSandboxConfig]);

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
        {/* 记忆（管家记忆 B1）：启用管家的从属项（缩进一层）——开关开才展开
            端点配置（再缩进一层，与语音播报同一套从属语言）；daemon 权威
            回执回填，校验失败经 connection.error（steward.set_config 尾缀）交代 */}
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
            <div className="sel-wrap">
              <select
                className="hud-input"
                data-steward-memory-preset
                value=""
                onChange={(e) => applyMemoryPreset(e.target.value)}
              >
                <option value="">{t("chat.settings.general.stewardMemoryPresetPlaceholder")}</option>
                <option value="ollama">{t("chat.settings.general.stewardMemoryPresetOllama")}</option>
                <option value="openai">{t("chat.settings.general.stewardMemoryPresetOpenai")}</option>
                <option value="custom">{t("chat.settings.general.stewardMemoryPresetCustom")}</option>
              </select>
            </div>
            <input
              className="hud-input"
              value={memBaseUrlDraft ?? memoryCfg.endpoint?.baseUrl ?? ""}
              placeholder={t("chat.settings.general.stewardMemoryBaseUrl")}
              data-steward-memory-baseurl
              onChange={(e) => setMemBaseUrlDraft(e.target.value)}
            />
            <input
              className="hud-input"
              value={memModelDraft ?? memoryCfg.endpoint?.model ?? ""}
              placeholder={t("chat.settings.general.stewardMemoryModel")}
              data-steward-memory-model
              onChange={(e) => setMemModelDraft(e.target.value)}
            />
            <input
              className="hud-input"
              type="password"
              value={memApiKeyDraft ?? ""}
              placeholder={t("chat.settings.general.stewardMemoryApiKey")}
              data-steward-memory-apikey
              onChange={(e) => setMemApiKeyDraft(e.target.value)}
            />
            <button
              type="button"
              className="hud-btn hud-btn-cyan"
              data-steward-memory-save
              disabled={memBaseUrlDraft === null && memModelDraft === null && memApiKeyDraft === null}
              onClick={saveMemoryEndpoint}
            >
              {t("chat.settings.general.stewardMemorySave")}
            </button>
          </div>
        )}
        {/* 记忆管理（B2）：条目列表 + 手动增删改——mock 数据先行 */}
        {stewardEnabled === true && memoryCfg?.enabled === true && (
          <div className="fld fld-sub" data-steward-memory-manage>
            <MemoryManageSection />
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
