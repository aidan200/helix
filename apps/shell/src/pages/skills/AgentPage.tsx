/**
 * 智能体页（M6 T4；skills 施工牌升格，路由 /skills 不动——URL 稳定，导航名
 * 改「智能体」。S3a 应用壳统一：迁 AppLayout（headerLeft = 页名；main =
 * 详情区），ag-page/ag-head 自建壳与页内 scanline 副本退役（氛围层全局
 * 单份在 App.tsx；滚动只发生在 .layout-main）。
 *
 * agent-roster 批：master-detail 重构（P-1/tasks 同构）——左栏 agent 列表
 * 两组分组（「可配置」= main-session/subagent-worker 双卡；「系统派生」=
 * 系统三 kind orchestrator/subagent-kg-writer/subagent-code-reviewer，条目
 * 带只读徽标），右栏选中详情。
 * - 可编辑详情：既有能力全保留（模型槽位下拉 + P-2 推理级别 + 工具组 +
 *   技能组 + 扫描诊断）；
 * - 系统派生详情（TR-125 显示同构终态）：五 kind 单卡组件同构渲染——
 *   工具/技能/MCP 开关全渲染置灰（写面只读；daemon set_enabled 拒绝
 *   agent.config.read_only 才是事实面），模型/推理槽位仍可配；系统三
 *   kind 独立装配（各自 kind 装配，工具/技能面不继承 subagent-worker），
 *   kg-writer 固定工具 kg-update 为自身声明面 pinned 徽标；
 * - 状态互斥：loading（列表骨架 + 主区加载位）/ error（主区错误卡 + 重试）/
 *   empty（select-agent null 可达的防御位；默认选中 main-session——brief
 *   ④，常态不达）/ ready 四态恰一渲染；有数据静默重拉不闪骨架。
 *
 * 数据通道（AG-15 页面私有 reducer，trace 先例；T3 遗留②收口）：
 * - 读面：进页/重连/changed 广播（拓扑 agentConfig.revision 递增）→
 *   agent.config.list → list.result（profiles 双块 + system 只读三块）；
 * - 写面：开关/下拉 → agent.config.set_enabled（单飞——结果帧无请求回显，
 *   pending 非空不再发新写）→ applied 等 changed 重拉收口；skipped 回执
 *   toast 呈现原因 + 在途清（态不翻转，daemon 权威）；
 * - 多页一致性：changed 广播 → revision → 重拉（不本地写态）。
 * 状态模型：idle → loading → ready/error 互斥（有数据静默重拉防闪烁）；
 * pending 行集（model 槽位空名键）；selected 选中维（重拉不清——视图态）。
 *
 * 组件拆分：单 kind 配置卡（模型槽位/工具组/MCP 分组/技能组六区块）在
 * ui/ProfileCard.tsx（M10 批③；工具/MCP 行共用 ToolRow），本文件只留
 * 页面编排 + 左栏条目 + base prompt 查看区。
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  AgentBasePromptGetResultPayload,
  AgentSkillContentGetResultPayload,
  AgentConfigListResultPayload,
} from "@helix/protocol";
import { RotateCw, TriangleAlert } from "lucide-react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { cn } from "@/shared/lib/cn";
import AppLayout from "@/widgets/app-layout/ui/AppLayout";
import type { EventEnvelope } from "@helix/protocol";
import {
  AGENT_KINDS,
  SYSTEM_AGENT_KINDS,
  agentPageReducer,
  createAgentPageState,
  selectAgentPageView,
  type AgentId,
  type AgentKind,
  type AgentWriteResource,
  type SystemAgentKind,
} from "./model/agent-config-model";
import ProfileCard, { agentTitleOf } from "./ui/ProfileCard";

/** 写面载荷（resourceType 收窄于协议四值，页面只发这四类）。 */
type WriteResource = AgentWriteResource;

/**
 * base 段系统提示词查看区（base prompt 批）：折叠入口——首次展开懒查询
 * （agent.base_prompt.get 点对点），缓存后本地开/关。说明行明示本面仅
 * 静态 base 段（工具/技能清单为运行期动态拼入，生效全量走 trace 快照）。
 */
function BasePromptSection({
  kind,
  text,
  pending,
  open,
  onToggle,
}: {
  kind: AgentId;
  text: string | null;
  pending: boolean;
  open: boolean;
  onToggle: (kind: AgentId) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="ag-group" data-base-prompt={kind}>
      {/* 头部行：组标签 + ghost 查看钮（trace 页 p1-payload-head 同构——
          次要查看入口走 hud-btn-ghost 弱化变体，按钮钉行右） */}
      <div className="ag-bp-head">
        <h3 className="ag-group-label">{t("agents.basePromptLabel")}</h3>
        <button
          type="button"
          className="hud-btn hud-btn-ghost sm"
          data-base-prompt-toggle
          disabled={pending}
          onClick={() => onToggle(kind)}
        >
          {open ? t("agents.basePromptHide") : t("agents.basePromptView")}
        </button>
      </div>
      {open && (
        <>
          <p className="ag-note">{t("agents.basePromptNote")}</p>
          {text === null ? (
            <p className="ag-loading" role="status">
              {t("agents.basePromptLoading")}
            </p>
          ) : (
            <pre className="ag-base-prompt" data-base-prompt-text>
              {text}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/** 左栏列表条目（可配置/系统派生两组共用；只读组带只读徽标）。 */
function AgentEntry({
  kind,
  title,
  readOnly,
  selected,
  onSelect,
}: {
  kind: AgentId;
  title: string;
  readOnly: boolean;
  selected: boolean;
  onSelect: (id: AgentId) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className={cn("ag-entry", selected && "selected")}
      data-agent-row={kind}
      data-ro={readOnly ? "true" : undefined}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(kind)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(kind);
        }
      }}
    >
      <div className="ag-entry-main">
        <span className="ag-entry-name">{title}</span>
        {readOnly && (
          <span className="hud-badge hud-badge-off" data-ro-badge>
            {t("agents.roBadge")}
          </span>
        )}
      </div>
      <span className="ag-entry-kind">{kind}</span>
    </div>
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
    sendAgentBasePromptGet,
    sendAgentSkillContentGet,
    subscribeAgentConfigFrames,
    subscribeMcpFrames,
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
  const lastWriteRef = useRef<{ kind: AgentKind | SystemAgentKind; resourceType: WriteResource; name: string } | null>(null);

  // 点对点回执消费（页面私有 reducer；AG-15 不进 session store）
  useEffect(
    () =>
      subscribeAgentConfigFrames((e: EventEnvelope) => {
        if (e.type === "agent.config.list.result") {
          const p = (e as { payload: AgentConfigListResultPayload }).payload;
          dispatch({ type: "list-result", profiles: p.profiles, system: p.system });
        } else if (e.type === "agent.config.set_enabled.result") {
          const p = (e as { payload: { status: string; reason?: string } }).payload;
          if (p.status === "skipped") {
            const w = lastWriteRef.current;
            if (w !== null) dispatch({ type: "toggle-settled", ...w });
            toast.push("err", t("agents.skippedToast", { reason: p.reason ?? "" }));
          }
          // applied：不清在途——等 changed 广播 → 重拉的新鲜数据收口（防闪回）
        } else if (e.type === "agent.base_prompt.get.result") {
          // base prompt 批：回执带 profileKind 回显——定向归位缓存
          const p = (e as { payload: AgentBasePromptGetResultPayload }).payload;
          dispatch({ type: "base-prompt-result", kind: p.profileKind, basePrompt: p.basePrompt });
        } else if (e.type === "agent.skill_content.get.result") {
          // skill-content 批：回执带 name 回显——定向归位缓存
          const p = (e as { payload: AgentSkillContentGetResultPayload }).payload;
          dispatch({ type: "skill-content-result", name: p.name, content: p.content });
        } else if (e.type === "connection.error") {
          // F5 批 #2：set_enabled 写面 daemon 失败回执（走 connection.error 而非
          // *.result）——定向清 lastWriteRef 在途 + err toast（单飞门控：非本页
          // 写面在途的 connection.error 不消费，trace/workspace 先例）
          const w = lastWriteRef.current;
          if (w !== null) {
            lastWriteRef.current = null;
            dispatch({ type: "toggle-settled", ...w });
            const msg = (e as { payload?: { message?: string } }).payload?.message ?? "connection.error";
            toast.push("err", t("agents.writeFailToast", { message: msg }));
          }
        }
      }),
    [subscribeAgentConfigFrames, toast, t],
  );

  // MCP server 运行态迁移 → 配置读面重拉（server 级配置面批：设置页增删
  // server / 状态翻转时 agent 页 server 行与工具行自动跟随——消掉「页面
  // 挂载数据定格」的陈旧窗口；静默重拉不降级回 loading）
  useEffect(
    () =>
      subscribeMcpFrames((e: EventEnvelope) => {
        if (e.type === "mcp.status.changed") runList();
      }),
    [subscribeMcpFrames, runList],
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
      // M50：base prompt 在途回执随断连丢失——重连对 pending 且未缓存的
      // kind 重发懒查询（查看钮不再永久 disabled 等死）
      const st = stateRef.current;
      for (const kind of st.basePromptPending) {
        if (st.basePrompts[kind] === null) sendAgentBasePromptGet({ profileKind: kind });
      }
    }
  }, [conn, runList, requestModelConfig, requestAuthList, sendAgentBasePromptGet]);

  /** 写面单飞：pending 非空不再发（结果帧无回显，同刻至多一条在途）。 */
  const onToggle = useCallback(
    (kind: AgentKind | SystemAgentKind, resourceType: WriteResource, name: string, enabled: boolean) => {
      if (stateRef.current.pending.size > 0) return;
      dispatch({ type: "toggle-started", kind, resourceType, name });
      lastWriteRef.current = { kind, resourceType, name };
      if (!sendAgentConfigSetEnabled({ profileKind: kind, resourceType, name, enabled })) {
        // M48：发送失败（未连接）即收口——清在途 + err toast（runList 发送失败先例）
        lastWriteRef.current = null;
        dispatch({ type: "toggle-settled", kind, resourceType, name });
        toast.push("err", t("agents.notConnected"));
      }
    },
    [sendAgentConfigSetEnabled, toast, t],
  );

  /** 模型槽位：选中 = set（name=模型 id，enabled=true）；缺省项 = clear
   *  （name = 忽略位占位 "-"——契约钉非空，v06 样例同形）。 */
  const onModelChange = useCallback(
    (kind: AgentKind | SystemAgentKind, model: string) => {
      onToggle(kind, "model", model === "" ? "-" : model, model !== "");
    },
    [onToggle],
  );

  const onSelectAgent = useCallback((id: AgentId) => {
    dispatch({ type: "select-agent", id });
  }, []);

  /** base prompt 批：折叠开/关——未缓存先懒查询（在途防重复发；send 失败
   *  不开区），已缓存本地开/关（静态数据拉一次常驻）。 */
  const onBasePromptToggle = useCallback(
    (kind: AgentId) => {
      const st = stateRef.current;
      if (st.basePrompts[kind] !== null) {
        dispatch({ type: "base-prompt-toggle", kind });
        return;
      }
      if (st.basePromptPending.has(kind)) return;
      if (sendAgentBasePromptGet({ profileKind: kind })) {
        dispatch({ type: "base-prompt-started", kind });
      }
    },
    [sendAgentBasePromptGet],
  );

  /** skill-content 批：查看区开/关——未缓存先懒查询（在途防重复发；send
   *  失败不开区），已缓存本地开/关（静态数据拉一次常驻）。 */
  const onSkillContentToggle = useCallback(
    (name: string) => {
      const st = stateRef.current;
      if (st.skillContents[name] !== undefined) {
        dispatch({ type: "skill-content-toggle", name });
        return;
      }
      if (st.skillContentPending.has(name)) return;
      if (sendAgentSkillContentGet({ name })) {
        dispatch({ type: "skill-content-started", name });
      }
    },
    [sendAgentSkillContentGet],
  );

  const view = selectAgentPageView(state);
  const writePending = state.pending.size > 0;
  const { auth, authLoaded } = topology.modelConfig;
  const catalog = topology.modelConfig.catalog?.models ?? null;
  const listPending = view === "idle" || view === "loading";

  /** base prompt 批：查看区节点（四 kind 共用）——经 basePrompt 槽传入详情卡，
   *  渲染于工具组正上方（系统派生 kind 同可观察）。 */
  const basePromptSection = state.selected !== null ? (
    <BasePromptSection
      kind={state.selected}
      text={state.basePrompts[state.selected]}
      pending={state.basePromptPending.has(state.selected)}
      open={state.basePromptOpen === state.selected}
      onToggle={onBasePromptToggle}
    />
  ) : null;

  // S3a AppLayout 组装（agent-roster 批 master-detail）：headerLeft = 页名；
  // sidebar = 左栏 agent 列表（两组分组，pj-domain/tk-side 同构 300px）；
  // main = 右栏详情（error/empty/详情三态互斥；滚动只发生在 ag-pane-scroll）。
  return (
    <AppLayout
      headerLeft={<h1 className="ag-title">{t("agents.title")}</h1>}
      sidebar={
        <aside className="ag-side" aria-label={t("agents.title")} data-agents-side>
        <div className="ag-list" data-agents-list>
          {listPending || view === "error" ? (
            <div className="ag-skel" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div className="ag-skel-row" key={i}>
                  <span className="ag-skel-bar" style={{ width: 140 }} />
                  <span className="ag-skel-bar" style={{ width: `${40 - i * 6}%`, height: 8 }} />
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="ag-group-head" data-agent-group="editable">
                {t("agents.groupEditable")}
              </div>
              {AGENT_KINDS.map((kind) => (
                <AgentEntry
                  key={kind}
                  kind={kind}
                  title={agentTitleOf(t, kind)}
                  readOnly={false}
                  selected={state.selected === kind}
                  onSelect={onSelectAgent}
                />
              ))}
              <div className="ag-group-head" data-agent-group="system">
                {t("agents.groupSystem")}
              </div>
              {SYSTEM_AGENT_KINDS.map((kind) => (
                <AgentEntry
                  key={kind}
                  kind={kind}
                  title={agentTitleOf(t, kind)}
                  readOnly
                  selected={state.selected === kind}
                  onSelect={onSelectAgent}
                />
              ))}
            </>
          )}
        </div>
      </aside>
      }
    >
      <div className="ag-main" data-agents-page={path}>
        {view === "error" ? (
          <div className="ag-center">
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
          </div>
        ) : listPending ? (
          <div className="ag-center">
            <p className="ag-loading" role="status">
              {t("agents.loading")}
            </p>
          </div>
        ) : state.selected === null ? (
          <div className="ag-center">
            <div className="ag-center-panel" data-agents-empty>
              <div className="ag-cp-title">{t("agents.noSelectTitle")}</div>
              <div className="ag-cp-sub">{t("agents.noSelectSub")}</div>
            </div>
          </div>
        ) : (
          <div className="ag-pane-scroll">
            <div className="ag-pane-inner">
              <ProfileCard
                kind={state.selected}
                block={
                  state.selected === "main-session" || state.selected === "subagent-worker"
                    ? state.profiles[state.selected]
                    : state.system[state.selected]
                }
                skeleton={(state.selected === "main-session" || state.selected === "subagent-worker"
                  ? state.profiles[state.selected]
                  : state.system[state.selected]) === null}
                catalog={catalog}
                defaultModel={topology.modelConfig.defaultModel}
                auth={auth}
                authLoaded={authLoaded}
                writePending={writePending}
                onToggle={onToggle}
                onModelChange={onModelChange}
                basePrompt={basePromptSection}
                skillContents={state.skillContents}
                skillContentPending={state.skillContentPending}
                skillContentOpen={state.skillContentOpen}
                onSkillContentToggle={onSkillContentToggle}
                readOnly={
                  state.selected === "orchestrator" ||
                  state.selected === "subagent-kg-writer" ||
                  state.selected === "subagent-code-reviewer"
                }
                pinnedTools={
                  state.selected === "subagent-kg-writer"
                    ? state.system["subagent-kg-writer"]?.pinnedTools
                    : undefined
                }
              />
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
};

export default AgentPage;
