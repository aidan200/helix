/**
 * 智能体页（M6 T4；skills 施工牌升格，路由 /skills 不动——URL 稳定，导航名
 * 改「智能体」。S3a 应用壳统一：迁 AppLayout（headerLeft = 页名；main =
 * 详情区），ag-page/ag-head 自建壳与页内 scanline 副本退役（氛围层全局
 * 单份在 App.tsx；滚动只发生在 .layout-main）。
 *
 * agent-roster 批：master-detail 重构（P-1/tasks 同构）——左栏 agent 列表
 * 两组分组（「可配置」= main-session/subagent-worker；「系统派生」=
 * orchestrator/subagent-kg-writer，条目带只读徽标），右栏选中详情。
 * - 可编辑详情：既有能力全保留（模型槽位下拉 + P-2 推理级别 + 工具组 +
 *   技能组 + 扫描诊断）；
 * - 只读详情：纯展示（工具清单无开关；模型位静态「跟随全局默认」；
 *   kg-writer 派生说明「工具集跟随 subagent-worker，额外固定 kg-update」）
 *   ——前端只读只是表现，后端 set_enabled 拒绝（agent.config.read_only）
 *   才是事实；
 * - 状态互斥：loading（列表骨架 + 主区加载位）/ error（主区错误卡 + 重试）/
 *   empty（select-agent null 可达的防御位；默认选中 main-session——brief
 *   ④，常态不达）/ ready 四态恰一渲染；有数据静默重拉不闪骨架。
 *
 * 数据通道（AG-15 页面私有 reducer，trace 先例；T3 遗留②收口）：
 * - 读面：进页/重连/changed 广播（拓扑 agentConfig.revision 递增）→
 *   agent.config.list → list.result（profiles 双块 + system 只读双块）；
 * - 写面：开关/下拉 → agent.config.set_enabled（单飞——结果帧无请求回显，
 *   pending 非空不再发新写）→ applied 等 changed 重拉收口；skipped 回执
 *   toast 呈现原因 + 在途清（态不翻转，daemon 权威）；
 * - 多页一致性：changed 广播 → revision → 重拉（不本地写态）。
 * 状态模型：idle → loading → ready/error 互斥（有数据静默重拉防闪烁）；
 * pending 行集（model 槽位空名键）；selected 选中维（重拉不清——视图态）。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ReactNode } from "react";
import type {
  AgentBasePromptGetResultPayload,
  AgentSkillContentGetResultPayload,
  AgentConfigListResultPayload,
  AgentConfigProfileBlock,
  AgentConfigSystemBlock,
  CatalogModel,
} from "@helix/protocol";
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
  SYSTEM_AGENT_KINDS,
  agentPageReducer,
  createAgentPageState,
  selectAgentPageView,
  type AgentId,
  type AgentKind,
  type AgentWriteResource,
  type SystemAgentKind,
} from "./model/agent-config-model";
import P2ThinkingField from "./ui/P-2-ThinkingField";
import { resolveThinkingCapability } from "@/features/thinking-level/model/thinking-capability";

/** 写面载荷（resourceType 收窄于协议四值，页面只发这四类）。 */
type WriteResource = AgentWriteResource;

/** M49：ProfileCard/SystemProfileCard 共用派生——S3a 可用性过滤后按 provider
 *  分组（P-4 optgroup 形态）+ P-2 推理能力位（F2.2 防腐字段预览）。 */
function useAgentModelSelectors({
  catalog,
  auth,
  authLoaded,
  currentModel,
  capabilityModel,
}: {
  catalog: CatalogModel[] | null;
  auth: Record<string, AuthProviderEntry>;
  authLoaded: boolean;
  /** available 过滤兜底锚（provider 未配置仍保留当前项，防下拉找不到当前项）。 */
  currentModel: string | undefined;
  /** 能力位预览基准（槽位留空 = 跟随全局默认）。 */
  capabilityModel: string;
}) {
  const modelsByProvider = useMemo(() => {
    const visible = filterAvailableModels({
      models: catalog ?? [],
      auth,
      authLoaded,
      currentModel,
      query: "",
    });
    const map = new Map<string, CatalogModel[]>();
    for (const m of visible) {
      const list = map.get(m.providerId);
      if (list) list.push(m);
      else map.set(m.providerId, [m]);
    }
    return map;
  }, [catalog, auth, authLoaded, currentModel]);
  const thinkingCapability = useMemo(
    () => resolveThinkingCapability(capabilityModel, catalog ?? undefined),
    [capabilityModel, catalog],
  );
  return { modelsByProvider, thinkingCapability };
}

/** 列表条目名（左栏行 + 详情头共用；只读组由 kind 分派）。 */
function agentTitleOf(t: (key: string) => string, kind: AgentId): string {
  if (kind === "main-session") return t("agents.mainTitle");
  if (kind === "subagent-worker") return t("agents.subTitle");
  if (kind === "orchestrator") return t("agents.orchestratorTitle");
  if (kind === "subagent-code-reviewer") return t("agents.reviewerTitle");
  return t("agents.kgWriterTitle");
}

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
  defaultModel,
  auth,
  authLoaded,
  writePending,
  onToggle,
  onModelChange,
  basePrompt,
  skillContents,
  skillContentPending,
  skillContentOpen,
  onSkillContentToggle,
}: {
  kind: AgentKind;
  block: AgentConfigProfileBlock | null;
  skeleton: boolean;
  catalog: CatalogModel[] | null;
  defaultModel: string | undefined;
  auth: Record<string, AuthProviderEntry>;
  authLoaded: boolean;
  writePending: boolean;
  onToggle: (kind: AgentKind, resourceType: WriteResource, name: string, enabled: boolean) => void;
  onModelChange: (kind: AgentKind, model: string) => void;
  /** base prompt 批：base 段系统提示词查看区槽位（工具组正上方渲染）。 */
  basePrompt: ReactNode;
  /** skill-content 批：skill 正文缓存（名 → 全文；缺 key = 未拉取）。 */
  skillContents: Readonly<Record<string, string>>;
  /** skill-content 批：正文懒查询在途名集（按钮 loading/防重复发）。 */
  skillContentPending: ReadonlySet<string>;
  /** skill-content 批：展开的技能名（恰一展开）。 */
  skillContentOpen: string | null;
  /** skill-content 批：查看/收起回叫（未缓存先懒查询，已缓存本地开/关）。 */
  onSkillContentToggle: (name: string) => void;
}) {
  const { t } = useI18n();
  const isMain = kind === "main-session";
  const selId = `sel-model-${kind}`;
  /** S3a 可用性口径（与 chat P-3 同一过滤函数、同一数据源）：configured
   * provider join + 当前槽位模型兜底（provider 未配置仍保留，防下拉里
   * 找不到当前项）+ authLoaded=false 不过滤（防骨架期空列表闪烁）；
   * 过滤后按 providerId 分组（组间/组内序沿目录；P-4 optgroup 形态）。
   *  P-2 能力位数据源（F2.2）：槽位选定模型的 CatalogModel 防腐字段；槽位
   *  留空 = 跟随全局默认（本页为全局配置面，展示位以全局默认模型为预览
   *  基准，与 sub spawn 实际模型天然同源）。M49：两卡共用 hook。 */
  const { modelsByProvider, thinkingCapability } = useAgentModelSelectors({
    catalog,
    auth,
    authLoaded,
    currentModel: block?.model ?? undefined,
    capabilityModel: block?.model ?? defaultModel ?? "",
  });

  return (
    <section className="hud-card ag-card" data-agent-card={kind}>
      <header className="ag-card-head">
        <h2 className="ag-card-title">{isMain ? t("agents.mainTitle") : t("agents.subTitle")}</h2>
        <span className="hud-chip" data-kind-chip>
          {kind}
        </span>
      </header>

      {/* 模型槽位：缺省项 = 跟随全局默认（main/sub 同——T12 后 sub 不再跟随会话） */}
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

      {/* P-2 推理级别字段（T2.2；模型槽位正下方、视觉并列）：读写 thinking
          槽位（set = 档位字符串透传；clear = name 忽略位 "-"，model 先例） */}
      <P2ThinkingField
        kind={kind}
        thinkingLevel={block?.thinkingLevel ?? null}
        capability={thinkingCapability}
        disabled={writePending || skeleton}
        onSelect={(level) => onToggle(kind, "thinking", level, true)}
        onClear={() => onToggle(kind, "thinking", "-", false)}
      />

      {/* base prompt 批：base 段系统提示词查看区（工具组正上方） */}
      {basePrompt}

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
          // T5 三源分组：builtin（内置——不可禁用，开关恒禁用态）/ user / project
          (["user", "project", "builtin"] as const).map((source) => {
            const rows = (block?.skills ?? []).filter((s) => s.source === source);
            if (rows.length === 0) return null;
            return (
              <div data-source-group={source} key={source}>
                <div className="ag-src-label">{source === "builtin" ? t("agents.skillSourceBuiltin") : source}</div>
                {rows.map((skill) => (
                  <div data-skill-entry={skill.name} key={skill.filePath}>
                    <div className="ag-row" data-skill-row={skill.name}>
                      <div className="ag-row-main">
                        <span className="ag-name">{skill.name}</span>
                        <span className="ag-desc" title={skill.description}>
                          {skill.description}
                        </span>
                      </div>
                      <span className="hud-chip" data-source-chip>
                        {skill.source}
                      </span>
                      {/* skill-content 批：正文查看入口（ghost 弱化变体，
                          base prompt 查看钮同构；builtin 不可禁用≠不可查看） */}
                      <button
                        type="button"
                        className="hud-btn hud-btn-ghost sm"
                        data-skill-content-toggle={skill.name}
                        disabled={skillContentPending.has(skill.name)}
                        onClick={() => onSkillContentToggle(skill.name)}
                      >
                        {skillContentOpen === skill.name ? t("agents.skillContentHide") : t("agents.skillContentView")}
                      </button>
                      <AgentSwitch
                        name={skill.name}
                        checked={skill.enabled}
                        disabled={source === "builtin" || writePending}
                        onToggle={() => onToggle(kind, "skill", skill.name, !skill.enabled)}
                      />
                    </div>
                    {skillContentOpen === skill.name && (
                      skillContents[skill.name] === undefined ? (
                        <p className="ag-loading" role="status">
                          {t("agents.skillContentLoading")}
                        </p>
                      ) : (
                        <pre className="ag-base-prompt" data-skill-content-text={skill.name}>
                          {skillContents[skill.name]}
                        </pre>
                      )
                    )}
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

/** 系统派生详情卡（agent-roster 批 + R7 系统槽位批）：model/thinking 槽位
 *  可编辑（独立配置，未配跟随全局——不联动 worker）；工具集只读派生；
 *  kg-writer 附派生说明位；恒在工具行带恒在徽标。 */
function SystemProfileCard({
  kind,
  block,
  catalog,
  defaultModel,
  auth,
  authLoaded,
  writePending,
  onToggle,
  onModelChange,
  basePrompt,
  skillContents,
  skillContentPending,
  skillContentOpen,
  onSkillContentToggle,
}: {
  kind: SystemAgentKind;
  block: AgentConfigSystemBlock | null;
  catalog: CatalogModel[] | null;
  defaultModel: string | undefined;
  auth: Record<string, AuthProviderEntry>;
  authLoaded: boolean;
  writePending: boolean;
  onToggle: (kind: AgentKind | SystemAgentKind, resourceType: AgentWriteResource, name: string, enabled: boolean) => void;
  onModelChange: (kind: AgentKind | SystemAgentKind, model: string) => void;
  /** base prompt 批：base 段系统提示词查看区槽位（工具清单正上方渲染）。 */
  basePrompt: ReactNode;
  /** skill-content 批（系统派生块技能读面批接通）：正文缓存/在途/展开与回拨
   *  ——与 ProfileCard 同源（按名缓存跨卡共享）。 */
  skillContents: Readonly<Record<string, string>>;
  skillContentPending: ReadonlySet<string>;
  skillContentOpen: string | null;
  onSkillContentToggle: (name: string) => void;
}) {
  const { t } = useI18n();
  const isKgWriter = kind === "subagent-kg-writer";
  const isReviewer = kind === "subagent-code-reviewer"; // D5 第五 kind：派生自 worker − write/edit
  const selId = `sel-model-${kind}`;
  /** S3a 可用性口径（ProfileCard 同一过滤函数/数据源/兜底链；M49 共用 hook） */
  const effective = block?.model ?? defaultModel ?? "";
  const { modelsByProvider, thinkingCapability } = useAgentModelSelectors({
    catalog,
    auth,
    authLoaded,
    currentModel: effective || undefined,
    capabilityModel: effective,
  });
  return (
    <section className="hud-card ag-card" data-agent-card={kind}>
      <header className="ag-card-head">
        <h2 className="ag-card-title">{agentTitleOf(t, kind)}</h2>
        <span className="hud-chip" data-kind-chip>
          {kind}
        </span>
        {/* R7：工具集只读派生；模型/推理槽位可配 */}
        <span className="hud-badge hud-badge-off" data-ro-badge>
          {t("agents.roToolsBadge")}
        </span>
      </header>

      {/* 模型槽位（R7）：独立配置，缺省项 = 跟随全局默认（不联动 worker） */}
      <div className="ag-model">
        <label className="hud-label" htmlFor={selId}>
          {t("agents.modelLabel")}
        </label>
        <div className="sel-wrap">
          <select
            id={selId}
            className="hud-input"
            value={block?.model ?? ""}
            disabled={catalog === null || writePending}
            onChange={(e) => onModelChange(kind, e.target.value)}
          >
            <option value="">{t("agents.modelFollowGlobal")}</option>
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
        <p className="ag-note" data-ro-note>
          {t("agents.modelNoteSystem")}
        </p>
      </div>

      {/* 推理强度槽位（R7）：与可编辑卡同构（档位透传；clear = "-" 占位） */}
      <P2ThinkingField
        kind={kind}
        thinkingLevel={block?.thinkingLevel ?? null}
        capability={thinkingCapability}
        disabled={writePending}
        onSelect={(level) => onToggle(kind, "thinking", level, true)}
        onClear={() => onToggle(kind, "thinking", "-", false)}
      />

      {/* 派生说明位（kg-writer / reviewer 各有其辞）：工具集跟随 + 恒在/恒摘面 */}
      {isKgWriter && (
        <p className="ag-note" data-derived-note>
          {t("agents.derivedNote")}
        </p>
      )}
      {isReviewer && (
        <p className="ag-note" data-derived-note>
          {t("agents.reviewerDerivedNote")}
        </p>
      )}

      {/* base prompt 批：base 段系统提示词查看区（工具清单正上方） */}
      {basePrompt}

      {/* 工具清单：纯展示（无开关；行 = 名称 + snippet；恒在行带徽标） */}
      <div className="ag-group">
        <h3 className="ag-group-label">{t("agents.toolsLabel")}</h3>
        {block === null ? (
          <div className="ag-skel" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div className="ag-skel-row" key={i}>
                <span className="ag-skel-bar" style={{ width: 96 }} />
                <span className="ag-skel-bar" style={{ width: `${58 - i * 8}%` }} />
              </div>
            ))}
          </div>
        ) : (
          block.tools.map((tool) => {
            const pinned = block.pinnedTools?.includes(tool.name) ?? false;
            return (
              <div className="ag-row ag-ro-row" data-ro-tool-row={tool.name} key={tool.name}>
                <div className="ag-row-main">
                  <span className="ag-name">{tool.name}</span>
                  <span className="ag-desc">{tool.snippet}</span>
                </div>
                {pinned && (
                  <span className="hud-chip" data-pinned-chip>
                    {t("agents.pinnedTag")}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
      {/* 技能清单（系统派生块技能读面批）：纯展示行 + 正文查看——
          orchestrator = 任务 SOP 注册表（kickoff 全文注入的消费面，
          系统提示技能段恒空）；kg-writer/reviewer = worker 生效技能集
          （spawn 快照技能段同源派生）。旧 daemon 未携带 = 空（additive 容忍）。 */}
      <div className="ag-group">
        <h3 className="ag-group-label">{kind === "orchestrator" ? t("agents.systemSkillsLabelOrch") : t("agents.systemSkillsLabelDerived")}</h3>
        {kind === "orchestrator" && <p className="ag-note" data-sop-note>{t("agents.systemSkillsNoteOrch")}</p>}
        {block === null ? (
          <div className="ag-skel" aria-hidden="true">
            {[0, 1].map((i) => (
              <div className="ag-skel-row" key={i}>
                <span className="ag-skel-bar" style={{ width: 120 }} />
                <span className="ag-skel-bar" style={{ width: `${48 - i * 8}%` }} />
              </div>
            ))}
          </div>
        ) : (block.skills ?? []).length === 0 ? (
          <p className="ag-empty-hint">{t("agents.skillsEmpty")}</p>
        ) : (
          (block.skills ?? []).map((skill) => (
            <div data-skill-entry={skill.name} key={skill.filePath}>
              <div className="ag-row ag-ro-row" data-skill-row={skill.name}>
                <div className="ag-row-main">
                  <span className="ag-name">{skill.name}</span>
                  <span className="ag-desc" title={skill.description}>
                    {skill.description}
                  </span>
                </div>
                <span className="hud-chip" data-source-chip>
                  {skill.source === "builtin" ? t("agents.skillSourceBuiltin") : skill.source}
                </span>
                <button
                  type="button"
                  className="hud-btn hud-btn-ghost sm"
                  data-skill-content-toggle={skill.name}
                  disabled={skillContentPending.has(skill.name)}
                  onClick={() => onSkillContentToggle(skill.name)}
                >
                  {skillContentOpen === skill.name ? t("agents.skillContentHide") : t("agents.skillContentView")}
                </button>
              </div>
              {skillContentOpen === skill.name && (
                skillContents[skill.name] === undefined ? (
                  <p className="ag-loading" role="status">
                    {t("agents.skillContentLoading")}
                  </p>
                ) : (
                  <pre className="ag-base-prompt" data-skill-content-text={skill.name}>
                    {skillContents[skill.name]}
                  </pre>
                )
              )}
            </div>
          ))
        )}
      </div>
    </section>
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
              {state.selected === "main-session" || state.selected === "subagent-worker" ? (
                <ProfileCard
                  kind={state.selected}
                  block={state.profiles[state.selected]}
                  skeleton={state.profiles[state.selected] === null}
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
                />
              ) : (
                <SystemProfileCard
                  kind={state.selected}
                  block={state.system[state.selected]}
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
                />
              )}
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
};

export default AgentPage;
