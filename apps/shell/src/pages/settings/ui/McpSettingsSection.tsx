/**
 * 设置页「MCP」分区（mcp 批：MCP server 标准接入配置面）。
 * （UI 修复批：分区标题由 pg-title 承载，卡头只留按钮组——见 workbench.css
 *  .set-card-head 注释）
 *
 * 数据面：mcp.servers.list 拉取（进入分区一次性；CRUD 回执后重拉对账）
 * + subscribeMcpFrames 域订阅（mcp.*.result 点对点回执 + mcp.status.changed
 * 状态广播实时更新徽标 + connection.error 写面在途错误）。
 *
 * 四功能块：
 * - server 列表：name + command 摘要 + 五态徽标（idle/connecting/running/
 *   error/stopped）+ 工具数 + lastError（error 态展开）；两段式行内删除
 *   （armed 2.5s 超时复原——ModelsSettings key 删除先例）+ 行内编辑入口
 *   （update 接线批，CAND-705）；
 * - 新增/编辑表单：name/command 必填 + args（空格分隔转数组）+ enabled
 *   缺省开；提交 = mcp.servers.add / mcp.servers.update（编辑态 name 锁定
 *   ——update 按 name 定位，改名 = 删除后重加；connect_failed 时行内错误
 *   提示、配置保留可重试）；
 * - 导入面板（粘贴批）：直接粘贴完整 JSON 文本（Claude Desktop/Cursor
 *   mcpServers 格式或单 server 裸对象）→ 解析取首个 server 预填表单；
 *   裸对象无名可取——name 留空 + 提示补填（替代旧 file input 文件导入；
 *   面板内行内错误，不弹 toast）；
 * - 测试连接：表单现值 mcp.servers.test（不落盘不接入）applied/failed
 *   两判别行内反馈。
 *
 * 状态模型：servers 行[]（list.result 回填 / status.changed 单行合并）；
 * 表单 open|closed + mode add|edit；删除 normal|armed（单值超时复原）；
 * testIdle|testing|ok|fail 四态互斥（重测先清旧态）；savePending
 * add/update 共用在途位。
 */
import { useEffect, useRef, useState } from "react";
import { Plug, PlugZap, Pencil, Trash2, ClipboardPaste } from "lucide-react";
/** 卡头按钮图标统一拖参（项目全局部件 strokeWidth=1.75 + 装饰性图标 aria-hidden）。 */
const ICON_PROPS = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;
import type {
  McpServerConfigDto,
  McpServerRuntimeState,
  McpServerStatusDto,
} from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { cn } from "@/shared/lib/cn";
import { useArmedConfirm } from "./settings-hooks";

/** list.result 合并行形态（协议 McpServersListResultPayload.servers 项）。 */
interface McpServerRow {
  readonly config: McpServerConfigDto;
  readonly status: McpServerStatusDto;
}

type TestState =
  | { readonly kind: "idle" }
  | { readonly kind: "testing" }
  | { readonly kind: "ok"; readonly toolCount: number }
  | { readonly kind: "fail"; readonly error: string };

const McpSettingsSection = function McpSettingsSection() {
  const { t } = useI18n();
  const toast = useToast();
  const {
    sendMcpServersList,
    sendMcpServersAdd,
    sendMcpServersUpdate,
    sendMcpServersRemove,
    sendMcpServersTest,
    subscribeMcpFrames,
  } = useSession();

  const [servers, setServers] = useState<readonly McpServerRow[] | null>(null);
  /** 表单 open|closed + mode：add 新增（空表单）/ edit 编辑（预填 + name 锁定
   *  ——update 按 name 定位，改名 = 删除后重加）。 */
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"add" | "edit">("add");
  // 族A（TR-173）：listener 闭包读最新 mode 的镜像 ref——写入走 markFormMode
  // setter 包装（ref.current 与 setState 同点写），禁渲染体裸写。
  const formModeRef = useRef<"add" | "edit">("add");
  const markFormMode = (v: "add" | "edit") => {
    formModeRef.current = v;
    setFormMode(v);
  };
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  /** args 单行空格分隔（协议 string[]；表单内字符串化）。 */
  const [args, setArgs] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [deferred, setDeferred] = useState(true);
  const [formError, setFormError] = useState("");
  /** 导入提示（多 server 发现计数/裸对象补填名提醒；预填后行内反馈，不弹 toast）。 */
  const [importNote, setImportNote] = useState("");
  // 导入面板（粘贴批）：开合 + 粘贴文本 + 面板内行内错误（独立于表单错误位——
  // 解析失败不打扰表单，也不强制展开表单）。
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  // save 在途位（add/update 共用）：addPending 更名泛化——提交钮防重 + 回执对账。
  const [savePending, setSavePending] = useState(false);
  // 在途位同步 ref：订阅 effect 真挂载一次（listener 读 ref 不进 deps——
  // savePending 翻转不再退订重订，add/update.result 回执无窗口丢失面）
  const savePendingRef = useRef(false);
  const markSavePending = (v: boolean) => {
    savePendingRef.current = v;
    setSavePending(v);
  };
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  // 族A：testing 在途位 ref 镜像（订阅 effect 真挂载一次——listener 读 ref 不进 deps）
  const testingRef = useRef(false);
  testingRef.current = test.kind === "testing";
  /** 删除两段式：normal|armed（armed 2.5s 超时复原）——M10 批⑤ hook 单点承载。 */
  const { armed: armedDelete, confirm: confirmDelete } = useArmedConfirm();

  // 进入分区拉取
  useEffect(() => {
    sendMcpServersList();
  }, [sendMcpServersList]);

  // 域订阅：回执/广播消费（listener 引用稳定——挂载一次）
  useEffect(
    () =>
      subscribeMcpFrames((frame) => {
        const type = frame.type;
        if (type === "mcp.servers.list.result") {
          setServers((frame.payload as { servers: McpServerRow[] }).servers ?? []);
          return;
        }
        if (type === "mcp.status.changed") {
          // 状态广播：单行合并（connecting/running/error/stopped 实时徽标）
          const status = (frame.payload as { server: McpServerStatusDto }).server;
          setServers((rows) =>
            rows === null
              ? rows
              : rows.map((row) => (row.config.name === status.name ? { ...row, status } : row)),
          );
          return;
        }
        if (
          type === "mcp.servers.add.result" ||
          type === "mcp.servers.remove.result" ||
          type === "mcp.servers.update.result"
        ) {
          // CRUD 回执：重拉对账（回执只带单行；list 全量简单可靠）
          sendMcpServersList();
          if (type !== "mcp.servers.remove.result") {
            const payload = frame.payload as { status: string; error?: string };
            markSavePending(false);
            if (payload.status === "connect_failed") {
              setFormError(payload.error ?? t("chat.settings.mcp.connectFailed"));
            } else {
              // 成功：收起表单 + 复位新增态 + 清空（配置已落盘运行；update
              //  路径后端断旧连重连，新状态经 mcp.status.changed 广播接管）
              setFormOpen(false);
              markFormMode("add");
              setName("");
              setCommand("");
              setArgs("");
              setEnabled(true);
              setDeferred(true);
              setFormError("");
              setTest({ kind: "idle" });
              setImportNote("");
            }
          }
          return;
        }
        if (type === "mcp.servers.test.result") {
          const payload = frame.payload as { status: string; toolCount?: number; error?: string };
          setTest(
            payload.status === "applied"
              ? { kind: "ok", toolCount: payload.toolCount ?? 0 }
              : { kind: "fail", error: payload.error ?? "" },
          );
          return;
        }
        if (type === "connection.error") {
          // code-review 族A（TR-144/145）：命令尾缀归因（WsServerAdapter.commandError
          // 「（命令 <type>）」单一构造点；无尾缀旧 daemon 容忍按可能本族处理）+
          // 按在途 kind 收口——原只清 addPending，testing 永挂/remove 静默失败
          const p = (frame as { payload?: { message?: string } }).payload;
          const message = p?.message ?? "connection.error";
          const cmd = /\uFF08\u547D\u4EE4 ([\w.]+)\uFF09\s*$/.exec(message)?.[1];
          if (cmd !== undefined && !cmd.startsWith("mcp.servers.")) return; // 非本族不消费
          if (savePendingRef.current) {
            markSavePending(false);
            setFormError(
              formModeRef.current === "edit"
                ? t("chat.settings.mcp.updateFailed")
                : t("chat.settings.mcp.addFailed"),
            );
            return;
          }
          if (testingRef.current) {
            setTest({ kind: "fail", error: message }); // testing 收口：行内失败态交代
            return;
          }
          if (cmd === "mcp.servers.remove") {
            // remove 无本地在途位（fire-and-forget + 回执重拉对账）——尾缀辨识后 toast 交代
            toast.push("err", t("chat.settings.mcp.removeFailed", { message }));
          }
          return;
        }
      }),
    [subscribeMcpFrames, sendMcpServersList, t, toast],
  );

  /**
 * args 序列化/反序列化对（导入预填与表单提交共用同一契约）：含空白 arg
 * 以双引号包裹（内部引号转义），纯空格分隔保持原样——Claude Desktop
 * 配置含路径空格的 arg 往返不拆碎。
 */
function serializeArgs(args: readonly string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}
function parseArgs(input: string): string[] {
  // 双引号段（转义引号支持）或裸 token；未配对引号按字面回退
  const out: string[] = [];
  for (const m of input.trim().matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    if (m[1] !== undefined) out.push(m[1].replace(/\\"/g, '"'));
    else if (m[2] !== undefined) out.push(m[2]);
  }
  return out;
}

/** 解析粘贴的 MCP 配置 JSON（Claude Desktop/Cursor mcpServers 格式或单 server 裸对象）：取首个 server 预填表单，成功即收起面板。 */
  const parseImportText = (): void => {
    setImportError("");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(importText) as Record<string, unknown>;
    } catch {
      setImportError(t("chat.settings.mcp.importFail"));
      return;
    }
    // 形态一：{ mcpServers: { <name>: {...} } }（Claude Desktop/Cursor）；形态二：单 server 裸对象（粘贴文本无名可取——name 留空提示补填，表单必填校验兜底）
    const servers =
      parsed.mcpServers !== undefined && typeof parsed.mcpServers === "object" && parsed.mcpServers !== null
        ? (parsed.mcpServers as Record<string, unknown>)
        : { "": parsed };
    const entries = Object.entries(servers).filter(([, v]) => typeof v === "object" && v !== null);
    const [name, cfgRaw] = entries[0] ?? [];
    const cfg = cfgRaw as { command?: unknown; args?: unknown } | undefined;
    if (cfg === undefined || typeof cfg.command !== "string" || cfg.command === "") {
      setImportError(t("chat.settings.mcp.importFail"));
      return;
    }
    setName(name ?? "");
    setCommand(cfg.command);
    setArgs(Array.isArray(cfg.args) && cfg.args.every((a) => typeof a === "string") ? serializeArgs(cfg.args as string[]) : "");
    setFormError("");
    setTest({ kind: "idle" });
    // 成功：收起面板清文本 + 展开表单（预填后焦点交给表单补填/提交）
    setImportOpen(false);
    setImportText("");
    setFormOpen(true);
    if (entries.length > 1) {
      // 多 server 提示：只填入首个（零协议扩展——批量导入后续可扩展）
      setImportNote(t("chat.settings.mcp.importMulti", { count: entries.length }));
    } else if ((name ?? "") === "") {
      setImportNote(t("chat.settings.mcp.importUnnamed"));
    } else {
      setImportNote("");
    }
  };

  /** 表单现值 → McpServerInput（args 空格分隔转数组（引号段含空白不拆）；空串 → 缺省；deferred 缺省 true = 懒加载）。 */
  const formInput = () => {
    const trimmedArgs = args.trim();
    return {
      name: name.trim(),
      command: command.trim(),
      ...(trimmedArgs !== "" ? { args: parseArgs(trimmedArgs) } : {}),
      enabled,
      deferred,
    };
  };

  /** 表单收起 + 复位新增态 + 清空字段（成功回执/编辑取消两路径；新增态
   *  toggle 收起不清字段——填一半收起再展开不丢，导入用例依赖）。 */
  const closeForm = (): void => {
    setFormOpen(false);
    markFormMode("add");
    setName("");
    setCommand("");
    setArgs("");
    setEnabled(true);
    setDeferred(true);
    setFormError("");
    setTest({ kind: "idle" });
    setImportNote("");
  };

  /** 行内编辑：预填现值展开表单（enabled/deferred 按「缺省 true」语义还原）。 */
  const openEdit = (row: McpServerRow): void => {
    markFormMode("edit");
    setName(row.config.name);
    setCommand(row.config.command);
    setArgs(serializeArgs(row.config.args ?? []));
    setEnabled(row.config.enabled !== false);
    setDeferred(row.config.deferred !== false);
    setFormError("");
    setImportNote("");
    setTest({ kind: "idle" });
    setFormOpen(true);
  };

  const submitSave = (): void => {
    setFormError("");
    if (name.trim() === "" || command.trim() === "") {
      setFormError(t("chat.settings.mcp.formInvalid"));
      return;
    }
    // code-review H9（TR-168/169：=== false 严格判）：send false（未发出）→
    // 不置在途（钮不永锁，可修正重提）+ 行内错误交代；仅发出成功才入在途对账。
    // 编辑态走 update（后端同名幂等：断旧连 → 重连 → 重新发现，无需重启 daemon）
    const input = formInput();
    const sent = formMode === "edit" ? sendMcpServersUpdate(input) : sendMcpServersAdd(input);
    if (sent === false) {
      setFormError(t("chat.settings.mcp.sendFail"));
      return;
    }
    markSavePending(true);
  };

  const submitTest = (): void => {
    // code-review H9：send false → 不进 testing（钮不永挂）+ fail 态行内交代
    if (sendMcpServersTest(formInput()) === false) {
      setTest({ kind: "fail", error: t("chat.settings.mcp.sendFail") });
      return;
    }
    setTest({ kind: "testing" }); // 重测先清旧态
  };

  /** 两段式删除：首击 armed（2.5s 复原），二击执行。 */
  const onDelete = (serverName: string): void => {
    // 族A（TR-168）：send 返回值必消费——false（未连接）即 err toast 交代，不静默
    confirmDelete(serverName, () => {
      if (sendMcpServersRemove({ name: serverName }) === false) {
        toast.push("err", t("chat.settings.mcp.sendFail"));
      }
    });
  };

  /** 五态徽标类名（running 绿 / error 红 / 其余弱化）。 */
  const badgeClass = (state: McpServerRuntimeState): string =>
    cn("mcp-state", state === "running" && "mcp-state-ok", state === "error" && "mcp-state-err");

  return (
    <div className="pg" data-mcp-settings-section>
      <h2 className="pg-title">{t("chat.settings.mcp.title")}</h2>
      <div className="hud-card">
        <div className="set-card-head">
          <button
            type="button"
            className={cn("hud-btn sm", formOpen ? "hud-btn-ghost" : "hud-btn-cyan")}
            data-mcp-add-toggle
            onClick={() => {
              // 编辑态收起 = 复位（字段清）；新增态收起保留现值（导入/半填场景）
              if (formOpen) {
                if (formMode === "edit") closeForm();
                else setFormOpen(false);
              } else {
                setFormOpen(true);
              }
            }}
          >
            <PlugZap {...ICON_PROPS} />
            {t("chat.settings.mcp.addServer")}
          </button>
          <button
            type="button"
            className={cn("hud-btn sm", importOpen ? "hud-btn-ghost" : "hud-btn-cyan")}
            data-mcp-import
            onClick={() => {
              setImportOpen((v) => !v);
              setImportError("");
            }}
          >
            <ClipboardPaste {...ICON_PROPS} />
            {t("chat.settings.mcp.importLabel")}
          </button>
        </div>
        <p className="ag-note">{t("chat.settings.mcp.subtitle")}</p>

        {/* 导入面板（粘贴批）：直接粘贴完整 JSON 文本解析——不再走 .json 文件选择 */}
        {importOpen && (
          <div className="mcp-form" data-mcp-import-panel>
            <div className="fld">
              <label className="hud-label" htmlFor="mcp-import-json">
                {t("chat.settings.mcp.importLabel")}
              </label>
              <textarea
                id="mcp-import-json"
                className="hud-input"
                value={importText}
                data-mcp-import-text
                rows={8}
                spellCheck={false}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={t("chat.settings.mcp.importPlaceholder")}
              />
            </div>
            <div className="mcp-form-actions">
              <button
                type="button"
                className="hud-btn hud-btn-cyan"
                data-mcp-import-parse
                onClick={parseImportText}
              >
                <ClipboardPaste {...ICON_PROPS} />
                {t("chat.settings.mcp.importParse")}
              </button>
            </div>
            {importError !== "" && (
              <p className="mcp-err" data-mcp-import-error>
                {importError}
              </p>
            )}
          </div>
        )}

        {formOpen && (
          <div className="mcp-form" data-mcp-form>
            <div className="fld">
              <label className="hud-label" htmlFor="mcp-name">
                {t("chat.settings.mcp.fieldName")}
              </label>
              <input
                id="mcp-name"
                className="hud-input"
                value={name}
                data-mcp-name
                onChange={(e) => setName(e.target.value)}
                placeholder="shadcn"
                disabled={formMode === "edit"}
                title={formMode === "edit" ? t("chat.settings.mcp.editNameLocked") : undefined}
              />
            </div>
            <div className="fld">
              <label className="hud-label" htmlFor="mcp-command">
                {t("chat.settings.mcp.fieldCommand")}
              </label>
              <input
                id="mcp-command"
                className="hud-input"
                value={command}
                data-mcp-command
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
              />
            </div>
            <div className="fld">
              <label className="hud-label" htmlFor="mcp-args">
                {t("chat.settings.mcp.fieldArgs")}
              </label>
              <input
                id="mcp-args"
                className="hud-input"
                value={args}
                data-mcp-args
                onChange={(e) => setArgs(e.target.value)}
                placeholder="shadcn@latest mcp"
              />
            </div>
            <label className="mcp-enabled" data-mcp-enabled>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              {t("chat.settings.mcp.fieldEnabled")}
            </label>
            <label className="mcp-enabled" data-mcp-deferred title={t("chat.settings.mcp.fieldDeferredHint")}>
              <input
                type="checkbox"
                checked={deferred}
                onChange={(e) => setDeferred(e.target.checked)}
              />
              {t("chat.settings.mcp.fieldDeferred")}
            </label>
            <div className="mcp-form-actions">
              <button
                type="button"
                className="hud-btn hud-btn-cyan"
                data-mcp-submit
                disabled={savePending}
                onClick={submitSave}
              >
                {savePending
                  ? t(formMode === "edit" ? "chat.settings.mcp.saving" : "chat.settings.mcp.adding")
                  : t(formMode === "edit" ? "chat.settings.mcp.editConfirm" : "chat.settings.mcp.addConfirm")}
              </button>
              {formMode === "edit" && (
                <button
                  type="button"
                  className="hud-btn hud-btn-ghost"
                  data-mcp-cancel
                  onClick={closeForm}
                >
                  {t("chat.settings.mcp.cancel")}
                </button>
              )}
              <button
                type="button"
                className="hud-btn hud-btn-ghost"
                data-mcp-test
                disabled={test.kind === "testing"}
                onClick={submitTest}
              >
                <Plug {...ICON_PROPS} />
                {test.kind === "testing"
                  ? t("chat.settings.mcp.testing")
                  : t("chat.settings.mcp.test")}
              </button>
              {test.kind === "ok" && (
                <span className="ag-note" data-mcp-test-ok>
                  {t("chat.settings.mcp.testOk", { count: test.toolCount })}
                </span>
              )}
              {test.kind === "fail" && (
                <span className="mcp-err" data-mcp-test-fail>
                  {t("chat.settings.mcp.testFail")}：{test.error}
                </span>
              )}
            </div>
            {formError !== "" && (
              <p className="mcp-err" data-mcp-form-error>
                {formError}
              </p>
            )}
            {importNote !== "" && (
              <p className="ag-note" data-mcp-import-note>
                {importNote}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="hud-card" data-mcp-server-list>
        {servers === null ? (
          <p className="ag-note">{t("chat.settings.mcp.loading")}</p>
        ) : servers.length === 0 ? (
          <p className="ag-note">{t("chat.settings.mcp.empty")}</p>
        ) : (
          servers.map((row) => (
            <div className="mcp-row" key={row.config.name} data-mcp-row={row.config.name}>
              <div className="mcp-row-main">
                <span className="mcp-name">{row.config.name}</span>
                <span className={badgeClass(row.status.state)} data-mcp-state={row.status.state}>
                  {t(`chat.settings.mcp.state.${row.status.state}`)}
                </span>
                {row.status.state === "running" && row.status.toolCount !== undefined && (
                  <span className="ag-note" data-mcp-tool-count>
                    {t("chat.settings.mcp.toolCount", { count: row.status.toolCount })}
                  </span>
                )}
                {row.config.enabled === false && (
                  <span className="ag-note">{t("chat.settings.mcp.disabledNote")}</span>
                )}
                {row.config.deferred !== false && (
                  <span className="ag-note" data-mcp-deferred-badge title={t("chat.settings.mcp.fieldDeferredHint")}>
                    {t("chat.settings.mcp.deferredBadge")}
                  </span>
                )}
              </div>
              <div className="mcp-row-side">
                <code className="mcp-cmd">
                  {[row.config.command, ...(row.config.args ?? [])].join(" ")}
                </code>
                <button
                  type="button"
                  className="hud-btn sm hud-btn-ghost"
                  data-mcp-edit={row.config.name}
                  onClick={() => openEdit(row)}
                >
                  <Pencil {...ICON_PROPS} />
                  {t("chat.settings.mcp.edit")}
                </button>
                <button
                  type="button"
                  className={cn("hud-btn sm", armedDelete === row.config.name ? "hud-btn-danger" : "hud-btn-ghost")}
                  data-mcp-delete={row.config.name}
                  onClick={() => onDelete(row.config.name)}
                >
                  <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                  {armedDelete === row.config.name
                    ? t("chat.settings.mcp.deleteConfirm")
                    : t("chat.settings.mcp.delete")}
                </button>
              </div>
              {row.status.state === "error" && row.status.lastError !== undefined && (
                <p className="mcp-err" data-mcp-last-error>
                  {row.status.lastError}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default McpSettingsSection;
