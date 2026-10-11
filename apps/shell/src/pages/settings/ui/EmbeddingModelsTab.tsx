/**
 * 向量模型 tab（模型页 tab 化 B2-③；分类模型拆独立 tab 后收窄为纯向量
 * 端点——classifier 端点由 ClassifierModelsTab 管理，本 tab 不渲染不编辑）。
 *
 * 数据零权威：端点全集来自 embedding.list.result 结果帧驱动
 * （list/set/delete 三命令共用回执——写后即刷新清单）；verify 连通态 =
 * embedding.verify.result 两判别（id 回携——多端点并发归属无歧义）+
 * 前端 in-flight verifying 态；verifiedAt（daemon 持久）为初始态数据源。
 *
 * 交互全部对齐同文件 ModelsSettingsSection 既有 provider 行实现：
 * - 端点行：名称 / baseUrl / model / key 尾 4 位脱敏 chip（未配弱化「未配置」）/
 *   连通徽标四态（unverified|verifying|ok 含 dim|fail 含原因）+ 行内
 *   编辑/测试/两段式 armed 删除（2.5s 超时复原）；
 * - 新增/编辑表单：hud-modal 弹层（backdrop + Escape 关闭 + 非空校验
 *   红边内联错误——key 弹层先例）；apiKey 编辑留空 = 不动（凭据只进不出，
 *   daemon 侧合并现值）。
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

/** 连通态（前端聚合：verify.result 两判别 + in-flight verifying + 持久 verifiedAt；
 *  ok 携 dim（embedding）或 prob（classifier）二选一）。 */
type VerifyState =
  | { phase: "verifying" }
  | { phase: "ok"; dim?: number; prob?: number }
  | { phase: "fail"; error: string };

/** 编辑弹层表单态（null 编辑位 = 未编辑；kind 不进表单——本 tab 恒向量
 * 端点：新增缺省 embedding，编辑经 id 更新时 daemon 保留现值）。 */
interface EndpointForm {
  readonly id?: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

const EMPTY_FORM: EndpointForm = { name: "", baseUrl: "", model: "", apiKey: null };

/** 相对时间短文案（刚刚 / N 分钟前 / N 小时前——目录刷新先例同族）。 */
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

/** 连通徽标四态（互斥单值；ok 显示实测 dim）。 */
function EmbConnBadge({ verify, endpoint }: { verify: VerifyState | undefined; endpoint: EmbeddingEndpointView }) {
  const { t } = useI18n();
  if (verify?.phase === "verifying") {
    return (
      <span className="conn hud-badge hud-badge-cyan" data-emb-conn="verifying">
        <span className="hud-dot hud-dot-cyan hud-dot-pulse" aria-hidden="true" />
        {t("chat.modelsConfig.connVerifying")}
      </span>
    );
  }
  if (verify?.phase === "ok") {
    return (
      <span className="conn hud-badge hud-badge-ok" data-emb-conn="ok">
        <span className="hud-dot hud-dot-ok" aria-hidden="true" />
        {verify.dim !== undefined
          ? t("chat.settings.general.embConnOk", { dim: verify.dim })
          : t("chat.settings.general.embConnOkProb", { prob: Math.round((verify.prob ?? 0) * 100) })}
      </span>
    );
  }
  if (verify?.phase === "fail") {
    return (
      <span className="conn hud-badge hud-badge-error" data-emb-conn="fail" title={verify.error}>
        <span className="hud-dot hud-dot-error" aria-hidden="true" />
        {t("chat.modelsConfig.connFail", { reason: "" })}
      </span>
    );
  }
  if (endpoint.verifiedAt !== null) {
    return (
      <span className="conn hud-badge hud-badge-ok" data-emb-conn="verified">
        <span className="hud-dot hud-dot-ok" aria-hidden="true" />
        {verifiedLabel(endpoint.verifiedAt, t)}
      </span>
    );
  }
  return (
    <span className="conn hud-badge hud-badge-off" data-emb-conn="unverified">
      {t("chat.modelsConfig.connUnverified")}
    </span>
  );
}

const EmbeddingModelsTab = function EmbeddingModelsTab() {
  const { t } = useI18n();
  const toast = useToast();
  const { sendEmbeddingList, sendEmbeddingSet, sendEmbeddingDelete, sendEmbeddingSetDefault, sendEmbeddingVerify, subscribeEmbeddingFrames } = useSession();

  const [endpoints, setEndpoints] = useState<readonly EmbeddingEndpointView[] | null>(null);
  /** 全局默认 embedding 端点 id（批1：list.result 驱动——徽标/引导条/删除提示判据）。 */
  const [defaultEndpointId, setDefaultEndpointId] = useState<string | null>(null);
  /** 连通态本地聚合（id → verify 三态；verifiedAt 持久态兜底展示）。 */
  const [verifyStates, setVerifyStates] = useState<Record<string, VerifyState>>({});
  /** 新增/编辑弹层（open|closed；校验 clean|error）。 */
  const [form, setForm] = useState<EndpointForm | null>(null);
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
          setDefaultEndpointId(e.payload.defaultEndpointId ?? null);
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
                ? { phase: "ok", ...("dim" in payload ? { dim: payload.dim } : { prob: payload.prob }) }
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
            baseUrl: endpoint.baseUrl,
            model: endpoint.model,
            apiKey: null,
          },
    );
    window.setTimeout(() => nameInputRef.current?.focus(), MODAL_FOCUS_DELAY_MS);
  };

  /** 保存（非空校验三必填字段；apiKey 留空 = 不动——凭据只进不出；
   *  kind 不传——新增缺省 embedding，编辑保留现值）。 */
  const saveForm = (): void => {
    if (form === null) return;
    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim();
    const model = form.model.trim();
    if (name === "" || baseUrl === "" || model === "") {
      setFormErr(t("chat.settings.general.embEmptyErr"));
      return;
    }
    const ok = sendEmbeddingSet({
      ...(form.id !== undefined ? { id: form.id } : {}),
      name,
      baseUrl,
      model,
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

  /** 设为默认（单选语义——daemon 校验三拒：不存在/kind≠embedding/未 verify）。 */
  const onSetDefault = (id: string): void => {
    if (sendEmbeddingSetDefault(id) === false) {
      toast.push("err", t("chat.modelsConfig.sendFailToast"));
    }
  };

  return (
    <div data-embedding-tab>
      <div className="toolbar">
        <div className="toolbar-row">
          <span className="ag-note">{t("chat.settings.general.embNote")}</span>
          <button className="hud-btn hud-btn-cyan sm" type="button" data-emb-add onClick={() => openForm()}>
            {t("chat.settings.general.embAdd")}
          </button>
        </div>
      </div>

      {/* D1：全局默认向量模型工具卡（对话 tab F(3.4).6 同构——顶部只读展示
          当前默认端点名/model；未设默认弱化提示；改默认在下方列表行「设为默认」） */}
      <div className="hud-card" data-emb-global-default>
        <div className="toolbar">
          <div className="toolbar-row">
            <div className="fld">
              <span className="hud-label">{t("chat.settings.general.embGlobalDefault")}</span>
              {(() => {
                const def = (endpoints ?? []).find((ep) => ep.id === defaultEndpointId);
                return def !== undefined ? (
                  <span className="default-model" data-emb-global-default-value>
                    {def.name} · {def.model}
                  </span>
                ) : (
                  <span className="ag-note" data-emb-global-default-unset role="note">
                    {t("chat.settings.general.embGlobalDefaultUnset")}
                  </span>
                );
              })()}
            </div>
          </div>
        </div>
      </div>

      {/* 批1：无默认端点引导条（记忆/知识库向量面不可用——与服务闸同判据） */}
      {endpoints !== null && defaultEndpointId === null && (
        <p className="ag-note" data-emb-no-default role="note">
          {t("chat.settings.general.embNoDefaultHint")}
        </p>
      )}

      {endpoints !== null && endpoints.filter((ep) => (ep.kind ?? "embedding") === "embedding").length === 0 && (
        <p className="ag-note" data-emb-empty>
          {t("chat.settings.general.embEmpty")}
        </p>
      )}

      {/* 端点行（纯向量组——classifier 端点在分类模型 tab 渲染） */}
      {(endpoints ?? []).filter((ep) => (ep.kind ?? "embedding") === "embedding").length > 0 && (
        <div data-emb-group="embedding">
          {(endpoints ?? [])
            .filter((ep) => (ep.kind ?? "embedding") === "embedding")
            .map((ep) => (
                  <div className="hud-card" data-emb-row={ep.id} key={ep.id}>
                    <div className="toolbar">
                      <div className="toolbar-row">
                        <span className="prov-name" data-emb-name={ep.id}>
                          {ep.name}
                        </span>
                        {defaultEndpointId === ep.id && (
                          <span className="hud-badge hud-badge-ok" data-emb-default={ep.id}>
                            {t("chat.settings.general.embDefaultBadge")}
                          </span>
                        )}
                        <span className="catalog-meta" data-emb-url={ep.id}>
                          {ep.baseUrl} · {ep.model}
                        </span>
                        {ep.keyMasked !== undefined ? (
                          <span className="key-chip" data-emb-key={ep.id}>
                            key ····<span className="k4">{ep.keyMasked.slice(-4)}</span>
                          </span>
                        ) : (
                          <span className="key-none" data-emb-nokey={ep.id}>
                            {t("chat.modelsConfig.unconfigured")}
                          </span>
                        )}
                        <EmbConnBadge verify={verifyStates[ep.id]} endpoint={ep} />
                      </div>
                      <div className="toolbar-row prov-actions">
                        <button
                          className="hud-btn hud-btn-ghost sm"
                          type="button"
                          data-emb-verify={ep.id}
                          disabled={verifyStates[ep.id]?.phase === "verifying"}
                          onClick={() => onVerify(ep.id)}
                        >
                          {t("chat.modelsConfig.test")}
                        </button>
                        {defaultEndpointId !== ep.id && (
                          <button
                            className="hud-btn hud-btn-ghost sm"
                            type="button"
                            data-emb-set-default={ep.id}
                            onClick={() => onSetDefault(ep.id)}
                          >
                            {t("chat.settings.general.embSetDefault")}
                          </button>
                        )}
                        <button className="hud-btn hud-btn-ghost sm" type="button" data-emb-edit={ep.id} onClick={() => openForm(ep)}>
                          {t("chat.settings.general.embEdit")}
                        </button>
                        <button
                          className="hud-btn hud-btn-danger sm"
                          type="button"
                          data-emb-delete={ep.id}
                          data-armed={armedDelete === ep.id ? "1" : undefined}
                          onClick={() => onDelete(ep.id)}
                        >
                          {armedDelete === ep.id ? t("chat.modelsConfig.confirmDelete") : t("chat.settings.general.embDelete")}
                        </button>
                      </div>
                      {/* 批1：默认端点删除确认提示（两段式 armed 确认的补充告知——
                          删后记忆与知识库向量面不可用） */}
                      {armedDelete === ep.id && defaultEndpointId === ep.id && (
                        <div className="toolbar-row" data-emb-delete-default-hint={ep.id}>
                          <span className="ag-note" role="note">
                            {t("chat.settings.general.embDeleteDefaultHint")}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
        </div>
      )}

      {/* 新增/编辑弹层（hud-modal：key 弹层先例同构；非空校验内联错误） */}
      {form !== null && (
        <div
          className="modal-backdrop open"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setForm(null);
          }}
        >
          <div className="hud-modal" role="dialog" aria-modal="true" aria-label={t("chat.settings.general.embModalTitle")}>
            <div className="modal-title">
              <span className="mt-ic">
                <KeyRound size={16} strokeWidth={1.75} aria-hidden="true" />
              </span>
              {t("chat.settings.general.embModalTitle")}
            </div>
            <p className="modal-sub">{t("chat.settings.general.embModalSub")}</p>
            <div className="modal-body">
              <label className="hud-label" htmlFor="emb-name">
                {t("chat.settings.general.embName")}
              </label>
              <input
                className={cn("hud-input", formErr !== null && form.name.trim() === "" && "err")}
                id="emb-name"
                type="text"
                value={form.name}
                ref={nameInputRef}
                data-emb-form-name
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <label className="hud-label" htmlFor="emb-baseurl">
                {t("chat.settings.general.embBaseUrl")}
              </label>
              <input
                className={cn("hud-input", formErr !== null && form.baseUrl.trim() === "" && "err")}
                id="emb-baseurl"
                type="text"
                placeholder="http://localhost:11434/v1"
                value={form.baseUrl}
                data-emb-form-baseurl
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
              <label className="hud-label" htmlFor="emb-model">
                {t("chat.settings.general.embModel")}
              </label>
              <input
                className={cn("hud-input", formErr !== null && form.model.trim() === "" && "err")}
                id="emb-model"
                type="text"
                placeholder="bge-m3"
                value={form.model}
                data-emb-form-model
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
              <label className="hud-label" htmlFor="emb-apikey">
                {t("chat.settings.general.embApiKey")}
              </label>
              <input
                className="hud-input"
                id="emb-apikey"
                type="password"
                autoComplete="off"
                placeholder={t("chat.settings.general.embApiKeyPlaceholder")}
                value={form.apiKey ?? ""}
                data-emb-form-apikey
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
              <span className={cn("form-err", formErr !== null && "show")} data-emb-form-err>
                <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
                {formErr ?? ""}
              </span>
            </div>
            <div className="modal-foot">
              <button
                className="hud-btn hud-btn-ghost"
                type="button"
                onClick={() => setForm(null)}
                data-emb-form-cancel
              >
                {t("chat.modelsConfig.cancel")}
              </button>
              <button className="hud-btn hud-btn-cyan" type="button" onClick={saveForm} data-emb-form-save>
                {t("chat.modelsConfig.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EmbeddingModelsTab;
