/**
 * 智能体页单 kind 配置卡（M10 批③自 AgentPage.tsx 拆出；pages/skills/ui/
 * P-2-ThinkingField 拆分先例同构）：hud-card 载体——模型槽位下拉 + P-2 推理
 * 级别 + base prompt 查看区槽位 + 工具组 + MCP 服务分组 + 技能组 + 扫描
 * 诊断六区块。
 *
 * 共用件：
 * - ToolRow：工具组行与 MCP 组内工具行的共用渲染（M10 批③：两处高度同构
 *   复制退役）——sub 位 = MCP 前缀归属行（ag-row-sub 缩进 + 去前缀显示名
 *   + snippet title 悬浮全文）；pinned 徽标仅工具组行可达（kg-writer 恒在
 *   工具面，行存在即亮，非 toggle 域）；
 * - agentTitleOf：kind → 卡标题/列表条目名（详情头与左栏行共用——AgentPage
 *   侧栏条目同用，此处导出单源）；
 * - useAgentModelSelectors：S3a 可用性过滤 + provider 分组 + P-2 推理能力位
 *   派生（M49 共用 hook 随卡迁出）。
 *
 * 显示同构终态（TR-125）：系统三 kind 经 readOnly 传入——开关全渲染置灰
 * （写面只读，daemon set_enabled 拒绝是事实面），模型/推理槽位仍可配。
 */
import { useMemo, type ReactNode } from "react";
import type {
  AgentConfigProfileBlock,
  AgentConfigSystemBlock,
  CatalogModel,
} from "@helix/protocol";
import { ChevronDown } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { filterAvailableModels } from "@/features/model-switch/model/available-models";
import { resolveThinkingCapability } from "@/features/thinking-level/model/thinking-capability";
import type { AuthProviderEntry } from "@/entities/session/model/state";
import type {
  AgentId,
  AgentKind,
  AgentWriteResource,
  SystemAgentKind,
} from "../model/agent-config-model";
import P2ThinkingField from "./P-2-ThinkingField";

/** 写面载荷（resourceType 收窄于协议四值，页面只发这四类）。 */
type WriteResource = AgentWriteResource;

/** M49：ProfileCard 派生——S3a 可用性过滤后按 provider 分组（P-4 optgroup
 *  形态）+ P-2 推理能力位（F2.2 防腐字段预览）。 */
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
export function agentTitleOf(t: (key: string) => string, kind: AgentId): string {
  if (kind === "main-session") return t("agents.mainTitle");
  if (kind === "subagent-worker") return t("agents.subTitle");
  if (kind === "orchestrator") return t("agents.orchestratorTitle");
  if (kind === "subagent-code-reviewer") return t("agents.reviewerTitle");
  return t("agents.kgWriterTitle");
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

/**
 * 工具行（M10 批③：工具组行 / MCP 组内工具行共用）：
 * - sub = MCP 前缀归属行（ag-row-sub 缩进 + 去前缀显示名 + snippet 悬浮全文）；
 * - pinned = 恒在工具徽标（kg-writer 声明面单源；行存在即亮，非 toggle 域）。
 */
function ToolRow({
  name,
  displayName,
  snippet,
  enabled,
  sub = false,
  pinned = false,
  disabled,
  onToggle,
}: {
  /** 全名（data-tool-row / switch 键控；MCP 行 = `${server}__${tool}` 原名）。 */
  name: string;
  /** 显示名（MCP 行去 `${server}__` 前缀；工具组行 = 全名）。 */
  displayName: string;
  snippet: string;
  enabled: boolean;
  sub?: boolean;
  pinned?: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={cn("ag-row", sub && "ag-row-sub")} data-tool-row={name}>
      <div className="ag-row-main">
        <span className="ag-name">{displayName}</span>
        <span className="ag-desc" {...(sub ? { title: snippet } : {})}>
          {snippet}
        </span>
      </div>
      {pinned && (
        <span className="hud-chip" data-pinned-chip>
          {t("agents.pinnedTag")}
        </span>
      )}
      <AgentSwitch name={name} checked={enabled} disabled={disabled} onToggle={onToggle} />
    </div>
  );
}

/** 单 kind 配置卡（hud-card 载体；模型槽位 + 工具组 + 技能组 + 诊断）。 */
export default function ProfileCard({
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
  readOnly = false,
  pinnedTools,
}: {
  kind: AgentKind | SystemAgentKind;
  block: AgentConfigProfileBlock | AgentConfigSystemBlock | null;
  skeleton: boolean;
  catalog: CatalogModel[] | null;
  defaultModel: string | undefined;
  auth: Record<string, AuthProviderEntry>;
  authLoaded: boolean;
  writePending: boolean;
  onToggle: (kind: AgentKind | SystemAgentKind, resourceType: WriteResource, name: string, enabled: boolean) => void;
  onModelChange: (kind: AgentKind | SystemAgentKind, model: string) => void;
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
  /** 显示同构终态：系统派生 kind 传入——开关全渲染但置灰（写面只读），槽位仍可配。 */
  readOnly?: boolean;
  /** 恒在工具徽标面（kg-writer：声明面单源 kg-update；行存在即亮，非 toggle 域）。 */
  pinnedTools?: readonly string[];
}) {
  const { t } = useI18n();
  const isMain = kind === "main-session";
  const isSystem = kind === "orchestrator" || kind === "subagent-kg-writer" || kind === "subagent-code-reviewer";
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
        <h2 className="ag-card-title">{agentTitleOf(t, kind)}</h2>
        <span className="hud-chip" data-kind-chip>
          {kind}
        </span>
        {/* 显示同构终态：系统派生 kind 只读徽标（开关全可见，置灰不可点） */}
        {readOnly && (
          <span className="hud-badge hud-badge-off" data-ro-badge>
            {t("agents.roToolsBadge")}
          </span>
        )}
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
        <p className="ag-note" data-note={isMain ? "main" : isSystem ? "system" : "sub"}>
          {isMain ? t("agents.modelNoteMain") : isSystem ? t("agents.modelNoteSystem") : t("agents.modelNoteSub")}
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
          (block?.tools ?? []).filter((tool) => !tool.name.includes("__")).map((tool) => (
            <ToolRow
              key={tool.name}
              name={tool.name}
              displayName={tool.name}
              snippet={tool.snippet}
              enabled={tool.enabled}
              pinned={pinnedTools?.includes(tool.name) ?? false}
              disabled={writePending || readOnly}
              onToggle={() => onToggle(kind, "tool", tool.name, !tool.enabled)}
            />
          ))
        )}
      </div>

      {/* MCP 服务分组区（server 级配置面批）：组级开关 = per-kind server 启停
          （resourceType=mcp-server，关闭 ⇒ 整组工具含 discover 不进该 kind
          生效集）；组内工具行 = 平铺 catalog 的 `${server}__` 前缀归属行
          （snippet = registry 发现的 description 透传），逐工具微调 */}
      <div className="ag-group">
        <h3 className="ag-group-label">{t("agents.mcpLabel")}</h3>
        {skeleton ? (
          <div className="ag-skel" aria-hidden="true">
            <div className="ag-skel-row">
              <span className="ag-skel-bar" style={{ width: 110 }} />
              <span className="ag-skel-bar" style={{ width: "42%" }} />
            </div>
          </div>
        ) : (block?.mcpServers ?? []).length === 0 ? (
          <p className="ag-empty-hint" data-mcp-empty>{t("agents.mcpEmpty")}</p>
        ) : (
          (block?.mcpServers ?? []).map((server) => {
            const prefix = `${server.name}__`;
            const serverTools = (block?.tools ?? []).filter((tool) => tool.name.startsWith(prefix));
            return (
              <div data-mcp-server={server.name} key={server.name}>
                <div className="ag-row" data-mcp-server-row={server.name}>
                  <div className="ag-row-main">
                    <span className="ag-name">{server.name}</span>
                    <span className="ag-desc">{t("agents.mcpToolCount", { count: server.toolCount ?? serverTools.length })}</span>
                  </div>
                  <span className={cn("mcp-state", server.state === "running" && "mcp-state-ok", server.state === "error" && "mcp-state-err")} data-mcp-state={server.state}>
                    {t(`agents.mcpState.${server.state}`)}
                  </span>
                  {!server.enabled && (
                    <span className="hud-chip" data-mcp-server-off>
                      {t("agents.mcpOffChip")}
                    </span>
                  )}
                  <AgentSwitch
                    name={server.name}
                    checked={server.enabled}
                    disabled={writePending || readOnly}
                    onToggle={() => onToggle(kind, "mcp-server", server.name, !server.enabled)}
                  />
                </div>
                {serverTools.map((tool) => (
                  <ToolRow
                    key={tool.name}
                    name={tool.name}
                    displayName={tool.name.slice(prefix.length)}
                    snippet={tool.snippet}
                    enabled={tool.enabled}
                    sub
                    disabled={writePending || readOnly}
                    onToggle={() => onToggle(kind, "tool", tool.name, !tool.enabled)}
                  />
                ))}
              </div>
            );
          })
        )}
      </div>

      {/* 技能组：user/builtin 来源分组 + 开关 + 诊断警示 */}
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
          // 双源分组：builtin（内置——不可禁用，开关恒禁用态）/ user；project 层已删（单源管理裁决）
          (["user", "builtin"] as const).map((source) => {
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
                      {skill.audience === "task" && (
                        <span className="hud-chip" data-audience-chip="task" title={t("agents.skillAudienceTaskHint")}>
                          {t("agents.skillAudienceTask")}
                        </span>
                      )}
                      {/* skill-content 批：正文查看入口（ghost 弱化变体，base prompt 查看钮同构） */}
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
                        disabled={writePending || readOnly}
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
        {(block && "diagnostics" in block ? (block.diagnostics ?? []) : []).length > 0 && (
          <div className="ag-diag">
            <h4 className="ag-diag-label">{t("agents.diagLabel")}</h4>
            {(block && "diagnostics" in block ? (block.diagnostics ?? []) : []).map((d, i) => (
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
