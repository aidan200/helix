/**
 * 三方平台 tab（三方平台批）：自定义兼容平台管理面。
 *
 * 数据零权威：平台全集来自 provider.list.result 结果帧驱动（list/set/delete
 * 三命令共用回执——写后即刷新清单）；key 状态行内携带（hasApiKey +
 * keyMasked——daemon 侧 authStore 投影，key 本体在 auth.json）。
 *
 * key/验证刻意复用既有 auth 族通路（AG-08 单一 key 通路）：
 * - Key 录入：对话模型 tab 的 provider 区（auth.set_key——自定义平台进
 *   合并目录后自动出现在 auth.list）；
 * - 连通测试：本 tab「测试」按钮 → verifyProvider（auth.verify 最小请求），
 *   状态读 topology.modelConfig.auth[id]（与对话模型 tab 同源 store）。
 *
 * 交互对齐 EmbeddingModelsTab 先例：行内编辑/两段式 armed 删除；新增/编辑
 * hud-modal 弹层（非空校验红边内联错误）。
 *
 * 三方平台批 II：API 风格下拉（OpenAI 兼容 / Anthropic 兼容——payload.api，
 * 缺省 OpenAI）；模型清单表格化单行编辑（列头一次 + 每模型一行七字段，
 * id/上下文窗口必填，名称/最大输出/推理/输入输出价格选填，价格单位
 * 美元/百万 token，空 = 未知计费；行区限高滚动，弹层 wide 变体）。
 */
import { useEffect, useRef, useState } from "react";
import { AlertCircle, Building2, Plus, X } from "lucide-react";
import type { ProviderApiStyle, ProviderThinkingFormat, ProviderView } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { cn } from "@/shared/lib/cn";
import { useArmedConfirm } from "./settings-hooks";

/** 弹层打开后聚焦延迟（key 弹层先例同值）。 */
const MODAL_FOCUS_DELAY_MS = 60;

/** 模型行表单态（input 恒 string；数值解析与校验在保存期收口）。 */
interface ModelRowForm {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  inputPrice: string;
  outputPrice: string;
}

const EMPTY_MODEL_ROW: ModelRowForm = {
  id: "",
  name: "",
  contextWindow: "",
  maxTokens: "",
  reasoning: false,
  inputPrice: "",
  outputPrice: "",
};

/** 编辑弹层表单态（null = 关闭）。 */
interface ProviderForm {
  /** 编辑目标（undefined = 新增；id 编辑态锁定）。 */
  readonly id?: string;
  idInput: string;
  name: string;
  api: ProviderApiStyle;
  thinkingFormat: ProviderThinkingFormat;
  baseUrl: string;
  modelRows: ModelRowForm[];
}

const EMPTY_FORM: ProviderForm = {
  idInput: "",
  name: "",
  api: "openai-completions",
  thinkingFormat: "auto",
  baseUrl: "",
  modelRows: [{ ...EMPTY_MODEL_ROW }],
};

/** 行内校验（返回 null = 通过；否则错误消息）。contextWindow 与 id 必填，其余选填。 */
function validateRow(row: ModelRowForm): string | null {
  if (row.id.trim() === "") return "id";
  const ctx = Number(row.contextWindow.trim());
  if (row.contextWindow.trim() === "" || !Number.isInteger(ctx) || ctx <= 0) return "contextWindow";
  const max = row.maxTokens.trim();
  if (max !== "" && (!Number.isInteger(Number(max)) || Number(max) <= 0)) return "maxTokens";
  if (row.inputPrice.trim() !== "" && (!Number.isFinite(Number(row.inputPrice)) || Number(row.inputPrice) < 0)) return "inputPrice";
  if (row.outputPrice.trim() !== "" && (!Number.isFinite(Number(row.outputPrice)) || Number(row.outputPrice) < 0)) return "outputPrice";
  return null;
}

/** ProviderView → 模型行表单态（价格 0 = 未知计费 → 回显为空）。 */
function rowsOf(provider: ProviderView): ModelRowForm[] {
  return provider.models.map((m) => ({
    id: m.id,
    name: m.name === m.id ? "" : m.name,
    contextWindow: String(m.contextWindow),
    maxTokens: String(m.maxTokens),
    reasoning: m.reasoning,
    inputPrice: m.inputPrice === 0 ? "" : String(m.inputPrice),
    outputPrice: m.outputPrice === 0 ? "" : String(m.outputPrice),
  }));
}

const CustomProvidersTab = function CustomProvidersTab({ onGoAuth }: { onGoAuth?: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { sendProviderList, sendProviderSet, sendProviderDelete, subscribeProviderFrames, verifyProvider, pullModelCatalog, topology } = useSession();

  const [providers, setProviders] = useState<readonly ProviderView[] | null>(null);
  const [form, setForm] = useState<ProviderForm | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  /** 保存已发出、等 provider.list.result 回执（结果帧驱动关弹层——daemon 拒
   *  绝走 connection.error 无结果帧，乐观关会吞整表输入）。 */
  const savePendingRef = useRef(false);
  const idInputRef = useRef<HTMLInputElement | null>(null);
  const { armed: armedDelete, confirm: confirmDelete } = useArmedConfirm();

  useEffect(() => {
    sendProviderList();
  }, [sendProviderList]);
  useEffect(
    () =>
      subscribeProviderFrames((e) => {
        if (e.type === "provider.list.result") {
          setProviders(e.payload.providers);
          // 写后目录重拉（三方平台批 V2 修复）：provider.set/delete 已改写
          // daemon 目录（模型清单/上下文/计价即时生效），但 shell 的
          // mc.catalog 缓存不失效——P-3 菜单与设置页显示旧目录值。回执即
          // 静默重拉（无 loading 态；send false 静默容错，下次进入页面自然
          // 重拉）。
          pullModelCatalog();
          // 保存回执对账（族B）：provider.set 成功 → 关弹层（结果帧驱动，
          // 不乐观置位——拒绝路径无该回执，弹层与输入必须保留）
          if (savePendingRef.current) {
            savePendingRef.current = false;
            setForm(null);
          }
          return;
        }
        if (e.type === "connection.error") {
          // 族B（评审 :191）：provider.set/delete 拒绝走 connection.error 无
          // 结果帧——尾缀归因（「（命令 <type>）」单一构造点 WsServerAdapter）：
          // set → 弹层不关 + 行内交代（含无尾缀旧 daemon 容忍）；delete →
          // toast（无弹层在途位，fire-and-forget + 回执重拉对账）
          const message =
            (e.payload as { message?: string } | undefined)?.message ?? "connection.error";
          const cmd = /\uFF08\u547D\u4EE4 ([\w.]+)\uFF09\s*$/.exec(message)?.[1];
          if (cmd === "provider.delete") {
            toast.push("err", message);
            return;
          }
          if (cmd !== undefined && cmd !== "provider.set") return; // 他命令不归本 tab
          if (!savePendingRef.current) return; // 单飞门控：本 tab 无在途保存不消费
          savePendingRef.current = false;
          setFormErr(message);
          return;
        }
      }),
    [subscribeProviderFrames, pullModelCatalog, toast],
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

  const openForm = (provider?: ProviderView): void => {
    setFormErr(null);
    setForm(
      provider === undefined
        ? { ...EMPTY_FORM, modelRows: [{ ...EMPTY_MODEL_ROW }] }
        : {
            id: provider.id,
            idInput: provider.id,
            name: provider.name,
            api: provider.api,
            thinkingFormat: provider.thinkingFormat,
            baseUrl: provider.baseUrl,
            modelRows: rowsOf(provider),
          },
    );
    window.setTimeout(() => idInputRef.current?.focus(), MODAL_FOCUS_DELAY_MS);
  };

  /** 行内编辑（immutable 更新第 index 行字段）。 */
  const updateRow = (index: number, patch: Partial<ModelRowForm>): void => {
    if (form === null) return;
    setForm({ ...form, modelRows: form.modelRows.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  };

  /** 保存（id/baseUrl 非空 + 每行字段校验；行级红边 + 底部错误文案）。 */
  const saveForm = (): void => {
    if (form === null) return;
    const id = form.idInput.trim();
    const baseUrl = form.baseUrl.trim();
    if (id === "" || baseUrl === "") {
      setFormErr(t("chat.settings.general.cprovEmptyErr"));
      return;
    }
    if (form.modelRows.length === 0) {
      setFormErr(t("chat.settings.general.cprovModelsErr"));
      return;
    }
    const seen = new Set<string>();
    for (const row of form.modelRows) {
      const field = validateRow(row);
      if (field !== null) {
        setFormErr(t("chat.settings.general.cprovRowErr", { field: t(`chat.settings.general.cprovField_${field}`) }));
        return;
      }
      if (seen.has(row.id.trim())) {
        setFormErr(t("chat.settings.general.cprovDupErr", { id: row.id.trim() }));
        return;
      }
      seen.add(row.id.trim());
    }
    const ok = sendProviderSet({
      id,
      ...(form.name.trim() !== "" ? { name: form.name.trim() } : {}),
      api: form.api,
      thinkingFormat: form.thinkingFormat,
      baseUrl,
      models: form.modelRows.map((r) => ({
        id: r.id.trim(),
        ...(r.name.trim() !== "" ? { name: r.name.trim() } : {}),
        contextWindow: Number(r.contextWindow.trim()),
        ...(r.maxTokens.trim() !== "" ? { maxTokens: Number(r.maxTokens.trim()) } : {}),
        ...(r.reasoning ? { reasoning: true } : {}),
        ...(r.inputPrice.trim() !== "" ? { inputPrice: Number(r.inputPrice.trim()) } : {}),
        ...(r.outputPrice.trim() !== "" ? { outputPrice: Number(r.outputPrice.trim()) } : {}),
      })),
    });
    if (ok === false) {
      toast.push("err", t("chat.modelsConfig.sendFailToast"));
      return;
    }
    // 发出后不乐观关弹层（族B）：等 provider.list.result 回执收口；拒绝经
    // connection.error 回填 formErr（弹层保留，整表输入不丢）
    savePendingRef.current = true;
  };

  const onDelete = (id: string): void => {
    confirmDelete(id, () => {
      if (sendProviderDelete(id) === false) {
        toast.push("err", t("chat.modelsConfig.sendFailToast"));
      }
    });
  };

  return (
    <div data-cprov-tab>
      <div className="toolbar">
        <div className="toolbar-row">
          <span className="ag-note">{t("chat.settings.general.cprovNote")}</span>
          <button className="hud-btn hud-btn-cyan sm" type="button" data-cprov-add onClick={() => openForm()}>
            {t("chat.settings.general.cprovAdd")}
          </button>
        </div>
      </div>

      {providers !== null && providers.length === 0 && (
        <p className="ag-note" data-cprov-empty>
          {t("chat.settings.general.cprovEmpty")}
        </p>
      )}

      {(providers ?? []).map((p) => (
        <div className="hud-card" data-cprov-row={p.id} key={p.id}>
          <div className="toolbar">
            <div className="toolbar-row">
              <span className="prov-name" data-cprov-name={p.id}>
                {p.name}
              </span>
              <span className="catalog-meta" data-cprov-api={p.id}>
                {p.api === "anthropic-messages" ? "Anthropic" : "OpenAI"}
              </span>
              {p.thinkingFormat !== "auto" && (
                <span className="catalog-meta" data-cprov-tfmt={p.id}>
                  {t(`chat.settings.general.cprovThinkLabel.${p.thinkingFormat}`)}
                </span>
              )}
              <span className="catalog-meta" data-cprov-url={p.id}>
                {p.baseUrl} · {p.models.map((m) => m.id).join(", ")}
              </span>
              {p.keyMasked !== undefined ? (
                <span className="key-chip" data-cprov-key={p.id}>
                  key ····<span className="k4">{p.keyMasked.slice(-4)}</span>
                </span>
              ) : (
                <button className="key-none hud-btn hud-btn-ghost sm" type="button" data-cprov-goauth={p.id} onClick={() => onGoAuth?.()}>
                  {t("chat.settings.general.cprovGoAuth")}
                </button>
              )}
            </div>
            <div className="toolbar-row prov-actions">
              <button
                className="hud-btn hud-btn-ghost sm"
                type="button"
                data-cprov-verify={p.id}
                disabled={topology.modelConfig.auth[p.id]?.verifyStatus === "verifying"}
                onClick={() => {
                  if (verifyProvider(p.id) === false) toast.push("err", t("chat.modelsConfig.sendFailToast"));
                }}
              >
                {t("chat.modelsConfig.test")}
              </button>
              <button className="hud-btn hud-btn-ghost sm" type="button" data-cprov-edit={p.id} onClick={() => openForm(p)}>
                {t("chat.settings.general.embEdit")}
              </button>
              <button
                className="hud-btn hud-btn-danger sm"
                type="button"
                data-cprov-delete={p.id}
                data-armed={armedDelete === p.id ? "1" : undefined}
                onClick={() => onDelete(p.id)}
              >
                {armedDelete === p.id ? t("chat.modelsConfig.confirmDelete") : t("chat.settings.general.embDelete")}
              </button>
            </div>
          </div>
        </div>
      ))}

      {/* 新增/编辑弹层（hud-modal：embedding 弹层先例同构） */}
      {form !== null && (
        <div
          className="modal-backdrop open"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setForm(null);
          }}
        >
          <div className="hud-modal wide" role="dialog" aria-modal="true" aria-label={t("chat.settings.general.cprovModalTitle")}>
            <div className="modal-title">
              <span className="mt-ic">
                <Building2 size={16} strokeWidth={1.75} aria-hidden="true" />
              </span>
              {t("chat.settings.general.cprovModalTitle")}
            </div>
            <p className="modal-sub">{t("chat.settings.general.cprovModalSub")}</p>
            <div className="modal-body">
              <label className="hud-label" htmlFor="cprov-id">
                {t("chat.settings.general.cprovId")}
              </label>
              <input
                className={cn("hud-input", formErr !== null && form.idInput.trim() === "" && "err")}
                id="cprov-id"
                type="text"
                placeholder="volcengine-plan"
                value={form.idInput}
                ref={idInputRef}
                disabled={form.id !== undefined}
                data-cprov-form-id
                onChange={(e) => setForm({ ...form, idInput: e.target.value })}
              />
              <label className="hud-label" htmlFor="cprov-name">
                {t("chat.settings.general.cprovName")}
              </label>
              <input
                className="hud-input"
                id="cprov-name"
                type="text"
                placeholder={t("chat.settings.general.cprovNamePlaceholder")}
                value={form.name}
                data-cprov-form-name
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <label className="hud-label" htmlFor="cprov-api">
                {t("chat.settings.general.cprovApi")}
              </label>
              <select
                className="hud-input"
                id="cprov-api"
                value={form.api}
                data-cprov-form-api
                onChange={(e) => setForm({ ...form, api: e.target.value as ProviderApiStyle })}
              >
                <option value="openai-completions">{t("chat.settings.general.cprovApiOpenai")}</option>
                <option value="anthropic-messages">{t("chat.settings.general.cprovApiAnthropic")}</option>
              </select>
              <label className="hud-label" htmlFor="cprov-thinking">
                {t("chat.settings.general.cprovThinking")}
              </label>
              <select
                className="hud-input"
                id="cprov-thinking"
                value={form.thinkingFormat}
                data-cprov-form-thinking
                onChange={(e) => setForm({ ...form, thinkingFormat: e.target.value as ProviderThinkingFormat })}
              >
                <option value="auto">{t("chat.settings.general.cprovThinkAuto")}</option>
                <option value="openai">{t("chat.settings.general.cprovThinkOpenai")}</option>
                <option value="deepseek">{t("chat.settings.general.cprovThinkDeepseek")}</option>
                <option value="qwen">{t("chat.settings.general.cprovThinkQwen")}</option>
                <option value="zai">{t("chat.settings.general.cprovThinkZai")}</option>
                <option value="openrouter">{t("chat.settings.general.cprovThinkOpenrouter")}</option>
                <option value="together">{t("chat.settings.general.cprovThinkTogether")}</option>
                <option value="baseten">{t("chat.settings.general.cprovThinkBaseten")}</option>
                <option value="chat-template">{t("chat.settings.general.cprovThinkChatTemplate")}</option>
                <option value="qwen-chat-template">{t("chat.settings.general.cprovThinkQwenChatTemplate")}</option>
                <option value="string-thinking">{t("chat.settings.general.cprovThinkString")}</option>
                <option value="ant-ling">{t("chat.settings.general.cprovThinkAntling")}</option>
              </select>
              <label className="hud-label" htmlFor="cprov-baseurl">
                {t("chat.settings.general.cprovBaseUrl")}
              </label>
              <input
                className={cn("hud-input", formErr !== null && form.baseUrl.trim() === "" && "err")}
                id="cprov-baseurl"
                type="text"
                placeholder="https://ark.cn-beijing.volces.com/api/plan/v3"
                value={form.baseUrl}
                data-cprov-form-baseurl
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />

              {/* 模型清单：表格化单行编辑（列头一次 + 每模型一行；容器限高滚动，列头 sticky） */}
              <div className="toolbar-row cprov-models-head">
                <label className="hud-label" style={{ marginBottom: 0 }} htmlFor="cprov-model-rows">
                  {t("chat.settings.general.cprovModels")}
                </label>
                <button
                  className="hud-btn hud-btn-ghost sm"
                  type="button"
                  data-cprov-mrow-add
                  onClick={() => setForm({ ...form, modelRows: [...form.modelRows, { ...EMPTY_MODEL_ROW }] })}
                >
                  <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
                  {t("chat.settings.general.cprovAddModel")}
                </button>
              </div>
              <div className="cprov-tbl" data-cprov-model-rows id="cprov-model-rows">
                <div className="cprov-tbl-head cprov-row" aria-hidden="true">
                  <span className="req">{t("chat.settings.general.cprovCol_id")}</span>
                  <span>{t("chat.settings.general.cprovCol_name")}</span>
                  <span className="req">{t("chat.settings.general.cprovCol_contextWindow")}</span>
                  <span>{t("chat.settings.general.cprovCol_maxTokens")}</span>
                  <span>{t("chat.settings.general.cprovCol_inputPrice")}</span>
                  <span>{t("chat.settings.general.cprovCol_outputPrice")}</span>
                  <span className="cprov-col-reasoning">{t("chat.settings.general.cprovCol_reasoning")}</span>
                  <span className="cprov-col-del" />
                </div>
                <div className="cprov-tbl-rows">
                  {form.modelRows.map((row, i) => {
                    const rowErr = formErr !== null ? validateRow(row) : null;
                    return (
                      <div className="cprov-row" data-cprov-mrow={i} key={i}>
                        <input
                          className={cn("hud-input", rowErr === "id" && "err")}
                          type="text"
                          placeholder="kimi-k3"
                          aria-label={t("chat.settings.general.cprovField_id")}
                          value={row.id}
                          data-cprov-mrow-id={i}
                          onChange={(e) => updateRow(i, { id: e.target.value })}
                        />
                        <input
                          className="hud-input"
                          type="text"
                          placeholder="Kimi K3"
                          aria-label={t("chat.settings.general.cprovField_name")}
                          value={row.name}
                          data-cprov-mrow-name={i}
                          onChange={(e) => updateRow(i, { name: e.target.value })}
                        />
                        <input
                          className={cn("hud-input num", rowErr === "contextWindow" && "err")}
                          type="text"
                          inputMode="numeric"
                          placeholder="256000"
                          aria-label={t("chat.settings.general.cprovField_contextWindow")}
                          value={row.contextWindow}
                          data-cprov-mrow-ctx={i}
                          onChange={(e) => updateRow(i, { contextWindow: e.target.value })}
                        />
                        <input
                          className={cn("hud-input num", rowErr === "maxTokens" && "err")}
                          type="text"
                          inputMode="numeric"
                          placeholder="16384"
                          aria-label={t("chat.settings.general.cprovField_maxTokens")}
                          value={row.maxTokens}
                          data-cprov-mrow-max={i}
                          onChange={(e) => updateRow(i, { maxTokens: e.target.value })}
                        />
                        <input
                          className={cn("hud-input num", rowErr === "inputPrice" && "err")}
                          type="text"
                          inputMode="decimal"
                          placeholder="0.6"
                          aria-label={t("chat.settings.general.cprovField_inputPrice")}
                          value={row.inputPrice}
                          data-cprov-mrow-in={i}
                          onChange={(e) => updateRow(i, { inputPrice: e.target.value })}
                        />
                        <input
                          className={cn("hud-input num", rowErr === "outputPrice" && "err")}
                          type="text"
                          inputMode="decimal"
                          placeholder="2.5"
                          aria-label={t("chat.settings.general.cprovField_outputPrice")}
                          value={row.outputPrice}
                          data-cprov-mrow-out={i}
                          onChange={(e) => updateRow(i, { outputPrice: e.target.value })}
                        />
                        <span className="cprov-col-reasoning">
                          <input
                            type="checkbox"
                            checked={row.reasoning}
                            aria-label={t("chat.settings.general.cprovField_reasoning")}
                            data-cprov-mrow-reasoning={i}
                            onChange={(e) => updateRow(i, { reasoning: e.target.checked })}
                          />
                        </span>
                        {form.modelRows.length > 1 && (
                          <button
                            className="hud-btn hud-btn-ghost sm cprov-col-del"
                            type="button"
                            data-cprov-mrow-del={i}
                            aria-label={t("chat.settings.general.cprovDelModel")}
                            onClick={() => setForm({ ...form, modelRows: form.modelRows.filter((_, j) => j !== i) })}
                          >
                            <X size={14} strokeWidth={1.75} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              <span className={cn("form-err", formErr !== null && "show")} data-cprov-form-err>
                <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
                {formErr ?? ""}
              </span>
            </div>
            <div className="modal-foot">
              <button className="hud-btn hud-btn-ghost" type="button" onClick={() => setForm(null)} data-cprov-form-cancel>
                {t("chat.modelsConfig.cancel")}
              </button>
              <button className="hud-btn hud-btn-cyan" type="button" onClick={saveForm} data-cprov-form-save>
                {t("chat.modelsConfig.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomProvidersTab;
