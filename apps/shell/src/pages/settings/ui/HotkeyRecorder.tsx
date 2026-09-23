/**
 * HotkeyRecorder —— 全局组合键录制控件（B4 设置页管家组「快捷键（组合键）」）。
 *
 * 按键录制形态（brief 口径）：点击「录制」进入录制态（回显切录制提示）→
 * 按下合法组合即定格显示（如「⌘⇧K」）并写本地偏好 + 触发注册热更新；
 * Esc 取消（值不变、偏好零写入）；无修饰单键拒收（行内提示 + 留在录制态）；
 * 与现值相同的组合 = 冲突重复值（行内提示 + 留在录制态）；注册失败（组合键
 * 被其他应用占用等）行内错误交代。清除钮 = 卸下组合键（回「未设置」）。
 *
 * 录制期间暂注（suspend）：录制按键若恰为已注册组合键会同时触发全局快捷键
 * ——进录制先 unregister、收尾 sync 恢复（wake-hotkey 注册面单点热更新）。
 * 样式对齐设置页 fld/hud-label 控件模式（GeneralSettingsSection 同款
 * hud-btn sm + mcp-err 行内提示）；纯浏览器 dev 无壳能力 = 录制/存储照常，
 * 注册面休眠（unavailable 零报错）。
 */
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { captureCombo } from "@/shared/lib/hotkey-combo";
import { readWakeHotkeyPref, writeWakeHotkeyPref } from "@/shared/lib/voice-pref";
import { syncWakeHotkeyRegistration } from "@/shared/lib/wake-hotkey";

const HotkeyRecorder = function HotkeyRecorder() {
  const { t } = useI18n();
  const [value, setValue] = useState<string | null>(() => readWakeHotkeyPref());
  const [recording, setRecording] = useState(false);
  /** 录制态行内提示（need-modifier 拒单键 / conflict 重复值；互斥）。 */
  const [hint, setHint] = useState<"none" | "need-modifier" | "duplicate">("none");
  const [registerError, setRegisterError] = useState(false);

  /** 提交新值（含清除）：写偏好 + 注册热更新（unregister+register 差分）。 */
  const commit = useCallback(async (combo: string | null) => {
    writeWakeHotkeyPref(combo);
    setValue(combo);
    setRecording(false);
    setHint("none");
    const res = await syncWakeHotkeyRegistration();
    setRegisterError(res === "failed");
  }, []);

  const startRecording = useCallback(() => {
    setRecording(true);
    setHint("none");
    setRegisterError(false);
    void syncWakeHotkeyRegistration({ suspend: true }); // 录制期间暂注（防自激）
  }, []);

  // 录制态按键捕获（capture 监听 + 阻断下沉——录制按键不得触发他域 Esc/
  // 快捷键处理）；非录制态零全局监听
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      const cap = captureCombo(e);
      if (cap.kind === "none") return; // 修饰键单独按下：不完整组合，继续等
      e.preventDefault();
      e.stopPropagation();
      if (cap.kind === "cancel") {
        setRecording(false);
        setHint("none");
        void syncWakeHotkeyRegistration(); // 取消收尾：恢复注册
        return;
      }
      if (cap.kind === "need-modifier") {
        setHint("need-modifier");
        return;
      }
      if (cap.combo === value) {
        setHint("duplicate"); // 冲突重复值：行内提示，留在录制态
        return;
      }
      void commit(cap.combo);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, value, commit]);

  return (
    <div className="hotkey-recorder" data-hotkey-recorder>
      <button
        type="button"
        className="hud-btn sm hud-btn-ghost"
        data-testid="hotkey-record"
        data-hotkey-record
        onClick={startRecording}
      >
        {t("chat.settings.general.stewardHotkeyRecord")}
      </button>
      <span className="ag-note" data-testid="hotkey-value" data-hotkey-value>
        {recording ? t("chat.settings.general.stewardHotkeyRecording") : (value ?? t("chat.settings.general.stewardHotkeyUnset"))}
      </span>
      {value !== null && !recording && (
        <button
          type="button"
          className="hud-btn sm hud-btn-ghost"
          data-testid="hotkey-clear"
          data-hotkey-clear
          onClick={() => void commit(null)}
        >
          {t("chat.settings.general.stewardHotkeyClear")}
        </button>
      )}
      {hint === "need-modifier" && (
        <span className="mcp-err" data-testid="hotkey-need-modifier" role="alert">
          {t("chat.settings.general.stewardHotkeyNeedModifier")}
        </span>
      )}
      {hint === "duplicate" && (
        <span className="mcp-err" data-testid="hotkey-duplicate" role="alert">
          {t("chat.settings.general.stewardHotkeyDuplicate")}
        </span>
      )}
      {registerError && (
        <span className="mcp-err" data-testid="hotkey-register-error" role="alert">
          {t("chat.settings.general.stewardHotkeyRegisterFail")}
        </span>
      )}
    </div>
  );
};

export default HotkeyRecorder;
