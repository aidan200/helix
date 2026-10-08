/**
 * VoiceprintSection —— 设置页声纹注册引导（M3-c 声纹批；E-263 管家组第五件，
 * 从属管家启用——GeneralSettingsSection 挂载）。
 *
 * 形态：未注册 = 说明（本地/不上传/存储位置）+ 注册入口；注册流程 = 引擎
 * 准备（模型下载带进度）→ 说 3-5 句（每句点一下，静音自动收口）→ 完成注册
 * （句向量均值模板）；已注册 = 测试按钮（实时相似度得分）+ 删除（彻底移除）。
 *
 * 注入面：service（缺省生产单例）与 recorder（缺省麦克风录音器——测试
 * 注入 fake；模型下载进度经动态 import embed-engine 直调 loadModelBytes，
 * service 引擎随后命中 IndexedDB 缓存零重复下载）。
 */
import { useCallback, useRef, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { getStewardVoiceprintService } from "../model/steward-voiceprint";
import type { VoiceprintService } from "../model/voiceprint-service";
import { VOICEPRINT_MAX_UTTERANCES, VOICEPRINT_MIN_UTTERANCE_SECONDS, VOICEPRINT_MIN_UTTERANCES } from "../model/speaker-verify";
import { createMicUtteranceRecorder, type UtteranceRecorder } from "./mic-recorder";
import { VoiceprintError } from "../model/voiceprint-service";

/** 单句最长采集（秒；到点强制收口）。 */
const UTTERANCE_MAX_SECONDS = 8;

type Phase = "idle" | "preparing" | "collecting" | "saving" | "saved";

export interface VoiceprintSectionProps {
  /** 声纹服务（缺省生产单例；测试注入）。 */
  readonly service?: VoiceprintService;
  /** 录句器（缺省麦克风录音器；测试注入 fake）。 */
  readonly recorder?: UtteranceRecorder;
  /** 模型准备面（缺省 = 动态 import embed-engine 直调 loadModelBytes——
   *  与 service 引擎共享 daemon 磁盘路由零重复拉取；测试注入 fake 免拖
   *  ort bundle）。 */
  readonly prepareModel?: (onProgress: (received: number, total: number | null) => void) => Promise<void>;
  /** 模型导入面（缺省 = 动态 import embed-engine 直调 importModelFile——
   *  GitHub 直连受阻时的手动通道；测试注入 fake）。 */
  readonly importModel?: (file: File) => Promise<void>;
}

const prepareModelViaEngine: NonNullable<VoiceprintSectionProps["prepareModel"]> = async (onProgress) => {
  const { loadModelBytes } = await import("../model/embed-engine");
  await loadModelBytes({ onProgress });
};

/** 手动导入（缺省 = 动态 import embed-engine 直调 importModelFile——PUT
 *  上行 daemon 落盘；测试注入 fake）。 */
const importModelViaEngine = async (file: File): Promise<void> => {
  const { importModelFile } = await import("../model/embed-engine");
  await importModelFile(file);
};

const VoiceprintSection = function VoiceprintSection({ service, recorder, prepareModel, importModel }: VoiceprintSectionProps) {
  const { t } = useI18n();
  const serviceRef = useRef<VoiceprintService>(service ?? getStewardVoiceprintService());
  serviceRef.current = service ?? getStewardVoiceprintService();
  const recorderRef = useRef<UtteranceRecorder>(recorder ?? createMicUtteranceRecorder());
  recorderRef.current = recorder ?? createMicUtteranceRecorder();
  const prepareModelRef = useRef<NonNullable<VoiceprintSectionProps["prepareModel"]>>(prepareModel ?? prepareModelViaEngine);
  prepareModelRef.current = prepareModel ?? prepareModelViaEngine;
  const [phase, setPhase] = useState<Phase>(() => (serviceRef.current.isRegistered() ? "saved" : "idle"));
  const [utterances, setUtterances] = useState<readonly Float32Array[]>([]);
  const [progress, setProgress] = useState<{ received: number; total: number | null } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [testScore, setTestScore] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // 结构化错误码 → 白话文案（model 层零 CJK，AG-16；白话硬约束 TR-249）
  const messageOfError = useCallback(
    (e: unknown): string => {
      if (e instanceof VoiceprintError) {
        if (e.code === "min-utterances") return t("chat.settings.general.voiceprintNeedMore", { n: VOICEPRINT_MIN_UTTERANCES });
        if (e.code === "max-utterances") return t("chat.settings.general.voiceprintTooMany", { n: VOICEPRINT_MAX_UTTERANCES });
        if (e.code === "utterance-too-short")
          return t("chat.settings.general.voiceprintShortSentence", { n: e.which ?? 1, s: VOICEPRINT_MIN_UTTERANCE_SECONDS });
        if (e.code === "not-registered") return t("chat.settings.general.voiceprintNotRegistered");
      }
      return t("chat.settings.general.voiceprintGenericFail");
    },
    [t],
  );

  // ── 注册入口：模型先就位（daemon 磁盘路由拉取带进度——拉不到走
  //    手动导入通道）。──
  const startRegister = useCallback(async () => {
    setErrorMessage(null);
    setTestScore(null);
    setPhase("preparing");
    setProgress({ received: 0, total: null });
    try {
      await prepareModelRef.current((received, total) => setProgress({ received, total }));
      setProgress(null);
      setUtterances([]);
      setPhase("collecting");
    } catch {
      setProgress(null);
      setErrorMessage(t("chat.settings.general.voiceprintDownloadFail"));
      setPhase("idle");
    }
  }, [t]);

  // ── 手动导入（GitHub 直连受阻：手动下载后选文件 → PUT 上行 daemon
  //    落盘 ~/.helix/models/ → 直接进入采句）。──
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importModelRef = useRef<NonNullable<VoiceprintSectionProps["importModel"]>>(importModel ?? importModelViaEngine);
  importModelRef.current = importModel ?? importModelViaEngine;
  const onImportPicked = useCallback(async () => {
    const file = fileInputRef.current?.files?.[0];
    if (file === undefined) return;
    setErrorMessage(null);
    setBusy(true);
    try {
      await importModelRef.current(file);
      setUtterances([]);
      setPhase("collecting");
    } catch {
      setErrorMessage(t("chat.settings.general.voiceprintImportFail"));
    } finally {
      setBusy(false);
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
    }
  }, [t]);

  // ── 说一句（每句点一下；静音自动收口在录音器内）。──
  const sayOne = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const pcm = await recorderRef.current.record(VOICEPRINT_MIN_UTTERANCE_SECONDS, UTTERANCE_MAX_SECONDS);
      if (pcm === null) {
        setErrorMessage(t("chat.settings.general.voiceprintMicFail"));
        return;
      }
      setUtterances((prev) => [...prev, pcm].slice(0, VOICEPRINT_MAX_UTTERANCES));
    } finally {
      setBusy(false);
    }
  }, [busy, t]);

  // ── 完成注册（service 校验句数/句长——白话错误直显，失败清句重录）。──
  const finishRegister = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await serviceRef.current.register(utterances);
      setUtterances([]);
      setErrorMessage(null);
      setPhase("saved");
    } catch (e) {
      setErrorMessage(messageOfError(e));
      setUtterances([]); // 清句重录（短句在列会反复失败）
    } finally {
      setBusy(false);
    }
  }, [busy, utterances]);

  // ── 测试（录一句 → 与模板实时相似度，百分比展示）。──
  const runTest = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setTestScore(null);
    setErrorMessage(null);
    try {
      const pcm = await recorderRef.current.record(VOICEPRINT_MIN_UTTERANCE_SECONDS, UTTERANCE_MAX_SECONDS);
      if (pcm === null) {
        setErrorMessage(t("chat.settings.general.voiceprintMicFail"));
        return;
      }
      const score = await serviceRef.current.test(pcm);
      setTestScore(score);
    } catch (e) {
      setErrorMessage(messageOfError(e));
    } finally {
      setBusy(false);
    }
  }, [busy, t]);

  // ── 删除（彻底移除——回到未注册形态）。──
  const removeVoiceprint = useCallback(() => {
    serviceRef.current.remove();
    setPhase("idle");
    setUtterances([]);
    setTestScore(null);
    setErrorMessage(null);
  }, []);

  return (
    <div data-voiceprint-section>
      {phase === "idle" && (
        <>
          <span className="ag-note" data-vp-note>
            {t("chat.settings.general.voiceprintNote")}
          </span>
          <button type="button" className="btn-ghost" data-vp-register onClick={() => void startRegister()}>
            {t("chat.settings.general.voiceprintRegister")}
          </button>
          <span className="ag-note">{t("chat.settings.general.voiceprintRegisterHint")}</span>
          {/* 手动导入通道（下载不动时）：隐藏 file input + 触发钮 */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".onnx,application/octet-stream"
            className="hidden"
            data-vp-file
            onChange={() => void onImportPicked()}
          />
          <button type="button" className="btn-ghost" data-vp-import disabled={busy} onClick={() => fileInputRef.current?.click()}>
            {t("chat.settings.general.voiceprintImport")}
          </button>
          <span className="ag-note">{t("chat.settings.general.voiceprintImportHint")}</span>
        </>
      )}
      {phase === "preparing" && (
        <span className="ag-note" data-vp-preparing>
          {progress === null
            ? t("chat.settings.general.voiceprintPreparing")
            : t("chat.settings.general.voiceprintDownloading", {
                mb: (progress.received / 1e6).toFixed(1),
                total: progress.total === null ? "27" : (progress.total / 1e6).toFixed(0),
              })}
        </span>
      )}
      {phase === "collecting" && (
        <>
          <span className="ag-note" data-vp-count>
            {t("chat.settings.general.voiceprintCount", { n: utterances.length })}
          </span>
          {utterances.length < VOICEPRINT_MAX_UTTERANCES && (
            <button type="button" className="btn-ghost" data-vp-say disabled={busy} onClick={() => void sayOne()}>
              {t("chat.settings.general.voiceprintSay", { n: utterances.length + 1 })}
            </button>
          )}
          {utterances.length >= VOICEPRINT_MIN_UTTERANCES && (
            <button type="button" className="btn-ghost" data-vp-finish disabled={busy} onClick={() => void finishRegister()}>
              {t("chat.settings.general.voiceprintFinish")}
            </button>
          )}
        </>
      )}
      {phase === "saving" && <span className="ag-note">{t("chat.settings.general.voiceprintSaving")}</span>}
      {phase === "saved" && (
        <>
          <span className="ag-note" data-vp-status>
            {t("chat.settings.general.voiceprintSaved")}
          </span>
          <button type="button" className="btn-ghost" data-vp-test disabled={busy} onClick={() => void runTest()}>
            {t("chat.settings.general.voiceprintTest")}
          </button>
          <button type="button" className="btn-ghost" data-vp-delete onClick={removeVoiceprint}>
            {t("chat.settings.general.voiceprintDelete")}
          </button>
          {testScore !== null && (
            <span className="ag-note" data-vp-test-score>
              {t("chat.settings.general.voiceprintScore", { pct: Math.round(testScore * 100) })}
            </span>
          )}
        </>
      )}
      {errorMessage !== null && (
        <span className="mcp-err" data-vp-error role="alert">
          {errorMessage}
        </span>
      )}
    </div>
  );
};

export default VoiceprintSection;
