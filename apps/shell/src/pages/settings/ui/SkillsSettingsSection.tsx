/**
 * 设置页「技能」分区（单源管理裁决批）：用户级技能（~/.helix/skills）的唯一
 * 管理面。
 *
 * 定位边界（与智能体页分工，裁决口径）：
 * - 本页 = 用户级技能资源管理面：清单总览（含双 kind 启停位只读展示）+
 *   SKILL.md 正文 Markdown 渲染查看；builtin 层不可管理不展示（智能体页
 *   可见）；project 层（<工作区>/.helix/skills）发现路径已删——技能是
 *   用户级单源事实；
 * - 启停写面留在智能体页（AgentPage kind 维 toggle）——本页零写命令，
 *   启停徽标只读呈现。
 *
 * 数据面：agent.config.list（进分区一次性拉取；SettingsPage 条件渲染切分区
 * 即重挂重拉）→ profiles 双块合并出 user 源技能行（main-session +
 * subagent-worker 同源扫描全集一致，各取 enabled 位）；正文
 * agent.skill_content.get 懒查询（TR-88 同款：按名缓存 + 恰一展开；回执含
 * SKILL.md 全文——frontmatter 剥离后文档语义渲染）。
 *
 * Markdown 渲染：文档语义（remark-gfm 无 breaks——与聊天流
 * MarkdownMessage 的 breaks 语义分野；SKILL.md 是标准 md 文档，单换行
 * 不应转 <br>）；标题/列表/表格/代码块齐备——代码块复用全局 .md-code
 * 卡（组件映射内聚，聊天流 CodeBlock 分叉：消费语义不同，不共享组件）。
 */
import { useEffect, useRef, useState, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentConfigListResultPayload, EventEnvelope } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { FilePlus, Plus } from "lucide-react";

/** 用户级技能合并行（双 kind 启停位）。 */
interface UserSkillRow {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly enabledMain: boolean;
  readonly enabledSub: boolean;
}

/** 剥离 SKILL.md frontmatter（--- 块）：正文 md 渲染只消费文档体。 */
export function stripFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return raw;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return raw;
  return normalized.slice(end + 4).replace(/^\n+/, "");
}

/** agent.config.list.result 双 profile 块 → 用户级技能合并行（按名对齐双 kind 启停位）。 */
export function mergeUserSkillRows(payload: AgentConfigListResultPayload): readonly UserSkillRow[] {
  const collect = (kind: "main-session" | "subagent-worker") => {
    const block = payload.profiles.find((p) => p.profileKind === kind);
    const rows = new Map<string, { description: string; filePath: string; enabled: boolean }>();
    for (const s of block?.skills ?? []) {
      if (s.source === "user" && !rows.has(s.name)) {
        rows.set(s.name, { description: s.description, filePath: s.filePath, enabled: s.enabled });
      }
    }
    return rows;
  };
  const main = collect("main-session");
  const sub = collect("subagent-worker");
  const names = [...new Set([...main.keys(), ...sub.keys()])];
  return names.map((name) => ({
    name,
    description: main.get(name)?.description ?? sub.get(name)?.description ?? "",
    filePath: main.get(name)?.filePath ?? sub.get(name)?.filePath ?? "",
    // 缺省回落 false（保守报禁）：TR-125 user 技能缺省关（显式启用制）——
    // 双 kind 清单不一致边缘态下未启用技能徽标不误报「启用」
    enabledMain: main.get(name)?.enabled ?? false,
    enabledSub: sub.get(name)?.enabled ?? false,
  }));
}

/** 递归提取 React 子树纯文本（代码块语言行与 pre 内容用；MarkdownMessage 同构私有副本）。 */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }
  return "";
}

/** fenced 代码块 → 全局 .md-code 卡（语言标签行 + pre；样式全局已有）。 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children;
  let lang = "";
  let text = "";
  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    lang = /language-([\w-]+)/.exec(child.props.className ?? "")?.[1] ?? "";
    text = extractText(child.props.children);
  } else {
    text = extractText(children);
  }
  return (
    <div className="md-code">
      <div className="c-lang">
        <span>{lang || "text"}</span>
        <span />
      </div>
      <pre>{text}</pre>
    </div>
  );
}

const docComponents: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ children }) => <code className="inline">{children}</code>,
};

/** SKILL.md 文档渲染（gfm 无 breaks；标题/表格样式见 agents.css .ag-skill-doc 段）。 */
function SkillDoc({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="ag-skill-doc" data-skill-doc>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={docComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

const SkillsSettingsSection = function SkillsSettingsSection() {
  const { t } = useI18n();
  const { sendAgentConfigList, sendAgentSkillContentGet, sendAgentSkillCreate, subscribeAgentConfigFrames } = useSession();

  const [skills, setSkills] = useState<readonly UserSkillRow[] | null>(null);
  /** skill 正文缓存（技能名 → 剥离 frontmatter 后的 md 正文；同名跨 kind 同文）。 */
  const [contents, setContents] = useState<Readonly<Record<string, string>>>({});
  /** 正文懒查询在途名集（按钮 loading + 防重复发）。 */
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  /** 恰一展开技能名；null = 全收（视图态）。 */
  const [open, setOpen] = useState<string | null>(null);
  // ── 添加表单（skills 添加批）：两渠道——form = 页面三字段拼 frontmatter / file = 导入 SKILL.md 原文（可编辑）──
  const [formOpen, setFormOpen] = useState(false);
  const [mode, setMode] = useState<"form" | "file">("form");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  /** 内容区：form 模式 = 纯正文；file 模式 = SKILL.md 全文（含 frontmatter，可编辑）。 */
  const [body, setBody] = useState("");
  const [fileName, setFileName] = useState("");
  const [addPending, setAddPending] = useState(false);
  const [formError, setFormError] = useState("");
  /** 正文懒查询失败交代（connection.error 在途收口后行内展示；重开/重试清）。 */
  const [contentError, setContentError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  /** connection.error 单飞门控判据（本组件在途才消费——其他域错误不误清，
   *  trace/workspace 先例；state 镜像 ref 免重订阅）。 */
  const addPendingRef = useRef(false);
  addPendingRef.current = addPending;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  // 进入分区拉取（条件渲染重挂即重拉；启停变更经智能体页操作后切回自然刷新）
  useEffect(() => {
    sendAgentConfigList();
  }, [sendAgentConfigList]);

  // 点对点回执消费：list.result（清单）/ skill_content.get.result（正文缓存）/
  // skill.create.result（创建回执：applied 重拉收口 / skipped 行内错误）/
  // connection.error（协议层失败回执——create/content.get 无结果帧路径，
  // M10 批①：单飞门控清在途 + 行内错误交代）
  useEffect(
    () =>
      subscribeAgentConfigFrames((frame: EventEnvelope) => {
        if (frame.type === "agent.config.list.result") {
          setSkills(mergeUserSkillRows(frame.payload as AgentConfigListResultPayload));
          return;
        }
        if (frame.type === "agent.skill_content.get.result") {
          const { name: skillName, content } = frame.payload as { name: string; content: string };
          setPending((prev) => {
            const next = new Set(prev);
            next.delete(skillName);
            return next;
          });
          setContents((prev) => ({ ...prev, [skillName]: stripFrontmatter(content) }));
          return;
        }
        if (frame.type === "agent.skill.create.result") {
          const payload = frame.payload as { status: string; name?: string; reason?: string };
          setAddPending(false);
          if (payload.status === "applied") {
            // 创建成功：收表单 + 清空 + 重拉清单（扫描现拍即见，无广播）
            setFormOpen(false);
            setName("");
            setDescription("");
            setBody("");
            setFileName("");
            setFormError("");
            setMode("form");
            sendAgentConfigList();
          } else {
            setFormError(t(`chat.settings.skills.createFail.${payload.reason ?? "bad-frontmatter"}`));
          }
          return;
        }
        if (frame.type === "connection.error") {
          // M10 批①：skill.create / skill_content.get 的协议层失败回执（daemon
          // commandError 走 connection.error，无结果帧）——清在途（提交钮/查看钮
          // 不再永久 disabled）+ 行内错误交代；单飞门控：本组件无在途不消费
          const msg = (frame.payload as { message?: string } | undefined)?.message ?? "connection.error";
          if (addPendingRef.current) {
            setAddPending(false);
            setFormError(t("chat.settings.skills.requestFailed", { message: msg }));
          }
          if (pendingRef.current.size > 0) {
            setPending(new Set());
            setContentError(t("chat.settings.skills.requestFailed", { message: msg }));
          }
        }
      }),
    [subscribeAgentConfigFrames, sendAgentConfigList, t],
  );

  /** 查看正文：未缓存 → 懒查询；已缓存 → 直接展开/收起。 */
  const onToggleContent = (name: string): void => {
    setContentError("");
    if (open === name) {
      setOpen(null);
      return;
    }
    setOpen(name);
    if (contents[name] === undefined && !pending.has(name)) {
      setPending((prev) => new Set(prev).add(name));
      sendAgentSkillContentGet({ name });
    }
  };

  /** 导入 SKILL.md 文件：读全文填充内容区（原文可编辑，提交时原样发送）。 */
  const onImportFile = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      setMode("file");
      setFileName(file.name);
      setBody(String(reader.result ?? ""));
      setFormError("");
    };
    // 读取失败行内交代（不静默）
    reader.onerror = () => {
      setFormError(t("chat.settings.skills.importFail"));
    };
    reader.readAsText(file);
  };

  /** 提交创建：form 模式拼 frontmatter；file 模式原文直发（daemon 权威校验）。 */
  const submitCreate = (): void => {
    setFormError("");
    let content: string;
    if (mode === "file") {
      content = body;
    } else {
      const trimmedName = name.trim();
      const trimmedDesc = description.trim();
      if (trimmedName === "" || trimmedDesc === "" || body.trim() === "") {
        setFormError(t("chat.settings.skills.formInvalid"));
        return;
      }
      // yaml 双引号字符串转义（description 单行值安全入 frontmatter）
      const desc = trimmedDesc.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      content = `---\nname: ${trimmedName}\ndescription: "${desc}"\n---\n\n${body}\n`;
    }
    if (content.trim() === "") {
      setFormError(t("chat.settings.skills.formInvalid"));
      return;
    }
    setAddPending(true);
    sendAgentSkillCreate({ content });
  };

  return (
    <div className="pg" data-skills-settings-section>
      <div className="hud-card">
        <div className="set-card-head">
          <h2 className="section-label">{t("chat.settings.skills.title")}</h2>
          <button
            type="button"
            className={cn("hud-btn sm", formOpen ? "hud-btn-ghost" : "hud-btn-cyan")}
            data-skills-add-toggle
            onClick={() => setFormOpen((v) => !v)}
          >
            <Plus size={14} />
            {t("chat.settings.skills.addSkill")}
          </button>
        </div>
        <p className="ag-note">{t("chat.settings.skills.subtitle")}</p>

        {formOpen && (
          <div className="mcp-form" data-skills-form>
            <div className="set-mode-tabs" data-skills-mode>
              {(["form", "file"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={cn("set-mode-tab", mode === m && "on")}
                  data-skills-mode-tab={m}
                  onClick={() => {
                    setMode(m);
                    setFormError("");
                  }}
                >
                  {m === "form" ? t("chat.settings.skills.addModeForm") : t("chat.settings.skills.addModeFile")}
                </button>
              ))}
            </div>

            {mode === "form" ? (
              <>
                <div className="fld">
                  <label className="hud-label" htmlFor="skill-name">
                    {t("chat.settings.skills.fieldName")}
                  </label>
                  <input
                    id="skill-name"
                    className="hud-input"
                    value={name}
                    data-skills-name
                    onChange={(e) => setName(e.target.value)}
                    placeholder="my-skill"
                  />
                </div>
                <div className="fld">
                  <label className="hud-label" htmlFor="skill-desc">
                    {t("chat.settings.skills.fieldDescription")}
                  </label>
                  <input
                    id="skill-desc"
                    className="hud-input"
                    value={description}
                    data-skills-desc
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <div className="fld">
                <label className="hud-label">{t("chat.settings.skills.importLabel")}</label>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".md,.markdown,text/markdown"
                  className="skill-file-input"
                  data-skills-file
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f !== undefined) onImportFile(f);
                  }}
                />
                {fileName !== "" && (
                  <p className="ag-note" data-skills-file-name>
                    {t("chat.settings.skills.importedFile", { name: fileName })}
                  </p>
                )}
              </div>
            )}

            <div className="fld">
              <label className="hud-label" htmlFor="skill-body">
                {mode === "form" ? t("chat.settings.skills.fieldBody") : t("chat.settings.skills.fieldBodyFull")}
              </label>
              <textarea
                id="skill-body"
                className="hud-input skill-body-input"
                value={body}
                data-skills-body
                rows={10}
                spellCheck={false}
                onChange={(e) => setBody(e.target.value)}
                placeholder={
                  mode === "form"
                    ? t("chat.settings.skills.bodyPlaceholder")
                    : t("chat.settings.skills.bodyFullPlaceholder")
                }
              />
            </div>

            <div className="mcp-form-actions">
              <button
                type="button"
                className="hud-btn hud-btn-cyan"
                data-skills-submit
                disabled={addPending}
                onClick={submitCreate}
              >
                <FilePlus size={14} />
                {addPending ? t("chat.settings.skills.adding") : t("chat.settings.skills.addConfirm")}
              </button>
            </div>
            {formError !== "" && (
              <p className="mcp-err" data-skills-form-error>
                {formError}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="hud-card" data-skills-list>
        {skills === null ? (
          <p className="ag-note" data-skills-loading>
            {t("chat.settings.skills.loading")}
          </p>
        ) : skills.length === 0 ? (
          <p className="ag-note" data-skills-empty>
            {t("chat.settings.skills.empty")}
          </p>
        ) : (
          skills.map((skill) => (
            <div data-skill-entry={skill.name} key={skill.filePath}>
              <div className="ag-row" data-skill-row={skill.name}>
                <div className="ag-row-main">
                  <span className="ag-name">{skill.name}</span>
                  <span className="ag-desc" title={skill.description}>
                    {skill.description}
                  </span>
                </div>
                {/* 双 kind 启停位只读徽标（写面在智能体页） */}
                <span
                  className={cn("hud-chip", !skill.enabledMain && "hud-chip-off")}
                  data-skill-state="main-session"
                >
                  {t("chat.settings.skills.kindMain")}·
                  {t(skill.enabledMain ? "chat.settings.skills.enabled" : "chat.settings.skills.disabled")}
                </span>
                <span
                  className={cn("hud-chip", !skill.enabledSub && "hud-chip-off")}
                  data-skill-state="subagent-worker"
                >
                  {t("chat.settings.skills.kindSub")}·
                  {t(skill.enabledSub ? "chat.settings.skills.enabled" : "chat.settings.skills.disabled")}
                </span>
                <button
                  type="button"
                  className="hud-btn hud-btn-ghost sm"
                  data-skill-content-toggle={skill.name}
                  disabled={pending.has(skill.name)}
                  onClick={() => onToggleContent(skill.name)}
                >
                  {open === skill.name
                    ? t("chat.settings.skills.hide")
                    : t("chat.settings.skills.view")}
                </button>
              </div>
              {open === skill.name &&
                (contents[skill.name] === undefined ? (
                  contentError !== "" ? (
                    <p className="mcp-err" role="alert" data-skill-content-error>
                      {contentError}
                    </p>
                  ) : (
                    <p className="ag-loading" role="status">
                      {t("chat.settings.skills.contentLoading")}
                    </p>
                  )
                ) : (
                  <SkillDoc text={contents[skill.name]!} />
                ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default SkillsSettingsSection;
