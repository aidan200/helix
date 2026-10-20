/**
 * VoiceprintSection —— 设置页声纹组（M3-c 声纹批 v3：阈值参数 + 5 槽位编辑）。
 *
 * 形态（与语音设置页其他配置项同排布语言）：
 * - 相似度阈值行：滑杆 + 数值 chip（参照插话检测参数组）——写 localStorage
 *   偏好，授权点 verifyGate 现读即时生效；
 * - 5 个声纹槽位卡（横排不重叠）：每槽录一句/重录/删除——未注册 = 暂存
 *   PCM，完成注册时一次性嵌入；已注册 = 逐句向量单槽换新/移除后模板重合成
 *   即时落盘；
 * - 测试行：按钮 + 相似度得分与判定 chip（参照 TTS 试听行）；
 * - 状态收口行：计数/已注册 chip + 完成注册/删除声纹；
 * - 声音模型行：就绪 chip（本地 ~/.helix/models/）或手动导入通道（下载
 *   受阻的兜底路径）——模型搬运并入「完成注册」，录句全程零网络。
 *
 * 注入面：service（缺省生产单例）与 recorder（缺省麦克风录音器——测试
 * 注入 fake）；模型下载进度经动态 import embed-engine 直调 loadModelBytes，
 * service 引擎随后命中磁盘缓存零重复下载。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import {
  VOICEPRINT_THRESHOLD_RANGE,
  readVoiceprintThresholdPref,
  writeVoiceprintThresholdPref,
} from "@/shared/lib/voice-pref";
import { getStewardVoiceprintService } from "../model/steward-voiceprint";
import { VoiceprintError, type VoiceprintService } from "../model/voiceprint-service";
import {
  SAMPLES_PER_SECOND,
  VOICEPRINT_MAX_UTTERANCES,
  VOICEPRINT_MIN_UTTERANCE_SECONDS,
  VOICEPRINT_MIN_UTTERANCES,
  type VoiceprintTemplate,
} from "../model/speaker-verify";
import { createMicUtteranceRecorder, type UtteranceRecorder } from "./mic-recorder";
// 模型体积常量（下载进度分母兜底单源；值由 embed-engine 侧实测维护）——
// 只取常量不做整包 import，不拖 ort bundle
import { VOICEPRINT_MODEL_BYTES } from "../model/embed-engine";

/** 单句最长采集（秒；到点强制收口）。 */
const UTTERANCE_MAX_SECONDS = 8;

/** 未注册暂存槽（5 位定长，前段稠密——录/删维持稠密序）。 */
const EMPTY_STAGED: ReadonlyArray<Float32Array | null> = [null, null, null, null, null];

type Phase = "idle" | "preparing" | "saving";

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
  /** 模型就绪探测面（缺省 = 动态 import embed-engine 直调 probeModelAvailable
   *  ——HEAD 零搬运；磁盘命中即明示已就绪；测试注入 fake）。 */
  readonly probeModel?: () => Promise<boolean>;
}

const prepareModelViaEngine: NonNullable<VoiceprintSectionProps["prepareModel"]> = async (onProgress) => {
  const { loadModelBytes } = await import("../model/embed-engine");
  await loadModelBytes({ onProgress });
};

const probeModelViaEngine: NonNullable<VoiceprintSectionProps["probeModel"]> = async () => {
  const { probeModelAvailable } = await import("../model/embed-engine");
  return probeModelAvailable();
};

/** 手动导入（缺省 = 动态 import embed-engine 直调 importModelFile——PUT
 *  上行 daemon 落盘；测试注入 fake）。 */
const importModelViaEngine = async (file: File): Promise<void> => {
  const { importModelFile } = await import("../model/embed-engine");
  await importModelFile(file);
};

const VoiceprintSection = function VoiceprintSection({ service, recorder, prepareModel, importModel, probeModel }: VoiceprintSectionProps) {
  const { t } = useI18n();
  // 注入面 ref 一次建齐（渲染体不重复构造）：旧写法在渲染体里
  // `recorderRef.current = recorder ?? createMicUtteranceRecorder()` 每次渲染
  // 新建录音器实例（对象 churn + 渲染期副作用）；prop 变化经 effect 同步。
  const serviceRef = useRef<VoiceprintService>(service ?? getStewardVoiceprintService());
  const recorderRef = useRef<UtteranceRecorder>(recorder ?? createMicUtteranceRecorder());
  useEffect(() => {
    serviceRef.current = service ?? getStewardVoiceprintService();
  }, [service]);
  useEffect(() => {
    recorderRef.current = recorder ?? createMicUtteranceRecorder();
  }, [recorder]);
  const prepareModelRef = useRef<NonNullable<VoiceprintSectionProps["prepareModel"]>>(prepareModel ?? prepareModelViaEngine);
  prepareModelRef.current = prepareModel ?? prepareModelViaEngine;
  const probeModelRef = useRef<NonNullable<VoiceprintSectionProps["probeModel"]>>(probeModel ?? probeModelViaEngine);
  probeModelRef.current = probeModel ?? probeModelViaEngine;
  const importModelRef = useRef<NonNullable<VoiceprintSectionProps["importModel"]>>(importModel ?? importModelViaEngine);
  importModelRef.current = importModel ?? importModelViaEngine;

  // ── 声纹现态（模板 = 已注册；null = 未注册暂存槽阶段）──
  const [template, setTemplate] = useState<VoiceprintTemplate | null>(() => serviceRef.current.getTemplate());
  const [staged, setStaged] = useState<ReadonlyArray<Float32Array | null>>(EMPTY_STAGED);
  const [phase, setPhase] = useState<Phase>("idle");
  const [busySlot, setBusySlot] = useState<number | "test" | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number | null } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ score: number; pass: boolean } | null>(null);
  // 模型就绪探测（null = 未知/探测中——磁盘命中即明示已就绪，不再摆
  // 下载/导入姿态；探测失败保守显示导入通道，不阻塞录句）。
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  // ── 相似度阈值（初值 localStorage 偏好；写 = 偏好即时生效——授权点
  //    verifyGate 现读）──
  const [threshold, setThreshold] = useState<number>(() => readVoiceprintThresholdPref());

  useEffect(() => {
    let alive = true;
    void probeModelRef.current().then((ready) => {
      if (alive) setModelReady(ready);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 卸载中止在途录句（离开设置页即关麦）：不中止则 getUserMedia 流会一直
  // 采集到「未开口兜底超时」（maxSeconds+2 秒 = 10s）才释放——用户已走，
  // 麦克风指示灯还亮着，且迟到结果无人消费。
  useEffect(
    () => () => {
      recorderRef.current.abort?.();
    },
    [],
  );

  const registered = template !== null;
  // 旧版模板（注册于逐句明细落地之前）：校验走均值向量照旧，单槽编辑不可用
  const legacy = registered && template.vectors.length === 0;
  const filledCount = staged.reduce((n, s) => (s === null ? n : n + 1), 0);

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

  // ── 槽位状态（5 位定长横排：filled/next/empty/legacy）──
  const slotState = (i: number): "filled" | "next" | "empty" | "legacy" => {
    if (registered && legacy) return i < template.utterances ? "legacy" : "empty";
    const count = registered ? template.vectors.length : filledCount;
    if (i < count) return "filled";
    if (i === count) return "next";
    return "empty";
  };

  // ── 录一句（槽位录入/重录；未注册 = 暂存 PCM，已注册 = 单槽换新即时
  //    重合成落盘。句长不达标当场白话拒绝不落槽）──
  const recordInto = useCallback(
    async (index: number) => {
      if (busySlot !== null || phase !== "idle") return;
      setBusySlot(index);
      setErrorMessage(null);
      setTestResult(null);
      try {
        const pcm = await recorderRef.current.record(VOICEPRINT_MIN_UTTERANCE_SECONDS, UTTERANCE_MAX_SECONDS);
        if (pcm === null) {
          setErrorMessage(t("chat.settings.general.voiceprintMicFail"));
          return;
        }
        if (pcm.length < VOICEPRINT_MIN_UTTERANCE_SECONDS * SAMPLES_PER_SECOND) {
          setErrorMessage(t("chat.settings.general.voiceprintShortSentence", { n: index + 1, s: VOICEPRINT_MIN_UTTERANCE_SECONDS }));
          return;
        }
        if (registered) {
          setTemplate(await serviceRef.current.recordSlot(index, pcm));
        } else {
          setStaged((prev) => {
            const arr = [...prev];
            arr[index] = pcm;
            return arr;
          });
        }
      } catch (e) {
        setErrorMessage(messageOfError(e));
      } finally {
        setBusySlot(null);
      }
    },
    [busySlot, messageOfError, phase, registered, t],
  );

  // ── 删一槽（未注册 = 暂存移除后前移；已注册 = 逐句向量移除重合成）。──
  const onDeleteSlot = useCallback(
    async (index: number) => {
      if (busySlot !== null || phase !== "idle") return;
      setErrorMessage(null);
      setTestResult(null);
      try {
        if (registered) {
          setTemplate(await serviceRef.current.deleteSlot(index));
        } else {
          setStaged((prev) => [...prev.filter((_, i) => i !== index), null]);
        }
      } catch (e) {
        setErrorMessage(messageOfError(e));
      }
    },
    [busySlot, messageOfError, phase, registered],
  );

  // ── 完成注册（模型先就位——daemon 磁盘路由拉取带进度，拉不到走手动
  //    导入通道；随后 3-5 句一次性嵌入成模板）──
  const finishRegister = useCallback(async () => {
    if (phase !== "idle") return;
    setErrorMessage(null);
    setTestResult(null);
    setPhase("preparing");
    setProgress({ received: 0, total: null });
    try {
      await prepareModelRef.current((received, total) => setProgress({ received, total }));
    } catch {
      setProgress(null);
      setModelReady(false);
      setErrorMessage(t("chat.settings.general.voiceprintDownloadFail"));
      setPhase("idle");
      return;
    }
    setProgress(null);
    setPhase("saving");
    try {
      const pcmList = staged.filter((s): s is Float32Array => s !== null);
      const next = await serviceRef.current.register(pcmList);
      setTemplate(next);
      setStaged(EMPTY_STAGED);
      setPhase("idle");
    } catch (e) {
      setErrorMessage(messageOfError(e));
      setPhase("idle");
    }
  }, [messageOfError, phase, staged, t]);
  const finishRef = useRef(finishRegister);
  finishRef.current = finishRegister;

  // ── 手动导入（GitHub 直连受阻：手动下载后选文件 → PUT 上行 daemon 落盘
  //    ~/.helix/models/ → 就绪即续跑未完的注册）──
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const onImportPicked = useCallback(async () => {
    const file = fileInputRef.current?.files?.[0];
    if (file === undefined) return;
    setErrorMessage(null);
    setBusySlot("test"); // 复用忙态闸（导入期间槽位/测试全停）
    try {
      await importModelRef.current(file);
      setModelReady(true); // 导入落盘即就绪（后续不再摆导入姿态）
      if (!registered && filledCount >= VOICEPRINT_MIN_UTTERANCES) void finishRef.current();
    } catch {
      setErrorMessage(t("chat.settings.general.voiceprintImportFail"));
    } finally {
      setBusySlot(null);
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
    }
  }, [filledCount, registered, t]);

  // ── 测试（录一句 → 与模板实时相似度；判定 = 得分 vs 当前阈值）──
  const runTest = useCallback(async () => {
    if (busySlot !== null || phase !== "idle") return;
    setBusySlot("test");
    setTestResult(null);
    setErrorMessage(null);
    try {
      const pcm = await recorderRef.current.record(VOICEPRINT_MIN_UTTERANCE_SECONDS, UTTERANCE_MAX_SECONDS);
      if (pcm === null) {
        setErrorMessage(t("chat.settings.general.voiceprintMicFail"));
        return;
      }
      const score = await serviceRef.current.test(pcm);
      setTestResult({ score, pass: score * 100 >= threshold });
    } catch (e) {
      setErrorMessage(messageOfError(e));
    } finally {
      setBusySlot(null);
    }
  }, [busySlot, messageOfError, phase, t, threshold]);

  // ── 删除声纹（彻底移除——回到未注册形态）──
  const removeVoiceprint = useCallback(() => {
    serviceRef.current.remove();
    setTemplate(null);
    setStaged(EMPTY_STAGED);
    setTestResult(null);
    setErrorMessage(null);
  }, []);

  const onThreshold = useCallback((percent: number) => {
    setThreshold(percent);
    writeVoiceprintThresholdPref(percent);
  }, []);

  return (
    <div className="vp-section" data-voiceprint-section>
      <p className="ag-note" data-vp-note>
        {t("chat.settings.general.voiceprintNote")}
      </p>

      {/* ── 相似度阈值（参数设置行——滑杆写偏好，授权点现读即时生效）── */}
      <div className="fld">
        <label className="hud-label" htmlFor="vp-threshold">
          {t("chat.settings.general.voiceprintThreshold")}
        </label>
        <div className="set-inline">
          <input
            id="vp-threshold"
            data-vp-threshold
            type="range"
            min={VOICEPRINT_THRESHOLD_RANGE.min}
            max={VOICEPRINT_THRESHOLD_RANGE.max}
            step={1}
            value={threshold}
            onChange={(e) => onThreshold(Number(e.target.value))}
          />
          <span className="hud-chip tabular-nums min-w-[3.5rem] justify-center" data-vp-threshold-value>
            {threshold}%
          </span>
        </div>
        <span className="ag-note">{t("chat.settings.general.voiceprintThresholdHint")}</span>
      </div>

      {/* ── 5 槽位横排（每槽录/重录/删除）── */}
      <div className="fld">
        <span className="hud-label">{t("chat.settings.general.voiceprintSlotsLabel")}</span>
        <div className="vp-slots" data-vp-slots>
          {[0, 1, 2, 3, 4].map((i) => {
            const state = slotState(i);
            const busyHere = busySlot === i;
            return (
              <div
                key={i}
                className={cn("vp-slot", state !== "empty" && "vp-slot-on", state === "legacy" && "vp-slot-legacy")}
                data-vp-slot={i}
                data-vp-slot-state={state}
              >
                <span className="vp-slot-index">{i + 1}</span>
                <span className="vp-slot-label">
                  {state === "legacy"
                    ? t("chat.settings.general.voiceprintSlotLegacy")
                    : state === "filled"
                      ? t("chat.settings.general.voiceprintSlotFilled")
                      : state === "next"
                        ? t("chat.settings.general.voiceprintSlotNext")
                        : t("chat.settings.general.voiceprintSlotEmpty")}
                </span>
                <div className="vp-slot-actions">
                  {state === "filled" && (
                    <>
                      <button
                        type="button"
                        className="hud-btn sm"
                        data-vp-slot-rerecord={i}
                        disabled={busySlot !== null || phase !== "idle"}
                        onClick={() => void recordInto(i)}
                      >
                        {busyHere ? t("chat.settings.general.voiceprintSlotRecording") : t("chat.settings.general.voiceprintSlotRerecord")}
                      </button>
                      <button
                        type="button"
                        className="hud-btn sm hud-btn-ghost"
                        data-vp-slot-delete={i}
                        disabled={busySlot !== null || phase !== "idle"}
                        onClick={() => void onDeleteSlot(i)}
                      >
                        {t("chat.settings.general.voiceprintSlotDelete")}
                      </button>
                    </>
                  )}
                  {state === "next" && (
                    <button
                      type="button"
                      className="hud-btn sm hud-btn-cyan"
                      data-vp-slot-record={i}
                      disabled={busySlot !== null || phase !== "idle"}
                      onClick={() => void recordInto(i)}
                    >
                      {busyHere ? t("chat.settings.general.voiceprintSlotRecording") : t("chat.settings.general.voiceprintSlotRecord")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <span className="ag-note" data-vp-hint>
          {legacy
            ? t("chat.settings.general.voiceprintLegacyNote")
            : registered
              ? t("chat.settings.general.voiceprintSavedHint")
              : t("chat.settings.general.voiceprintSlotsHint")}
        </span>
      </div>

      {/* ── 状态收口行（计数/已注册 chip + 完成注册/删除声纹）── */}
      <div className="fld">
        <div className="set-inline" data-vp-actions>
          {phase === "preparing" ? (
            <span className="ag-note" data-vp-preparing>
              {progress === null
                ? t("chat.settings.general.voiceprintPreparing")
                : t("chat.settings.general.voiceprintDownloading", {
                    mb: (progress.received / 1e6).toFixed(1),
                    // 分母兜底走 embed-engine 单源常量（不硬编码 27）
                    total:
                      progress.total === null
                        ? (VOICEPRINT_MODEL_BYTES / 1e6).toFixed(0)
                        : (progress.total / 1e6).toFixed(0),
                  })}
            </span>
          ) : phase === "saving" ? (
            <span className="ag-note" data-vp-saving>
              {t("chat.settings.general.voiceprintSaving")}
            </span>
          ) : registered ? (
            <>
              <span className="hud-chip" data-vp-status>
                {t("chat.settings.general.voiceprintStatusSaved", { n: legacy ? template.utterances : template.vectors.length })}
              </span>
              <button type="button" className="hud-btn hud-btn-ghost" data-vp-delete onClick={removeVoiceprint}>
                {t("chat.settings.general.voiceprintDelete")}
              </button>
            </>
          ) : (
            <>
              <span className="hud-chip tabular-nums" data-vp-count>
                {t("chat.settings.general.voiceprintCount", { n: filledCount, max: VOICEPRINT_MAX_UTTERANCES })}
              </span>
              {filledCount >= VOICEPRINT_MIN_UTTERANCES && (
                <button type="button" className="hud-btn hud-btn-cyan" data-vp-finish onClick={() => void finishRef.current()}>
                  {t("chat.settings.general.voiceprintFinish")}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── 测试行（参照 TTS 试听行：按钮 + 得分/判定 chip）── */}
      {registered && (
        <div className="fld">
          <label className="hud-label" htmlFor="vp-test">
            {t("chat.settings.general.voiceprintTestLabel")}
          </label>
          <div className="set-inline">
            <button
              id="vp-test"
              type="button"
              className="hud-btn hud-btn-cyan"
              data-vp-test
              disabled={busySlot !== null || phase !== "idle"}
              onClick={() => void runTest()}
            >
              {t("chat.settings.general.voiceprintTest")}
            </button>
            {testResult !== null && (
              <span className="hud-chip tabular-nums" data-vp-test-score>
                {t("chat.settings.general.voiceprintScore", { pct: Math.round(testResult.score * 100) })} ·{" "}
                {testResult.pass
                  ? t("chat.settings.general.voiceprintPass")
                  : t("chat.settings.general.voiceprintFail")}
              </span>
            )}
          </div>
        </div>
      )}

      {errorMessage !== null && (
        <div className="fld">
          <span className="mcp-err" data-vp-error role="alert">
            {errorMessage}
          </span>
        </div>
      )}

      {/* ── 声音模型行（就绪 chip / 手动导入兜底通道）── */}
      <div className="fld">
        <span className="hud-label">{t("chat.settings.general.voiceprintModelLabel")}</span>
        <div className="set-inline">
          {modelReady === true ? (
            // 磁盘已就绪：明示状态，收起导入姿态（录句/注册零网络）
            <span className="hud-chip" data-vp-model-ready>
              {t("chat.settings.general.voiceprintModelReady")}
            </span>
          ) : (
            <>
              {/* 手动导入通道（下载不动时）：隐藏 file input + 触发钮 */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".onnx,application/octet-stream"
                className="hidden"
                data-vp-file
                onChange={() => void onImportPicked()}
              />
              <button
                type="button"
                className="hud-btn hud-btn-ghost"
                data-vp-import
                disabled={busySlot !== null || phase !== "idle"}
                onClick={() => fileInputRef.current?.click()}
              >
                {t("chat.settings.general.voiceprintImport")}
              </button>
              <span className="ag-note">{t("chat.settings.general.voiceprintImportHint")}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default VoiceprintSection;
