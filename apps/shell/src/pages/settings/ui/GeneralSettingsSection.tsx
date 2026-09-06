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
 *
 * 三卡状态机单点（M10 批⑤）：dirty/pending/saved 三件套 + 结果帧对账 +
 * 在途失败收口归 useConfigField（settings-hooks.ts）——config.set_* daemon
 * 失败走 connection.error（无结果帧），hook 内清 pending + 行内错误交代
 * （M10 批②：不假「已保存」、在途不永锁致后续读帧被误当保存回执）。
 */
import { useEffect } from "react";
import { useI18n, type Lang } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";
import { cn } from "@/shared/lib/cn";
import WorkspaceSettingsSection from "./WorkspaceSettingsSection";
import { useConfigField } from "./settings-hooks";

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

  // 进入分区拉取现值（未请求态才发）
  useEffect(() => {
    requestCompactionConfig();
    requestSchedulingConfig();
    requestPortConfig();
  }, [requestCompactionConfig, requestSchedulingConfig, requestPortConfig]);

  const save = () => {
    // M45：显式拒空串（Number("")===0 过整数校验会静默写 0）
    if (reserve.trim() === "" || keepRecent.trim() === "") return;
    const r = Number(reserve);
    const k = Number(keepRecent);
    if (!Number.isInteger(r) || !Number.isInteger(k) || r < 0 || k < 0) return;
    compactionField.submit(() => setCompactionConfig(r, k));
  };

  const saveScheduling = () => {
    if (maxConcurrent.trim() === "" || maxQueued.trim() === "") return;
    const c = Number(maxConcurrent);
    const q = Number(maxQueued);
    if (!Number.isInteger(c) || !Number.isInteger(q) || c < 1 || q < 0) return;
    schedulingField.submit(() => setSchedulingConfig(c, q));
  };

  const savePort = () => {
    if (portInput.trim() === "") return;
    const p = Number(portInput);
    if (!Number.isInteger(p) || p < 0 || p > 65535) return;
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
            onChange={(e) => compactionField.setInput(0, e.target.value)}
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
            onChange={(e) => compactionField.setInput(1, e.target.value)}
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
            onChange={(e) => schedulingField.setInput(0, e.target.value)}
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
            onChange={(e) => schedulingField.setInput(1, e.target.value)}
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
            onChange={(e) => portField.setInput(0, e.target.value)}
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
