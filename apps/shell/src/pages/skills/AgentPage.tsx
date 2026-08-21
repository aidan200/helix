/**
 * 智能体页（M6 T4；skills 施工牌升格，路由 /skills 不动——URL 稳定，导航名
 * 改「智能体」。S3a 应用壳统一：迁 AppLayout（headerLeft = 页名；main =
 * 原 ag-body 内容，.pg 版心保留在 main 内），ag-page/ag-head 自建壳与
 * 页内 scanline 副本退役（氛围层全局单份在 App.tsx；滚动只发生在
 * .layout-main）。
 *
 * 页面形态（规划 §三定稿）：双 profile kind 卡片——
 * - main-session「主会话助手」：模型槽位下拉（数据 = topology.modelConfig
 *   目录面，P-3/P-4 同源；S3a 口径对齐 chat：filterAvailableModels
 *   configured 过滤 + 当前项兜底 + authLoaded 门控，进页/重连补发
 *   auth.list；缺省项「跟随全局默认」= 四级链出厂默认语义，注解两级
 *   关系）+ 工具组（8 项，snippet 一句话）+ 技能组（user/project
 *   来源分组 + 扫描诊断警示）；
 * - subagent-worker：同构，缺省项「跟随会话与全局默认」（三级链），注解
 *   「spawn 时刻定格」语义。
 *
 * 数据通道（AG-15 页面私有 reducer，trace 先例；T3 遗留②收口）：
 * - 读面：进页/重连/changed 广播（拓扑 agentConfig.revision 递增）→
 *   agent.config.list → list.result 双块（SessionContext 转发层订阅）；
 * - 写面：开关/下拉 → agent.config.set_enabled（单飞——结果帧无请求回显，
 *   pending 非空不再发新写）→ applied 等 changed 重拉收口；skipped 回执
 *   toast 呈现原因 + 在途清（态不翻转，daemon 权威）；
 * - 多页一致性：changed 广播 → revision → 重拉（不本地写态）。
 * 状态模型：idle → loading → ready/error 互斥（有数据静默重拉防闪烁）；
 * pending 行集（model 槽位空名键）。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { AgentConfigListResultPayload, AgentConfigProfileBlock, CatalogModel } from "@helix/protocol";
import { ChevronDown, RotateCw, TriangleAlert } from "lucide-react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { cn } from "@/shared/lib/cn";
import AppLayout from "@/widgets/app-layout/ui/AppLayout";
import { filterAvailableModels } from "@/features/model-switch/model/available-models";
import type { AuthProviderEntry } from "@/entities/session/model/state";
import type { EventEnvelope } from "@helix/protocol";
import {
  AGENT_KINDS,
  agentPageReducer,
  createAgentPageState,
  selectAgentPageView,
  type AgentKind,
} from "./model/agent-config-model";

/** 写面载荷（resourceType 收窄于协议三值，页面只发这三类）。 */
type WriteResource = "tool" | "skill" | "model";

/** 开关（语义化 role=switch + aria-checked；track+thumb+状态词）。 */
function AgentSwitch({
  name,
  checked,
  disabled,
  onToggle,
}: {
  name: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={cn("ag-switch", checked && "on")}
      role="switch"
      aria-checked={checked}
      aria-label={name}
      data-switch={name}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="ag-switch-track" aria-hidden="true">
        <span className="ag-switch-thumb" />
      </span>
      <span className="ag-switch-state">{checked ? t("agents.switchOn") : t("agents.switchOff")}</span>
    </button>
  );
}

/** 单 kind 配置卡（hud-card 载体；模型槽位 + 工具组 + 技能组 + 诊断）。 */
function ProfileCard({
  kind,
  block,
  skeleton,
  catalog,
  auth,
  authLoaded,
  writePending,
  onToggle,
  onModelChange,
}: {
  kind: AgentKind;
  block: AgentConfigProfileBlock | null;
  skeleton: boolean;
  catalog: CatalogModel[] | null;
  auth: Record<string, AuthProviderEntry>;
  authLoaded: boolean;
  writePending: boolean;
  onToggle: (kind: AgentKind, resourceType: WriteResource, name: string, enabled: boolean) => void;
  onModelChange: (kind: AgentKind, model: string) => void;
}) {
  const { t } = useI18n();
  const isMain = kind === "main-session";
  const selId = `sel-model-${kind}`;
  /** S3a 可用性口径（与 chat P-3 同一过滤函数、同一数据源）：configured
   * provider join + 当前槽位模型兜底（provider 未配置仍保留，防下拉里
   * 找不到当前项）+ authLoaded=false 不过滤（防骨架期空列表闪烁）；
   * 过滤后按 providerId 分组（组间/组内序沿目录；P-4 optgroup 形态）。 */
  const modelsByProvider = useMemo(() => {
    const visible = filterAvailableModels({
      models: catalog ?? [],
      auth,
      authLoaded,
      currentModel: block?.model ?? undefined,
      query: "",
    });
    const map = new Map<string, CatalogModel[]>();
    for (const m of visible) {
      const list = map.get(m.providerId);
      if (list) list.push(m);
      else map.set(m.providerId, [m]);
    }
    return map;
  }, [catalog, auth, authLoaded, block?.model]);

  return (
    <section className="hud-card ag-card" data-agent-card={kind}>
      <header className="ag-card-head">
        <h2 className="ag-card-title">{isMain ? t("agents.mainTitle") : t("agents.subTitle")}</h2>
        <span className="hud-chip" data-kind-chip>
          {kind}
        </span>
      </header>

      {/* 模型槽位：缺省项 = 跟随全局默认（main）/ 跟随会话与全局默认（sub） */}
      <div className="ag-model">
        <label className="hud-label" htmlFor={selId}>
          {t("agents.modelLabel")}
        </label>
        <div className="sel-wrap">
          <select
            id={selId}
            className="hud-input"
            value={block?.model ?? ""}
            disabled={catalog === null || writePending || skeleton}
            onChange={(e) => onModelChange(kind, e.target.value)}
          >
            <option value="">{isMain ? t("agents.modelFollowMain") : t("agents.modelFollowSub")}</option>
            {[...modelsByProvider.entries()].map(([providerId, models]) => (
              <optgroup label={providerId} key={providerId}>
                {models.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.id}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="sel-chev">
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
          </span>
        </div>
        <p className="ag-note" data-note={isMain ? "main" : "sub"}>
          {isMain ? t("agents.modelNoteMain") : t("agents.modelNoteSub")}
        </p>
      </div>

      {/* 工具组：名称 + snippet 一句话 + 开关 */}
      <div className="ag-group">
        <h3 className="ag-group-label">{t("agents.toolsLabel")}</h3>
        {skeleton ? (
          <div className="ag-skel" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div className="ag-skel-row" key={i}>
                <span className="ag-skel-bar" style={{ width: 96 }} />
                <span className="ag-skel-bar" style={{ width: `${58 - i * 8}%` }} />
              </div>
            ))}
          </div>
        ) : (
          (block?.tools ?? []).map((tool) => (
            <div className="ag-row" data-tool-row={tool.name} key={tool.name}>
              <div className="ag-row-main">
                <span className="ag-name">{tool.name}</span>
                <span className="ag-desc">{tool.snippet}</span>
              </div>
              <AgentSwitch
                name={tool.name}
                checked={tool.enabled}
                disabled={writePending}
                onToggle={() => onToggle(kind, "tool", tool.name, !tool.enabled)}
              />
            </div>
          ))
        )}
      </div>

      {/* 技能组：user/project 来源分组 + 开关 + 诊断警示 */}
      <div className="ag-group">
        <h3 className="ag-group-label">{t("agents.skillsLabel")}</h3>
        {skeleton ? (
          <div className="ag-skel" aria-hidden="true">
            {[0, 1].map((i) => (
              <div className="ag-skel-row" key={i}>
                <span className="ag-skel-bar" style={{ width: 120 }} />
                <span className="ag-skel-bar" style={{ width: `${48 - i * 8}%` }} />
              </div>
            ))}
          </div>
        ) : (block?.skills ?? []).length === 0 ? (
          <p className="ag-empty-hint">{t("agents.skillsEmpty")}</p>
        ) : (
          (["user", "project"] as const).map((source) => {
            const rows = (block?.skills ?? []).filter((s) => s.source === source);
            if (rows.length === 0) return null;
            return (
              <div data-source-group={source} key={source}>
                <div className="ag-src-label">{source}</div>
                {rows.map((skill) => (
                  <div className="ag-row" data-skill-row={skill.name} key={skill.filePath}>
                    <div className="ag-row-main">
                      <span className="ag-name">{skill.name}</span>
                      <span className="ag-desc" title={skill.description}>
                        {skill.description}
                      </span>
                    </div>
                    <span className="hud-chip" data-source-chip>
                      {skill.source}
                    </span>
                    <AgentSwitch
                      name={skill.name}
                      checked={skill.enabled}
                      disabled={writePending}
                      onToggle={() => onToggle(kind, "skill", skill.name, !skill.enabled)}
                    />
                  </div>
                ))}
              </div>
            );
          })
        )}
        {(block?.diagnostics ?? []).length > 0 && (
          <div className="ag-diag">
            <h4 className="ag-diag-label">{t("agents.diagLabel")}</h4>
            {(block?.diagnostics ?? []).map((d, i) => (
              <div className="ag-diag-row" data-diag-row key={`${d.path}:${i}`}>
                <span className="ag-diag-badge">{d.code}</span>
                <span className="ag-diag-msg">{d.message}</span>
                <span className="ag-diag-path" title={d.path}>
                  {d.path}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

const AgentPage = function AgentPage({ path }: { path: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const {
    state: session,
    topology,
    requestModelConfig,
    requestAuthList,
    sendAgentConfigList,
    sendAgentConfigSetEnabled,
    subscribeAgentConfigFrames,
  } = useSession();
  const conn = session.conn;

  const [state, dispatch] = useReducer(agentPageReducer, undefined, createAgentPageState);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** 读面主链：list-started → 发命令；发送失败（未连接）即落 error 态。 */
  const runList = useCallback(() => {
    dispatch({ type: "list-started" });
    if (!sendAgentConfigList()) {
      dispatch({ type: "list-failed", reason: t("agents.notConnected") });
    }
  }, [sendAgentConfigList, t]);

  // 进页拉取：目录面（P-3/P-4 同源请求口）+ auth.list（S3a 可用性过滤
  // 数据源，每次进页刷新——P-3/P-4 同口径）+ 配置读面（mount 一次；
  // StrictMode 双效应去重，重连/changed 广播另走专门 effect）
  const mountedListRef = useRef(false);
  useEffect(() => {
    requestModelConfig();
    requestAuthList();
    if (mountedListRef.current) return;
    mountedListRef.current = true;
    runList();
  }, [requestModelConfig, requestAuthList, runList]);

  /** 最近一次写命令（结果帧无请求回显——skipped 定向清在途用）。 */
  const lastWriteRef = useRef<{ kind: AgentKind; resourceType: WriteResource; name: string } | null>(null);

  // 点对点回执消费（页面私有 reducer；AG-15 不进 session store）
  useEffect(
    () =>
      subscribeAgentConfigFrames((e: EventEnvelope) => {
        if (e.type === "agent.config.list.result") {
          const p = (e as { payload: AgentConfigListResultPayload }).payload;
          dispatch({ type: "list-result", profiles: p.profiles });
        } else if (e.type === "agent.config.set_enabled.result") {
          const p = (e as { payload: { status: string; reason?: string } }).payload;
          if (p.status === "skipped") {
            const w = lastWriteRef.current;
            if (w !== null) dispatch({ type: "toggle-settled", ...w });
            toast.push("err", t("agents.skippedToast", { reason: p.reason ?? "" }));
          }
          // applied：不清在途——等 changed 广播 → 重拉的新鲜数据收口（防闪回）
        }
      }),
    [subscribeAgentConfigFrames, toast, t],
  );

  // changed 广播 → 拓扑 revision 递增 → 失效重拉（多页一致性；跳过首帧）
  const revisionRef = useRef<number | null>(null);
  useEffect(() => {
    const rev = topology.agentConfig.revision;
    if (revisionRef.current === null) {
      revisionRef.current = rev;
      return;
    }
    if (rev !== revisionRef.current) {
      revisionRef.current = rev;
      runList();
    }
  }, [topology.agentConfig.revision, runList]);

  // 重连重拉（断连窗口错过的广播不补发——重连即重读，trace 先例）；
  // mount 期未连接时目录请求会被客户端丢弃——建连后补拉（catalog null 门控幂等）
  const prevConnRef = useRef(conn);
  useEffect(() => {
    const prev = prevConnRef.current;
    prevConnRef.current = conn;
    if (prev !== "connected" && conn === "connected" && mountedListRef.current) {
      requestModelConfig();
      requestAuthList();
      runList();
    }
  }, [conn, runList, requestModelConfig, requestAuthList]);

  /** 写面单飞：pending 非空不再发（结果帧无回显，同刻至多一条在途）。 */
  const onToggle = useCallback(
    (kind: AgentKind, resourceType: WriteResource, name: string, enabled: boolean) => {
      if (stateRef.current.pending.size > 0) return;
      dispatch({ type: "toggle-started", kind, resourceType, name });
      lastWriteRef.current = { kind, resourceType, name };
      sendAgentConfigSetEnabled({ profileKind: kind, resourceType, name, enabled });
    },
    [sendAgentConfigSetEnabled],
  );

  /** 模型槽位：选中 = set（name=模型 id，enabled=true）；缺省项 = clear
   *  （name = 忽略位占位 "-"——契约钉非空，v06 样例同形）。 */
  const onModelChange = useCallback(
    (kind: AgentKind, model: string) => {
      onToggle(kind, "model", model === "" ? "-" : model, model !== "");
    },
    [onToggle],
  );

  const view = selectAgentPageView(state);
  const writePending = state.pending.size > 0;
  const { auth, authLoaded } = topology.modelConfig;
  const catalog = topology.modelConfig.catalog?.models ?? null;

  // S3a AppLayout 组装：headerLeft = 页名（页名进 header 槽固定置顶，
  // 滚动只发生在 layout-main）；main = 原 ag-body 内容（.pg 版心保留；
  // data-agents-page 断言锚挂 main 内容根，语义等价——e2e/单测同步）。
  // 页内 scanline 副本已删（App.tsx 全局单份）。
  return (
    <AppLayout headerLeft={<h1 className="ag-title">{t("agents.title")}</h1>}>
      <div className="pg ag-body" data-agents-page={path}>
        {AGENT_KINDS.map((kind) => (
          <ProfileCard
            key={kind}
            kind={kind}
            block={state.profiles[kind]}
            skeleton={(view === "loading" || view === "idle") && state.profiles[kind] === null}
            catalog={catalog}
            auth={auth}
            authLoaded={authLoaded}
            writePending={writePending}
            onToggle={onToggle}
            onModelChange={onModelChange}
          />
        ))}
        {view === "loading" && (
          <p className="ag-loading" role="status">
            {t("agents.loading")}
          </p>
        )}
        {view === "error" && (
          <div className="ag-error" role="alert">
            <div className="err-icon">
              <TriangleAlert size={20} strokeWidth={1.75} />
            </div>
            <p className="err-t">{t("agents.errorTitle")}</p>
            {state.error !== null && <p className="err-r">{state.error}</p>}
            <button type="button" className="hud-btn hud-btn-danger sm" onClick={runList}>
              <RotateCw size={14} strokeWidth={1.75} />
              {t("agents.retry")}
            </button>
          </div>
        )}
      </div>
    </AppLayout>
  );
};

export default AgentPage;
