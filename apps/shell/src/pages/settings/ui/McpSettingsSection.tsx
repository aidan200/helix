/**
 * 设置页「MCP」分区（mcp 批：MCP server 标准接入配置面）。
 *
 * 数据面：mcp.servers.list 拉取（进入分区一次性；CRUD 回执后重拉对账）
 * + subscribeMcpFrames 域订阅（mcp.*.result 点对点回执 + mcp.status.changed
 * 状态广播实时更新徽标 + connection.error 写面在途错误）。
 *
 * 三功能块：
 * - server 列表：name + command 摘要 + 五态徽标（idle/connecting/running/
 *   error/stopped）+ 工具数 + lastError（error 态展开）；两段式行内删除
 *   （armed 2.5s 超时复原——ModelsSettings key 删除先例）；
 * - 新增表单：name/command 必填 + args（空格分隔转数组）+ enabled 缺省开；
 *   提交 = mcp.servers.add（connect_failed 时行内错误提示、配置保留可重试）；
 * - 测试连接：表单现值 mcp.servers.test（不落盘不接入）applied/failed
 *   两判别行内反馈。
 *
 * 状态模型：servers 行[]（list.result 回填 / status.changed 单行合并）；
 * 表单 open|closed；删除 normal|armed（单值超时复原）；testIdle|testing|
 * ok|fail 四态互斥（重测先清旧态）。
 */
import { useEffect, useRef, useState } from "react";
import { Plug, PlugZap, Trash2 } from "lucide-react";
import type {
  McpServerConfigDto,
  McpServerRuntimeState,
  McpServerStatusDto,
} from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";

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
  const {
    sendMcpServersList,
    sendMcpServersAdd,
    sendMcpServersRemove,
    sendMcpServersTest,
    subscribeMcpFrames,
  } = useSession();

  const [servers, setServers] = useState<readonly McpServerRow[] | null>(null);
  /** 表单 open|closed（首版仅新增形态；编辑 = 删除后重加）。 */
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  /** args 单行空格分隔（协议 string[]；表单内字符串化）。 */
  const [args, setArgs] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [deferred, setDeferred] = useState(true);
  const [formError, setFormError] = useState("");
  const [addPending, setAddPending] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  /** 删除两段式：normal|armed（armed 2.5s 超时复原）。 */
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
          if (type === "mcp.servers.add.result") {
            const payload = frame.payload as { status: string; error?: string };
            setAddPending(false);
            if (payload.status === "connect_failed") {
              setFormError(payload.error ?? t("chat.settings.mcp.connectFailed"));
            } else {
              // 成功：收起表单 + 清空（配置已落盘运行）
              setFormOpen(false);
              setName("");
              setCommand("");
              setArgs("");
              setEnabled(true);
              setFormError("");
              setTest({ kind: "idle" });
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
        if (type === "connection.error" && addPending) {
          setAddPending(false);
          setFormError(t("chat.settings.mcp.addFailed"));
        }
      }),
    [subscribeMcpFrames, sendMcpServersList, t, addPending],
  );

  /** 表单现值 → McpServerInput（args 空格分隔转数组；空串 → 缺省；deferred 缺省 true = 懒加载）。 */
  const formInput = () => {
    const trimmedArgs = args.trim();
    return {
      name: name.trim(),
      command: command.trim(),
      ...(trimmedArgs !== "" ? { args: trimmedArgs.split(/\s+/) } : {}),
      enabled,
      deferred,
    };
  };

  const submitAdd = (): void => {
    setFormError("");
    if (name.trim() === "" || command.trim() === "") {
      setFormError(t("chat.settings.mcp.formInvalid"));
      return;
    }
    setAddPending(true);
    sendMcpServersAdd(formInput());
  };

  const submitTest = (): void => {
    setTest({ kind: "testing" }); // 重测先清旧态
    sendMcpServersTest(formInput());
  };

  /** 两段式删除：首击 armed（2.5s 复原），二击执行。 */
  const onDelete = (serverName: string): void => {
    if (armedDelete !== serverName) {
      setArmedDelete(serverName);
      clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(() => setArmedDelete(null), 2500);
      return;
    }
    clearTimeout(disarmTimer.current);
    setArmedDelete(null);
    sendMcpServersRemove({ name: serverName });
  };

  useEffect(() => () => clearTimeout(disarmTimer.current), []);

  /** 五态徽标类名（running 绿 / error 红 / 其余弱化）。 */
  const badgeClass = (state: McpServerRuntimeState): string =>
    cn("mcp-state", state === "running" && "mcp-state-ok", state === "error" && "mcp-state-err");

  return (
    <div className="pg" data-mcp-settings-section>
      <div className="hud-card">
        <div className="set-card-head">
          <h2 className="section-label">{t("chat.settings.mcp.title")}</h2>
          <button
            type="button"
            className={cn("hud-btn sm", formOpen ? "hud-btn-ghost" : "hud-btn-cyan")}
            data-mcp-add-toggle
            onClick={() => setFormOpen((v) => !v)}
          >
            <PlugZap size={14} />
            {t("chat.settings.mcp.addServer")}
          </button>
        </div>
        <p className="ag-note">{t("chat.settings.mcp.subtitle")}</p>

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
                disabled={addPending}
                onClick={submitAdd}
              >
                {addPending ? t("chat.settings.mcp.adding") : t("chat.settings.mcp.addConfirm")}
              </button>
              <button
                type="button"
                className="hud-btn hud-btn-ghost"
                data-mcp-test
                disabled={test.kind === "testing"}
                onClick={submitTest}
              >
                <Plug size={14} />
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
                  className={cn("hud-btn sm", armedDelete === row.config.name ? "hud-btn-danger" : "hud-btn-ghost")}
                  data-mcp-delete={row.config.name}
                  onClick={() => onDelete(row.config.name)}
                >
                  <Trash2 size={13} />
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
