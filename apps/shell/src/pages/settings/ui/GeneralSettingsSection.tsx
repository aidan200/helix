/**
 * 设置页「通用」分区（压缩参数配置）。
 *
 * 数据面：topology.modelConfig.compaction（config.get/set_compaction 帧驱动，
 * 无乐观更新——写面靠 result 帧回填）；进入分区时 requestCompactionConfig
 * 拉取现值。两个 token 绝对值输入框 + 保存按钮（非负整数校验）。
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";

const GeneralSettingsSection = function GeneralSettingsSection() {
  const { t } = useI18n();
  const { topology, requestCompactionConfig, setCompactionConfig } = useSession();
  const compaction = topology.modelConfig.compaction;

  const [reserve, setReserve] = useState("");
  const [keepRecent, setKeepRecent] = useState("");
  const [saved, setSaved] = useState(false);

  // 进入分区拉取现值（未请求态才发）
  useEffect(() => {
    requestCompactionConfig();
  }, [requestCompactionConfig]);

  // 结果帧到达 → 回填输入框
  useEffect(() => {
    if (compaction !== null) {
      setReserve(String(compaction.reserveTokens));
      setKeepRecent(String(compaction.keepRecentTokens));
    }
  }, [compaction]);

  const save = () => {
    const r = Number(reserve);
    const k = Number(keepRecent);
    if (!Number.isInteger(r) || !Number.isInteger(k) || r < 0 || k < 0) return;
    setCompactionConfig(r, k);
    setSaved(true);
  };

  return (
    <div className="pg" data-general-section>
      <h2 className="pg-title">{t("chat.settings.general.title")}</h2>
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
    </div>
  );
};

export default GeneralSettingsSection;
