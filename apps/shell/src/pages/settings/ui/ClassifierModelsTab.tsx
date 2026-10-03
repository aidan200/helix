/**
 * 分类模型 tab（判官 pi-ai 批）：classifier 端点管理面——从向量模型 tab
 * 拆出独立 tab（分类模型生态面向 pi-ai 目录扩充，配置形态与向量端点
 * 分叉：目录通道免 baseUrl、model 填目录模型串、apiKey 缺省回落
 * provider key）。
 *
 * 数据零权威与向量 tab 同构：embedding.list.result 结果帧驱动（两 tab
 * 条件渲染互斥挂载，各自订阅各自 setState）；verify 连通态 =
 * embedding.verify.result prob 变体 + 前端 in-flight + verifiedAt 持久态。
 *
 * 表单通道选择（variant，kind-picker 双钮同构交互）：
 * - pi-ai 目录（缺省）：model 填目录模型串（如 typesafe/jev-latest），
 *   baseUrl 不渲染不提交，apiKey 缺省回落 auth.json provider key；
 * - Jev 直连：baseUrl 必填 + apiKey 按需（存量兼容形态）。
 */
import { useEffect, useRef, useState } from "react";
import { AlertCircle, KeyRound } from "lucide-react";
import type { EmbeddingEndpointView } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { cn } from "@/shared/lib/cn";
import { relativeTimeSpan } from "@/shared/lib/format";
import { useArmedConfirm } from "./settings-hooks";

/** 弹层打开后聚焦延迟（key 弹层先例同值）。 */
const MODAL_FOCUS_DELAY_MS = 60;

/** 连通态（classifier 恒 prob 变体——无 embedding dim 分支）。 */
type VerifyState =
  | { phase: "verifying" }
  | { phase: "ok"; prob?: number }
  | { phase: "fail"; error: string };

/** 表单态：variant = 判官通道（pi-ai 目录缺省 / jev 直连存量形态）。 */
interface ClfForm {
  readonly id?: string;
  name: string;
  variant: "pi-ai" | "jev";
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

const EMPTY_FORM: ClfForm = { name: "", variant: "pi-ai", baseUrl: "", model: "", apiKey: null };

/** 相对时间短文案（向量 tab 同族）。 */
function verifiedLabel(at: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  const span = relativeTimeSpan(at, Date.now());
  switch (span.key) {
    case "justNow":
      return t("chat.modelsConfig.refreshedJustNow", { n: 0 });
    case "minutes":
      return t("chat.sidebar.timeMinutes", { n: span.n });
    case "hours":
      return t("chat.sidebar.timeHours", { n: span.n });
    default:
      return t("chat.sidebar.timeYesterday");
  }
}

/** 连通徽标四态（classifier 恒 prob 显示）。 */
function ClfConnBadge({ verify, endpoint }: { verify: VerifyState | undefined; endpoint: EmbeddingEndpointView }) {
  const { t } = useI18n();
  if (verify?.phase === "verifying") {
    return (
      <span className="conn hud-badge hud-badge-cyan" data-clf-conn="verifying">
        <span className="hud-dot hud-dot-cyan hud-dot-pulse" aria-hidden="true" />
        {t("chat.modelsConfig.connVerifying")}
      </span>
    );
  }
  if (verify?.phase === "ok") {
    return (
      <span className="conn hud-badge hud-badge-ok" data-clf-conn="ok">
        <span className="hud-dot hud-dot-ok" aria-hidden="true" />
        {t("chat.settings.general.embConnOkProb", { prob: Math.round((verify.prob ?? 0) * 100) })}
      </span>
    );
  }
  if (verify?.phase === "fail") {
    return (
      <span className="conn hud-badge hud-badge-error" data-clf-conn="fail" title={verify.error}>
        <span className="hud-dot hud-dot-error" aria-hidden="true" />
        {t("chat.modelsConfig.connFail", { reason: "" })}
      </span>
    );
  }
  if (endpoint.verifiedAt !== null) {
    return (
      <span className="conn hud-badge hud-badge-ok" data-clf-conn="verified">
        <span className="hud-dot hud-dot-ok" aria-hidden="true" />
        {verifiedLabel(endpoint.verifiedAt, t)}
      </span>
    );
  }
  return (
    <span className="conn hud-badge hud-badge-off" data-clf-conn="unverified">
      {t("chat.modelsConfig.connUnverified")}
    </span>
  );
}

const ClassifierModelsTab = function ClassifierModelsTab() {
  const { t } = useI18n();
  const toast = useToast();
  const { sendEmbeddingList, sendEmbeddingSet, sendEmbeddingDelete, sendEmbeddingVerify, subscribeEmbeddingFrames } = useSession();

  const [endpoints, setEndpoints] = useState<readonly EmbeddingEndpointView[] | null>(null);
  /** 连通态本地聚合（id → verify 三态；verifiedAt 持久态兜底展示）。 */
  const [verifyStates, setVerifyStates] = useState<Record<string, VerifyState>>({});
  /** 新增/编辑弹层（open|closed；校验 clean|error）。 */
  const [form, setForm] = useState<ClfForm | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const { armed: armedDelete, confirm: confirmDelete } = useArmedConfirm();

  useEffect(() => {
    sendEmbeddingList();
  }, [sendEmbeddingList]);
  useEffect(
    () =>
      subscribeEmbeddingFrames((e) => {
        if (e.type === "embedding.list.result") {
          setEndpoints(e.payload.endpoints);
          return;
        }
        if (e.type === "embedding.verify.result") {
          const payload = e.payload as
            | { id: string; state: "ok"; dim?: number; prob?: number }
            | { id: string; state: "fail"; error: string };
          setVerifyStates((prev) => ({
            ...prev,
            [payload.id]:
              payload.state === "ok"
                ? { phase: "ok", ...("dim" in payload ? {} : { prob: payload.prob }) }
                : { phase: "fail", error: payload.error },
          }));
          if (payload.state === "fail") {
            toast.push("err", t("chat.settings.general.embVerifyFailToast", { message: payload.error }));
          }
        }
      }),
    [subscribeEmbeddingFrames, toast, t],
  );

  // 弹层 Escape 关闭（key 弹层先例同构）
  useEffect(() => {
    if (form === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setForm(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [form]);

  const openForm = (endpoint?: EmbeddingEndpointView): void => {
    setFormErr(null);
    setForm(
      endpoint === undefined
        ? EMPTY_FORM
        : {
            id: endpoint.id,
            name: endpoint.name,
            variant: endpoint.variant === "pi-ai" ? "pi-ai" : "jev",
            baseUrl: endpoint.baseUrl,
            model: endpoint.model,
            apiKey: null,
          },
    );
    window.setTimeout(() => nameInputRef.current?.focus(), MODAL_FOCUS_DELAY_MS);
  };

  /** 保存（name/model 必填；baseUrl 仅 jev 通道必填——pi-ai 目录免填；
   *  kind 恒 classifier；apiKey 留空 = 不动——凭据只进不出）。 */
  const saveForm = (): void => {
    if (form === null) return;
    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim();
    const model = form.model.trim();
    const needsBaseUrl = form.variant === "jev";
    const emptyErr = name === "" || model === "" || (needsBaseUrl && baseUrl === "");
    if (emptyErr) {
      setFormErr(t("chat.settings.general.embEmptyErr"));
      return;
    }
    const ok = sendEmbeddingSet({
      ...(form.id !== undefined ? { id: form.id } : {}),
      name,
      ...(needsBaseUrl ? { baseUrl } : {}),
      model,
      kind: "classifier",
      variant: form.variant,
      ...(form.apiKey !== null ? { apiKey: form.apiKey } : {}),
    });
    if (ok === false) toast.push("err", t("chat.modelsConfig.sendFailToast"));
    setForm(null);
  };

  const onVerify = (id: string): void => {
    setVerifyStates((prev) => ({ ...prev, [id]: { phase: "verifying" } }));
    if (sendEmbeddingVerify(id) === false) {
      // send 失败：回滚在途态（不假反馈）
      setVerifyStates((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast.push("err", t("chat.modelsConfig.sendFailToast"));
    }
  };

  const onDelete = (id: string): void => {
    confirmDelete(id, () => {
      if (sendEmbeddingDelete(id) === false) {
        toast.push("err", t("chat.modelsConfig.sendFailToast"));
      }
    });
  };

  /** 本 tab 管理面（只 classifier 端点——向量端点在向量 tab）。 */
  const rows = (endpoints ?? []).filter((ep) => ep.kind === "classifier");

  return (
    <div data-classifier-tab>
      <div className="toolbar">
        <div className="toolbar-row">
          <span className="ag-note">{t("chat.settings.general.clfNote")}</span>
          <button className="hud-btn hud-btn-cyan sm" type="button" data-clf-add onClick={() => openForm()}>
            {t("chat.settings.general.clfAdd")}
          </button>
        </div>
      </div>

      {endpoints !== null && rows.length === 0 && (
        <p className="ag-note" data-clf-empty>
          {t("chat.settings.general.clfEmpty")}
        </p>
      )}

      {rows.map((ep) => (
        <div className="hud-card" data-clf-row={ep.id} key={ep.id}>
          <div className="toolbar">
            <div className="toolbar-row">
              <span className="prov-name" data-clf-name={ep.id}>
                {ep.name}
              </span>
              <span className="catalog-meta" data-clf-model={ep.id}>
                {ep.model}
              </span>
              <span className="key-chip" data-clf-variant={ep.id}>
                {ep.variant === "pi-ai" ? t("chat.settings.general.clfVariantPiAi") : t("chat.settings.general.clfVariantJev")}
              </span>
              {ep.keyMasked !== undefined ? (
                <span className="key-chip" data-clf-key={ep.id}>
                  key ····<span className="k4">{ep.keyMasked.slice(-4)}</span>
                </span>
              ) : (
                <span className="key-none" data-clf-nokey={ep.id}>
                  {t("chat.modelsConfig.unconfigured")}
                </span>
              )}
              <ClfConnBadge verify={verifyStates[ep.id]} endpoint={ep} />
            </div>
            <div className="toolbar-row prov-actions">
              <button
                className="hud-btn hud-btn-ghost sm"
                type="button"
                data-clf-verify={ep.id}
                disabled={verifyStates[ep.id]?.phase === "verifying"}
                onClick={() => onVerify(ep.id)}
              >
                {t("chat.modelsConfig.test")}
              </button>
              <button className="hud-btn hud-btn-ghost sm" type="button" data-clf-edit={ep.id} onClick={() => openForm(ep)}>
                {t("chat.settings.general.embEdit")}
              </button>
              <button
                className="hud-btn hud-btn-danger sm"
                type="button"
                data-clf-delete={ep.id}
                data-armed={armedDelete === ep.id ? "1" : undefined}
                onClick={() => onDelete(ep.id)}
              >
                {armedDelete === ep.id ? t("chat.modelsConfig.confirmDelete") : t("chat.settings.general.embDelete")}
              </button>
            </div>
          </div>
        </div>
      ))}

      {/* 新增/编辑弹层（hud-modal：向量 tab 先例同构；通道双钮 + 条件 baseUrl） */}
      {form !== null && (
        <div
          className="modal-backdrop open"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setForm(null);
          }}
        >
          <div className="hud-modal" role="dialog" aria-modal="true" aria-label={t("chat.settings.general.clfModalTitle")}>
            <div className="modal-title">
              <span className="mt-ic">
                <KeyRound size={16} strokeWidth={1.75} aria-hidden="true" />
              </span>
              {t("chat.settings.general.clfModalTitle")}
            </div>
            <p className="modal-sub">{t("chat.settings.general.clfModalSub")}</p>
            <div className="modal-body">
              <label className="hud-label">{t("chat.settings.general.clfVariant")}</label>
              <div className="kind-picker" data-clf-form-variant>
                {(
                  [
                    { value: "pi-ai", label: t("chat.settings.general.clfVariantPiAi") },
                    { value: "jev", label: t("chat.settings.general.clfVariantJev") },
                  ] as const
                ).map(({ value, label }) => (
                  <button
                    key={value}
                    className={cn("hud-btn sm", form.variant === value ? "hud-btn-cyan" : "hud-btn-ghost")}
                    type="button"
                    data-clf-variant-opt={value}
                    onClick={() => setForm({ ...form, variant: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="hud-label" htmlFor="clf-name">
                {t("chat.settings.general.embName")}
              </label>
              <input
                className={cn("hud-input", formErr !== null && form.name.trim() === "" && "err")}
                id="clf-name"
                type="text"
                value={form.name}
                ref={nameInputRef}
                data-clf-form-name
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              {form.variant === "jev" && (
                <>
                  <label className="hud-label" htmlFor="clf-baseurl">
                    {t("chat.settings.general.embBaseUrl")}
                  </label>
                  <input
                    className={cn("hud-input", formErr !== null && form.baseUrl.trim() === "" && "err")}
                    id="clf-baseurl"
                    type="text"
                    placeholder="https://api.typesafe.ai/v1"
                    value={form.baseUrl}
                    data-clf-form-baseurl
                    onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  />
                </>
              )}
              <label className="hud-label" htmlFor="clf-model">
                {t("chat.settings.general.embModel")}
              </label>
              <input
                className={cn("hud-input", formErr !== null && form.model.trim() === "" && "err")}
                id="clf-model"
                type="text"
                placeholder={form.variant === "pi-ai" ? "typesafe/jev-latest" : "jev-latest"}
                value={form.model}
                data-clf-form-model
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
              <label className="hud-label" htmlFor="clf-apikey">
                {t("chat.settings.general.embApiKey")}
              </label>
              <input
                className="hud-input"
                id="clf-apikey"
                type="password"
                autoComplete="off"
                placeholder={
                  form.variant === "pi-ai"
                    ? t("chat.settings.general.clfApiKeyPiAiPlaceholder")
                    : t("chat.settings.general.embApiKeyPlaceholder")
                }
                value={form.apiKey ?? ""}
                data-clf-form-apikey
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
              <span className={cn("form-err", formErr !== null && "show")} data-clf-form-err>
                <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
                {formErr ?? ""}
              </span>
            </div>
            <div className="modal-foot">
              <button
                className="hud-btn hud-btn-ghost"
                type="button"
                onClick={() => setForm(null)}
                data-clf-form-cancel
              >
                {t("chat.modelsConfig.cancel")}
              </button>
              <button className="hud-btn hud-btn-cyan" type="button" onClick={saveForm} data-clf-form-save>
                {t("chat.modelsConfig.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ClassifierModelsTab;
