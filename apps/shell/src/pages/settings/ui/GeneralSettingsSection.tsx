/**
 * 设置页「通用」分区（语言切换 + 工作空间 + 压缩参数 + 调度预算 + 端口）。
 *
 * 语言切换：useI18n().setLang 直写（helix-lang localStorage 持久化 +
 * document.lang 同步），纯壳端偏好不走 daemon 配置命令。
 * 工作空间：原独立分区撤项并入（单配置独占一页浪费），卡片本体在
 * WorkspaceSettingsSection（当前绑定 + 切换入口，F2 活跃禁用语义不变）。
 * 压缩参数数据面：topology.modelConfig.compaction（config.get/set_compaction
 * 帧驱动，无乐观更新——写面靠 result 帧回填）；进入分区时
 * requestCompactionConfig 拉取现值。两个 token 绝对值输入框 + 保存按钮
 * （非负整数校验）。
 * 调度预算/端口（config 瘦身批同构）：modelConfig.scheduling / port 帧驱动
 * 同模式；调度写入下一次预算判定即生效（无重启提示），端口写入下次启动
 * 生效（UI 标注 + argv 覆盖态展示）。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n, type Lang } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";
import { cn } from "@/shared/lib/cn";
import WorkspaceSettingsSection from "./WorkspaceSettingsSection";

/** 语言选项（按钮文案自命名词条：chat.settings.general.langZh/langEn）。 */
const LANG_OPTIONS: { id: Lang; labelKey: string }[] = [
  { id: "zh-CN", labelKey: "chat.settings.general.langZh" },
  { id: "en-US", labelKey: "chat.settings.general.langEn" },
];

const GeneralSettingsSection = function GeneralSettingsSection() {
  const { t, lang, setLang } = useI18n();
  const { topology, requestCompactionConfig, setCompactionConfig, requestSchedulingConfig, setSchedulingConfig, requestPortConfig, setPortConfig } = useSession();
  const compaction = topology.modelConfig.compaction;
  const scheduling = topology.modelConfig.scheduling;
  const portCfg = topology.modelConfig.port;

  const [reserve, setReserve] = useState("");
  const [keepRecent, setKeepRecent] = useState("");
  const [saved, setSaved] = useState(false);
  /** 用户未保存编辑（M46：脏态下结果帧不回填覆盖输入框）。 */
  const dirtyRef = useRef(false);
  /** 保存在途（M44：「已保存」由 set_compaction.result 结果帧驱动，非乐观置位）。 */
  const pendingSaveRef = useRef(false);

  // 调度预算输入（config 瘦身批；与压缩参数同构的脏态/在途门控）
  const [maxConcurrent, setMaxConcurrent] = useState("");
  const [maxQueued, setMaxQueued] = useState("");
  const [schedSaved, setSchedSaved] = useState(false);
  const schedDirtyRef = useRef(false);
  const schedPendingRef = useRef(false);

  // 端口输入（同构；写入下次启动生效）
  const [portInput, setPortInput] = useState("");
  const [portSaved, setPortSaved] = useState(false);
  const portDirtyRef = useRef(false);
  const portPendingRef = useRef(false);

  // 进入分区拉取现值（未请求态才发）
  useEffect(() => {
    requestCompactionConfig();
    requestSchedulingConfig();
    requestPortConfig();
  }, [requestCompactionConfig, requestSchedulingConfig, requestPortConfig]);

  // 结果帧到达：保存在途对账 → 落「已保存」（M44 真实反馈）；
  // 非在途且用户有未保存编辑 → 不回填覆盖（M46 dirty 门控）
  useEffect(() => {
    if (compaction === null) return;
    if (pendingSaveRef.current) {
      pendingSaveRef.current = false;
      dirtyRef.current = false;
      setReserve(String(compaction.reserveTokens));
      setKeepRecent(String(compaction.keepRecentTokens));
      setSaved(true);
      return;
    }
    if (dirtyRef.current) return;
    setReserve(String(compaction.reserveTokens));
    setKeepRecent(String(compaction.keepRecentTokens));
  }, [compaction]);

  const save = () => {
    // M45：显式拒空串（Number("")===0 过整数校验会静默写 0）
    if (reserve.trim() === "" || keepRecent.trim() === "") return;
    const r = Number(reserve);
    const k = Number(keepRecent);
    if (!Number.isInteger(r) || !Number.isInteger(k) || r < 0 || k < 0) return;
    pendingSaveRef.current = true;
    setSaved(false);
    setCompactionConfig(r, k);
  };

  // 结果帧到达（调度）：在途对账/脏态门控（与压缩参数同构）
  useEffect(() => {
    if (scheduling === null) return;
    if (schedPendingRef.current) {
      schedPendingRef.current = false;
      schedDirtyRef.current = false;
      setMaxConcurrent(String(scheduling.maxConcurrent));
      setMaxQueued(String(scheduling.maxQueued));
      setSchedSaved(true);
      return;
    }
    if (schedDirtyRef.current) return;
    setMaxConcurrent(String(scheduling.maxConcurrent));
    setMaxQueued(String(scheduling.maxQueued));
  }, [scheduling]);

  const saveScheduling = () => {
    if (maxConcurrent.trim() === "" || maxQueued.trim() === "") return;
    const c = Number(maxConcurrent);
    const q = Number(maxQueued);
    if (!Number.isInteger(c) || !Number.isInteger(q) || c < 1 || q < 0) return;
    schedPendingRef.current = true;
    setSchedSaved(false);
    setSchedulingConfig(c, q);
  };

  // 结果帧到达（端口）：在途对账/脏态门控（同构）
  useEffect(() => {
    if (portCfg === null) return;
    if (portPendingRef.current) {
      portPendingRef.current = false;
      portDirtyRef.current = false;
      setPortInput(portCfg.storedPort !== null ? String(portCfg.storedPort) : "");
      setPortSaved(true);
      return;
    }
    if (portDirtyRef.current) return;
    setPortInput(portCfg.storedPort !== null ? String(portCfg.storedPort) : "");
  }, [portCfg]);

  const savePort = () => {
    if (portInput.trim() === "") return;
    const p = Number(portInput);
    if (!Number.isInteger(p) || p < 0 || p > 65535) return;
    portPendingRef.current = true;
    setPortSaved(false);
    setPortConfig(p);
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
              setReserve(e.target.value);
              dirtyRef.current = true;
              setSaved(false);
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
              setKeepRecent(e.target.value);
              dirtyRef.current = true;
              setSaved(false);
            }}
          />
        </div>
        <button type="button" className="hud-btn hud-btn-cyan" data-compaction-save onClick={save}>
          {t("chat.settings.general.save")}
        </button>
        {saved && (
          <span className="ag-note" data-compaction-saved>
            {t("chat.settings.general.saved")}
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
              setMaxConcurrent(e.target.value);
              schedDirtyRef.current = true;
              setSchedSaved(false);
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
              setMaxQueued(e.target.value);
              schedDirtyRef.current = true;
              setSchedSaved(false);
            }}
          />
        </div>
        <button type="button" className="hud-btn hud-btn-cyan" data-sched-save onClick={saveScheduling}>
          {t("chat.settings.general.save")}
        </button>
        {schedSaved && (
          <span className="ag-note" data-sched-saved>
            {t("chat.settings.general.saved")}
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
              setPortInput(e.target.value);
              portDirtyRef.current = true;
              setPortSaved(false);
            }}
          />
        </div>
        <button type="button" className="hud-btn hud-btn-cyan" data-port-save onClick={savePort}>
          {t("chat.settings.general.save")}
        </button>
        {portSaved && (
          <span className="ag-note" data-port-saved>
            {t("chat.settings.general.saved")}
          </span>
        )}
        <span className="ag-note">{t("chat.settings.general.portNote")}</span>
        {portCfg !== null && portCfg.overriddenByArgv && (
          <span className="ag-note" data-port-argv-override>
            {t("chat.settings.general.portArgvOverride", { port: portCfg.effectivePort })}
          </span>
        )}
      </div>
    </div>
  );
};

export default GeneralSettingsSection;
