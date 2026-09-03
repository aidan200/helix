/**
 * kg 族 mock daemon 读面镜像（F 层 mock mode；T5.4）。
 *
 * 先例 = fake-transport trace.query 自动剧本（T2.2 例外条款）：真实 daemon
 * 恒应答 kg.* 命令（点对点结果帧 / 校验失败 connection.error），故 fake
 * 实例对六命令自动回放确定性场景。数据面 = 原型 P-1-kg-viewer.html MOCK
 * 区逐字段转契约形状（ProjectRow / NodeListRow / detail 聚合 / 四条目
 * report / IndexStatus 四态），AD-16 人类面规范在 mock 数据层同样强制
 * （正文以名字引用；id 仅 refs 结构与 data 属性）。
 *
 * 确定性时基：rebuild 触发的构建进度按真实时间推进（elapsed 决定
 * done/total——O-6 轮询每次拉到当前进度；3200ms 完成），playwright 按
 * 状态断言无需睡眠。confirm 是 mock 内唯一写（翻转 status + 落日志）。
 */
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type {
  EventEnvelope,
  KgCandidatesListDto,
  KgChangeReportDto,
  KgHealthDto,
  KgIndexStatusDto,
  KgNodeDetailDto,
  KgNodeListRow,
  KgProjectRow,
  KgProduceGroupDto,
  KgProduceNodeDto,
} from "@helix/protocol";

const ITER = "iter-20260825-11fo";
const NOW = "2026-08-25T14:32:00.000+08:00";

/** 响应延迟（loading 态触发面；trace 同款量级）。 */
export const KG_MOCK_LATENCY_MS = 60;
/** 构建总时长（elapsed 线性推进；rebuild 触发后 3200ms 达 synced）。 */
const BUILD_DURATION_MS = 3200;

// ── 原型实况采样：13 项目行（docs/.helix/.worktrees/文件项已排除）──

const MOCK_BUILD_TOTALS: Record<string, number> = {
  codegraph: 26, "css-helix-scaffold": 34, "css-java-scaffold": 41, "css-next-scaffold": 37,
  "java-scaffold": 29, new_kimi: 52, "ng-ai": 63, serena: 18, "test-project": 9,
  "test2-project": 11, "web-access": 44,
};

/** 顺放根（首行父目录名即 workspace 徽章派生源：chip = 「workspace · ws」）。 */
const WS_ROOT = "/ws";

function initialProjects(): KgProjectRow[] {
  const rows: KgProjectRow[] = [
    { name: "helix", path: `${WS_ROOT}/helix`, status: "synced", symbolCount: 56, nodeCount: 17, syncedAt: NOW },
    {
      name: "feifei", path: `${WS_ROOT}/feifei`, status: "degraded",
      degradedNote: "符号层有数据 · 知识层源文档缺失或落后，图谱内容可能不完整 · 重新构建以恢复",
      nodeCount: 0,
    },
    { name: "legacy", path: `${WS_ROOT}/legacy`, status: "synced", symbolCount: 43, nodeCount: 0, syncedAt: NOW },
  ];
  for (const name of Object.keys(MOCK_BUILD_TOTALS)) {
    rows.push({ name, path: `${WS_ROOT}/${name}`, status: "absent" });
  }
  // 已建索引在前（按名称），未建索引按名称升序
  return [rows[0]!, rows[1]!, ...rows.slice(2).sort((a, b) => a.name.localeCompare(b.name))];
}

// ── 节点详情（原型 NODES 17 节点转契约形状；body 单段原文）──

function node(o: {
  id: string; kind: "rule" | "entity"; domain: "tech" | "business" | null;
  status: "draft" | "confirmed" | "superseded"; name: string; digest: string; body: string;
  anchors: { symbol?: string; path: string; line?: number; state: "ok" | "dead" | "stale" }[];
  relations: [string, string][];
  supersede?: { history: string[]; current: string };
  log: { date: string; iterationId: string; eventText: string }[];
}): KgNodeDetailDto {
  return {
    id: o.id, name: o.name, kind: o.kind, domain: o.domain, status: o.status, digest: o.digest,
    body: o.body, anchors: o.anchors,
    relations: o.relations.map(([verb, peerId]) => ({ verb, peer: { id: peerId } })) as KgNodeDetailDto["relations"],
    supersede: (o.supersede ?? { history: [], current: o.id }) as unknown as KgNodeDetailDto["supersede"],
    log: o.log,
  };
}

const INITIAL_NODES: KgNodeDetailDto[] = [
  node({ id: "TR-44", kind: "rule", domain: "business", status: "confirmed", name: "报告生成走固定四段模板",
    digest: "每份知识变化报告固定渲染背景、检出、影响、结论四段，段序不可调整。",
    body: "v1 报告体系的产出规范，约束变化报告生成器的渲染结构。与新的段库装配策略存在待裁决冲突。\n- 固定四段：背景、检出、影响、结论\n- 段数与段序不可按条目形态调整",
    anchors: [{ symbol: "renderReport", path: "apps/daemon/src/kg/report.ts", line: 88, state: "ok" }],
    relations: [["约束", "E-13"], ["与草稿冲突", "TR-47"]],
    log: [
      { date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "从 md 体系迁移入库（保号）" },
      { date: "2026-08-01T10:00:00+08:00", iterationId: "iter-20260801-kq7m", eventText: "补充段序不可调约束" },
    ] }),
  node({ id: "TR-45", kind: "rule", domain: "tech", status: "confirmed", name: "样式色值必须引用主题 token",
    digest: "禁止组件内联散落 hex，所有色值从 CSS 变量注册表引用。",
    body: "双主题一致性的根基规则。新增色值必须先进注册表再被引用。\n- 禁止内联 hex 色值\n- 新色先入注册表（tokens.md 对应列）再被组件引用",
    anchors: [{ symbol: "createThemeVars", path: "apps/desk/src/shared/styles/cyber-hud.css", line: 88, state: "ok" }],
    relations: [["约束", "E-11"]],
    log: [{ date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "从 md 体系迁移入库（保号）" }] }),
  node({ id: "TR-46", kind: "rule", domain: "tech", status: "confirmed", name: "动效只允许 transform 与 opacity",
    digest: "所有过渡动画只作用于 transform 与 opacity，禁止布局属性参与动画。",
    body: "性能与 WKWebView 兼容的双重要求，重绘属性在 backdrop-filter 区域有已知问题。\n- 过渡目标限定 transform / opacity\n- 延迟等参数在组件端预计算",
    anchors: [{ symbol: "transitionRule", path: "apps/desk/src/shared/styles/cyber-hud.css", line: 203, state: "ok" }],
    relations: [],
    log: [{ date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "从 md 体系迁移入库（保号）" }] }),
  node({ id: "TR-47", kind: "rule", domain: "business", status: "draft", name: "报告条目必须永远带行动项",
    digest: "每条变化报告条目以固定行动项收尾并列出可选项，无行动项的条目不允许产出。",
    body: "新写入的草稿规则，与既有固定四段模板规则存在冲突，等待人工裁决（见变化报告）。\n- 条目尾部必须有固定行动项\n- 选项必须可执行（重挂 / 废弃 / 排期等）",
    anchors: [{ symbol: "assembleEntry", path: "apps/daemon/src/kg/assemble.ts", line: 54, state: "ok" }],
    relations: [["冲突", "TR-44"], ["出自", "E-14"]],
    log: [{ date: "2026-08-25T09:00:00+08:00", iterationId: ITER, eventText: "草稿写入（段库装配改造伴生规则），待审阅" }] }),
  node({ id: "TR-48", kind: "rule", domain: "tech", status: "confirmed", name: "锚粒度必须符号级",
    digest: "锚必须落到 path#symbol，文件级锚视为过期形态，不再产生新文件级锚。",
    body: "edit 的 oldText 是唯一精确改动信号，只有符号级锚能与之匹配。\n- 新锚一律 path#symbol\n- 存量文件级锚只出不进",
    anchors: [{ symbol: "resolveAnchor", path: "apps/daemon/src/kg/anchors.ts", line: 31, state: "ok" }],
    relations: [["约束", "E-12"]],
    log: [
      { date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "从 md 体系迁移入库（保号）" },
      { date: "2026-08-10T10:00:00+08:00", iterationId: "iter-20260810-vb2c", eventText: "收紧：禁止新增文件级锚" },
    ] }),
  node({ id: "TR-49", kind: "rule", domain: "tech", status: "confirmed", name: "工具同名覆盖必须显式声明",
    digest: "覆盖 pi 工具时必须在注册表声明 replacement，隐式覆盖视为事故。",
    body: "自写工具替换上游工具的治理规则，隐式覆盖会造成行为漂移难以审计。\n- 注册表声明 replacement 字段\n- 未声明的同名覆盖按事故处理",
    anchors: [{ symbol: "registerTools", path: "apps/daemon/src/tools/registry.ts", line: 19, state: "ok" }],
    relations: [],
    log: [{ date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "从 md 体系迁移入库（保号）" }] }),
  node({ id: "TR-50", kind: "rule", domain: "tech", status: "confirmed", name: "双主题改色只改注册表列",
    digest: "主题调整只允许修改注册表中对应主题列的值，派生变量自动跟随。",
    body: "通道同步铁律的落地规则。锚点长期无附着命中，疑似过时（见变化报告）。\n- 改色只改目标主题列\n- 改任何色值必须同步同名通道变量",
    anchors: [{ symbol: "applyTheme", path: "apps/desk/src/theme/apply.ts", line: 41, state: "stale" }],
    relations: [],
    log: [
      { date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "从 md 体系迁移入库（保号）" },
      { date: "2026-08-15T10:00:00+08:00", iterationId: "iter-20260815-t4n0", eventText: "亮色列 V4 定稿同步" },
    ] }),
  node({ id: "TR-51", kind: "rule", domain: "business", status: "confirmed", name: "会话写入必须经 Steer 队列",
    digest: "会话服务的消息写入不允许直连存储，必须经 Steer 队列中转保证幂等。",
    body: "业务核心约束：直连写入会绕过幂等与重放保障。\n- 写入路径：服务 → {{E-9}} → 存储\n- 禁止直连存储写入会话消息",
    anchors: [{ symbol: "enqueueMessage", path: "apps/daemon/src/services/ChatService.ts", line: 288, state: "ok" }],
    relations: [["约束", "E-10"], ["约束", "E-9"]],
    log: [{ date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "从 md 体系迁移入库（保号）" }] }),
  node({ id: "TR-52", kind: "rule", domain: "tech", status: "confirmed", name: "降级状态必须可见",
    digest: "任何 degraded 状态必须在界面露出徽章，不允许静默降级。",
    body: "索引或同步降级时，用户必须能看见，否则变化报告的完整性承诺失效。\n- degraded 必须渲染徽章\n- 不允许吞掉降级错误",
    anchors: [{ symbol: "IndexHealthBadge", path: "apps/web/src/components/IndexHealth.tsx", line: 12, state: "ok" }],
    relations: [["约束", "E-16"]],
    log: [{ date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "从 md 体系迁移入库（保号）" }] }),
  node({ id: "E-9", kind: "entity", domain: "business", status: "confirmed", name: "Steer 消息队列",
    digest: "会话消息的中转中枢，保证幂等与可重放。",
    body: "## 中转语义\n\ndaemon 内部的消息队列实体。会话写入必经它中转后落库。\n\n## 写入约束\n\n- 写入不允许直连存储，必须经队列中转（{{TR-51}}）\n- 中转保证幂等与可重放",
    anchors: [
      { symbol: "injectClosure", path: "apps/daemon/src/services/ChatService.ts", line: 309, state: "dead" },
      { symbol: "publish", path: "libs/steer/src/queue.ts", line: 21, state: "ok" },
    ],
    relations: [["中转", "E-10"]],
    log: [
      { date: "2026-08-25T09:30:00+08:00", iterationId: ITER, eventText: "锚点 injectClosure 失效（方法删除），待人工裁决" },
      { date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "从 md 体系迁移入库（保号）" },
    ] }),
  node({ id: "E-10", kind: "entity", domain: "business", status: "confirmed", name: "会话服务 ChatService",
    digest: "daemon 侧会话生命周期管理，持有消息写入与工具调用编排。",
    body: "会话实体的宿主服务。消息写入路径受 Steer 队列约束。\n- 写入路径受队列约束（{{TR-51}}）",
    anchors: [{ symbol: "ChatService", path: "apps/daemon/src/services/ChatService.ts", line: 1, state: "ok" }],
    relations: [["被中转", "E-9"], ["被约束", "TR-51"]],
    log: [
      { date: "2026-08-25T09:10:00+08:00", iterationId: ITER, eventText: "方法 injectClosure 删除（重构）" },
      { date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "从 md 体系迁移入库（保号）" },
    ] }),
  node({ id: "E-11", kind: "entity", domain: "tech", status: "confirmed", name: "统一 .kg 单库",
    digest: "图与代码符号共库，SoT 下沉数据库后的唯一存储。",
    body: "知识节点与符号层同库共存，空知识层合法（纯符号层）。\n- 新色值管理遵循注册表（{{TR-45}}）",
    anchors: [{ symbol: "openKg", path: "apps/daemon/src/kg/db.ts", line: 9, state: "ok" }],
    relations: [["被导入", "E-12"]],
    log: [{ date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "建库；69 存量节点一次性迁移入库（保号）" }] }),
  node({ id: "E-12", kind: "entity", domain: "tech", status: "confirmed", name: "同步管道",
    digest: "watch 事件驱动的增量抽取，codegraph 产出导入单库。",
    body: "代码层机械索引的唯一通道，符号抽取遵循符号级锚规则。\n- 锚粒度符号级（{{TR-48}}）",
    anchors: [{ symbol: "syncIncremental", path: "apps/daemon/src/kg/sync.ts", line: 44, state: "ok" }],
    relations: [["导入", "E-11"], ["供数", "E-16"]],
    log: [{ date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "管道上线（watch 通道兜底）" }] }),
  node({ id: "E-13", kind: "entity", domain: "business", status: "superseded", name: "变化报告生成器",
    digest: "按迭代聚合代码改动与知识变化的报告产出端（固定四段形态）。",
    body: "已被段库装配策略取代，本体留史可查。\n- 渲染结构受固定四段约束（{{TR-44}}）",
    anchors: [{ symbol: "renderReport", path: "apps/daemon/src/kg/report.ts", line: 88, state: "ok" }],
    relations: [["被取代", "E-14"]],
    supersede: { history: ["E-13"], current: "E-14" },
    log: [
      { date: "2026-08-24T11:00:00+08:00", iterationId: ITER, eventText: "被『报告装配策略』取代（supersede 留史）" },
      { date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "从 md 体系迁移入库（保号）" },
    ] }),
  node({ id: "E-14", kind: "entity", domain: "business", status: "confirmed", name: "报告装配策略",
    digest: "段库加 LLM 装配的报告产出端，硬约束段不可裁剪。",
    body: "取代固定四段生成器。装配灵活性与闭环纪律在这里分界。\n- 硬约束段（summary / findings）不可裁剪\n- 空段省略不占位",
    anchors: [{ symbol: "assembleReport", path: "apps/daemon/src/kg/assemble.ts", line: 12, state: "ok" }],
    relations: [["取代", "E-13"], ["产出", "TR-47"]],
    supersede: { history: ["E-13"], current: "E-14" },
    log: [{ date: "2026-08-24T11:00:00+08:00", iterationId: ITER, eventText: "入库并取代『变化报告生成器』" }] }),
  node({ id: "E-15", kind: "entity", domain: "business", status: "draft", name: "SubAgent 报告文件",
    digest: "闭环报告的落盘文件，三重角色：主线按需读 / 人类审计 / kg 落账原始数据。",
    body: "新入库的草稿实体，等待人工确认其知识形态描述是否准确。\n- 通知与正文分层：一行通知加指针，深入才读",
    anchors: [{ symbol: "writeReport", path: "apps/daemon/src/closure/recorder.ts", line: 37, state: "ok" }],
    relations: [["落账到", "E-11"]],
    log: [{ date: "2026-08-25T09:00:00+08:00", iterationId: ITER, eventText: "草稿写入（closure 通路修复伴生实体），待审阅" }] }),
  node({ id: "E-16", kind: "entity", domain: "tech", status: "confirmed", name: "索引状态信标",
    digest: "单库的同步健康度信号，degraded 时必须暴露在界面。",
    body: "连接同步管道与界面徽章的健康度实体。\n- 降级必须可见（{{TR-52}}）",
    anchors: [{ symbol: "healthOf", path: "apps/daemon/src/kg/sync.ts", line: 120, state: "ok" }],
    relations: [["受供数", "E-12"], ["被约束", "TR-52"]],
    log: [{ date: "2026-08-24T10:00:00+08:00", iterationId: ITER, eventText: "从 md 体系迁移入库（保号）" }] }),
];

/** 四条目变化报告（AD-16：正文以名字叙述；refs 结构化承载跳转）。 */
function initialReport(): KgChangeReportDto {
  return {
    iterationId: ITER,
    entries: [
      { kind: "dead_anchor", sev: "warn", label: "失效锚点",
        body: "你删除了会话服务里的方法 `injectClosure`（apps/daemon/src/services/ChatService.ts:309），它是这条知识在会话服务侧的唯一锚点：『Steer 消息队列』。队列的中转语义失去该侧全部符号附着。",
        refs: { nodes: [{ id: "E-9", name: "Steer 消息队列", kind: "entity", digestFirstLine: "会话消息的中转中枢，保证幂等与可重放。" }], symbols: [{ name: "injectClosure", path: "apps/daemon/src/services/ChatService.ts", line: 309 }] } },
      { kind: "rule_conflict", sev: "warn", label: "规则冲突",
        body: "你把新规则『报告条目必须永远带行动项』写入图谱，它与既有规则『报告生成走固定四段模板』对「条目尾部是否必须带行动项」给出相反指令：一个要求条目自适应装配，一个钉死固定四段。",
        refs: { nodes: [
          { id: "TR-47", name: "报告条目必须永远带行动项", kind: "rule", digestFirstLine: "每条变化报告条目以固定行动项收尾并列出可选项。" },
          { id: "TR-44", name: "报告生成走固定四段模板", kind: "rule", digestFirstLine: "每份知识变化报告固定渲染背景、检出、影响、结论四段。" },
        ], symbols: [] } },
      { kind: "suspect_stale", sev: "info", label: "疑似过时",
        body: "疑似过时（启发式排序，非结论）：规则『双主题改色只改注册表列』的锚 `applyTheme`（apps/desk/src/theme/apply.ts:41）已 42 天无附着命中，其间 3 次相关提交均未触发。",
        refs: { nodes: [{ id: "TR-50", name: "双主题改色只改注册表列", kind: "rule", digestFirstLine: "主题调整只允许修改注册表中对应主题列的值。" }], symbols: [{ name: "applyTheme", path: "apps/desk/src/theme/apply.ts", line: 41 }] } },
      { kind: "knowledge_change", sev: "ok", label: "知识变化",
        body: "本迭代你把报告生成从固定模板改为段库装配：新实体『报告装配策略』入库并取代『变化报告生成器』；伴生规则『报告条目必须永远带行动项』与伴生实体『SubAgent 报告文件』以草稿身份等待审阅。",
        refs: { nodes: [
          { id: "E-14", name: "报告装配策略", kind: "entity", digestFirstLine: "段库加 LLM 装配的报告产出端，硬约束段不可裁剪。" },
          { id: "E-13", name: "变化报告生成器", kind: "entity", digestFirstLine: "按迭代聚合代码改动与知识变化的报告产出端。" },
          { id: "TR-47", name: "报告条目必须永远带行动项", kind: "rule", digestFirstLine: "每条变化报告条目以固定行动项收尾。" },
          { id: "E-15", name: "SubAgent 报告文件", kind: "entity", digestFirstLine: "闭环报告的落盘文件。" },
        ], symbols: [] } },
    ],
  };
}

// ── mock store（连接内可变：confirm 写 + rebuild 时基）──

/** 项目名/路径 → 项目行（单点解析镜像：名称 join workspace 根 / 绝对路径直用）。 */
function resolveProjectName(project: unknown, projects: KgProjectRow[]): KgProjectRow | undefined {
  if (typeof project !== "string" || project === "") return undefined;
  if (project.startsWith("/")) return projects.find((p) => p.path === project);
  return projects.find((p) => p.name === project);
}

// ── bootstrap 产出 mock 数据（T3.2；契约 ProduceNodeDto 形状——AD-4② 人类可读投影）──

const INITIAL_PRODUCE_NODES: KgProduceNodeDto[] = [
  {
    nodeId: "TR-B1",
    name: "连接私有读面不进会话 store",
    kind: "rule",
    status: "confirmed",
    digest: "页面私有数据面（任务/图谱/产出）走连接级听众转发，dispatcher 零写入。\n第二行：完整 digest 在展开态可见。",
    body: "页面私有数据面（任务/图谱/产出）走连接级听众转发，dispatcher 零写入；会话 store 只持会话维状态。kg 族先例即本形态。",
    anchors: [
      { symbol: "kgListenersRef", path: "apps/shell/src/entities/session/SessionContext.tsx", line: 306 },
      { symbol: "subscribeKgFrames", path: "apps/shell/src/entities/session/SessionContext.tsx", line: 646 },
    ],
    rationale: "会话 store 与页面读面解耦，避免任务/图谱帧污染会话快照。",
    origin: { taskTitle: "helix 知识图谱创建", batchScope: "批次：架构基线与全局规范" },
  },
  {
    nodeId: "E-B2",
    name: "知识图谱查看器",
    kind: "entity",
    status: "confirmed",
    digest: "graph 态单页 master-detail 组件：左列节点列表 + 右区详情/报告/产出三 tab。",
    body: "graph 态单页 master-detail 组件：左列节点列表（三路过滤）+ 右区节点详情/变化报告/产出呈现三 tab；每次进入 graph 由 kgToken 强制重挂。",
    anchors: [{ symbol: "KgViewer", path: "apps/shell/src/pages/P-1/kg-viewer.tsx", line: 44 }],
    rationale: "V-3 单页裁决：/project 唯一路由页，图谱为组件非路由。",
    origin: { taskTitle: "helix 知识图谱创建", batchScope: "批次：会话域" },
  },
  {
    nodeId: "E-B3",
    name: "bootstrap 产出呈现区",
    kind: "entity",
    status: "confirmed",
    digest: "KgViewer 第三 tab：三级分组呈现 + 事后修正（update/supersede）+ 连带标记。",
    body: "产出按 任务→阶段→批次 分组，节点条目展开四段（正文/锚点/为什么存在/来源）；修正走 kg.node.update / supersede，连带走 impact 只读推导。",
    anchors: [{ symbol: "KgProducePane", path: "apps/shell/src/pages/P-1/ui/kg-produce-pane.tsx", line: 1 }],
    rationale: "CL-4 产出呈现与事后修正的宿主面（V-1：无 draft 无转正）。",
    origin: { taskTitle: "helix 知识图谱创建", batchScope: "批次：会话域" },
  },
  {
    nodeId: "E-B4",
    name: "kg 写面单事务入口",
    kind: "entity",
    status: "confirmed",
    digest: "知识层全部写操作经 KgWriteService.write 单 op 单事务进入，五 op 联合校验后落盘。",
    body: "知识层全部写操作经 KgWriteService.write 单 op 单事务进入：五 op（upsert/supersede/edge/log/rebuild）联合校验后一次事务落盘，任何一步失败整体回滚。",
    anchors: [
      { symbol: "KgWriteService.write", path: "apps/daemon/src/services/kg/KgWriteService.ts", line: 88 },
      // 契约 KgProduceNodeDto anchors[].line: number|null 变体采样（D-3）：
      // 无法定位行号时 null（索引降级 → 锚点精度降为路径级）——渲染形态 = 仅路径无 :行号
      { symbol: "kgWriteTransaction", path: "apps/daemon/src/services/kg/KgWriteService.ts", line: null },
    ],
    rationale: "写面唯一入口防止多路径写导致的图谱不一致；单事务保证落盘原子性。",
    origin: { taskTitle: "helix 知识图谱创建", batchScope: "批次：实体与契约锚定" },
  },
];

export class KgMockStore {
  private projects: KgProjectRow[] = initialProjects();
  private nodes: KgNodeDetailDto[] = structuredClone(INITIAL_NODES);
  private report: KgChangeReportDto = initialReport();
  /** rebuild 时基（project → startedAt）。 */
  private buildingSince = new Map<string, number>();
  /** bootstrap 产出节点（T3.2 mock；update/supersede 可变镜像）。 */
  private produceNodes = new Map<string, KgProduceNodeDto>(
    INITIAL_PRODUCE_NODES.map((n) => [n.nodeId, structuredClone(n)]),
  );
  /** 产出节点引用边（impact 推导数据源：target → 引用方 source 集）。 */
  private produceEdges = new Map<string, string[]>([["E-B2", ["E-B3"]]]);
  /** bootstrap job 序号（create 计数）。 */
  private jobSeq = 1;

  /** kg 命令应答（契约镜像；错误走 connection.error 点对点回执）。 */
  reply(type: string, payload: unknown): EventEnvelope {
    const p = (payload ?? {}) as Record<string, unknown>;
    switch (type) {
      case "kg.projects":
        return this.frame("kg.projects.result", { projects: this.projectsRows() });
      case "kg.list":
        return this.replyList(p);
      case "kg.node.detail": {
        const row = resolveProjectName(p.project, this.projects);
        if (row === undefined) return this.paramError();
        const n = this.nodes.find((x) => x.id === p.id);
        if (n === undefined) return this.errorFrame("KG_E_NOT_FOUND", `节点 ${String(p.id)} 不存在`);
        return this.frame("kg.node.detail.result", this.materialize(n));
      }
      case "kg.change.report": {
        const row = resolveProjectName(p.project, this.projects);
        if (row === undefined) return this.paramError();
        return this.frame("kg.change.report.result", this.report);
      }
      case "kg.node.confirm": {
        const row = resolveProjectName(p.project, this.projects);
        if (row === undefined) return this.paramError();
        const n = this.nodes.find((x) => x.id === p.id);
        if (n === undefined) return this.errorFrame("KG_E_NOT_FOUND", `节点 ${String(p.id)} 不存在`);
        if (n.status !== "draft") return this.errorFrame("KG_E_STATE", "仅草稿节点可转正");
        n.status = "confirmed";
        n.log = [{ date: new Date().toISOString(), iterationId: ITER, eventText: "草稿转正（页面人工确认）" }, ...n.log];
        return this.frame("kg.node.confirm.result", { applied: true, node: this.listRow(n) });
      }
      case "kg.index.status":
        return this.replyIndex(p);
      // ── kg-bootstrap 批五命令（T3.2；契约 kg-bootstrap-api.md 镜像）──
      case "kg.bootstrap.create":
        return this.replyBootstrapCreate(p);
      case "kg.bootstrap.produce":
        return this.replyBootstrapProduce(p);
      case "kg.node.update":
        return this.replyNodeUpdate(p);
      case "kg.node.supersede":
        return this.replyNodeSupersede(p);
      case "kg.bootstrap.impact":
        return this.replyBootstrapImpact(p);
      // ── kg 维护批两命令（C1；PROTOCOL.md §22 镜像）──
      case "kg.graph.purge":
        return this.replyGraphPurge(p);
      case "kg.index.delete":
        return this.replyIndexDelete(p);
      // ── 体检/台账/评审发起批四命令（M39；W2-E/W2-F/code-review v1.5 镜像）──
      case "kg.health":
        return this.replyHealth(p);
      case "kg.candidates.list":
        return this.replyCandidatesList(p);
      case "kg.review.create": {
        const row = resolveProjectName(p.project, this.projects);
        if (row === undefined) return this.paramError();
        if (row.status === "absent")
          return this.errorFrame("kg.review.not_eligible", "index_absent：项目尚未构建索引（先完成一次机械构建）");
        this.jobSeq += 1;
        return this.frame("kg.review.create.result", { ok: true, jobId: `job-review-mock-${this.jobSeq}` });
      }
      case "code.review.create": {
        const row = resolveProjectName(p.project, this.projects);
        if (row === undefined) return this.paramError();
        this.jobSeq += 1;
        return this.frame("code.review.create.result", { ok: true, jobId: `job-code-review-mock-${this.jobSeq}` });
      }
      default:
        return this.errorFrame("command.invalid_payload", `未知命令 ${type}`);
    }
  }

  /** kg.bootstrap.create：准入复核镜像（synced/degraded ∧ nodeCount==0）→ ok。 */
  private replyBootstrapCreate(p: Record<string, unknown>): EventEnvelope {
    const row = resolveProjectName(p.project, this.projects);
    if (row === undefined) return this.paramError();
    if (row.status === "absent")
      return this.errorFrame("kg.bootstrap.not_eligible", "index_absent：项目尚未构建索引（先完成一次机械构建，B1 冷启动链）");
    if (row.status === "building")
      return this.errorFrame("kg.bootstrap.not_eligible", "index_building：索引构建进行中，完成后可发起");
    if ((row.nodeCount ?? 1) !== 0)
      return this.errorFrame("kg.bootstrap.not_eligible", "knowledge_not_empty：知识层非空（bootstrap 只为有代码积累、无图谱的老项目补图谱）");
    this.jobSeq += 1;
    return this.frame("kg.bootstrap.create.result", { ok: true, jobId: `job-mock-${this.jobSeq}` });
  }

  /** kg.bootstrap.produce：helix 项目回内置三级分组；其余空 groups。 */
  private replyBootstrapProduce(p: Record<string, unknown>): EventEnvelope {
    const row = resolveProjectName(p.project, this.projects);
    if (row === undefined) return this.paramError();
    if (row.name !== "helix") return this.frame("kg.bootstrap.produce.result", { groups: [] });
    const groups: KgProduceGroupDto[] = [
      {
        jobId: "job-mock-1",
        title: "helix 知识图谱创建",
        stages: [
          {
            layer: "L0",
            name: "L0 核心层",
            batches: [{ batchId: "b-mock-1", scope: "批次：架构基线与全局规范", nodes: [this.produceNodes.get("TR-B1")!] }],
          },
          {
            layer: "L1",
            name: "L1 领域层",
            batches: [
              {
                batchId: "b-mock-2",
                scope: "批次：会话域",
                nodes: [this.produceNodes.get("E-B2")!, this.produceNodes.get("E-B3")!],
              },
            ],
          },
          // 契约 layer 三值枚举 L2 变体采样（D-3；L2 实体层分组渲染面）
          {
            layer: "L2",
            name: "L2 实体层",
            batches: [
              {
                batchId: "b-mock-3",
                scope: "批次：实体与契约锚定",
                nodes: [this.produceNodes.get("E-B4")!],
              },
            ],
          },
        ],
      },
    ];
    return this.frame("kg.bootstrap.produce.result", { groups });
  }

  /** kg.node.update：digest/body 至少其一 → 原位改（保持 confirmed）。 */
  private replyNodeUpdate(p: Record<string, unknown>): EventEnvelope {
    const row = resolveProjectName(p.project, this.projects);
    if (row === undefined) return this.paramError();
    const n = this.produceNodes.get(String(p.nodeId ?? ""));
    if (n === undefined) return this.errorFrame("kg.node.not_found", `节点 ${String(p.nodeId)} 不存在`);
    const digest = typeof p.digest === "string" ? p.digest : undefined;
    const body = typeof p.body === "string" ? p.body : undefined;
    if ((digest === undefined || digest === "") && (body === undefined || body === ""))
      return this.errorFrame("task.validation_failed", "空更新：digest 与 body 至少携带其一");
    if (digest !== undefined && digest !== "") n.digest = digest;
    if (body !== undefined && body !== "") n.body = body;
    return this.frame("kg.node.update.result", { ok: true, node: { ...n } });
  }

  /** kg.node.supersede：理由必填 → 留史降档。 */
  private replyNodeSupersede(p: Record<string, unknown>): EventEnvelope {
    const row = resolveProjectName(p.project, this.projects);
    if (row === undefined) return this.paramError();
    const n = this.produceNodes.get(String(p.nodeId ?? ""));
    if (n === undefined) return this.errorFrame("kg.node.not_found", `节点 ${String(p.nodeId)} 不存在`);
    const reason = typeof p.reason === "string" ? p.reason.trim() : "";
    if (reason === "") return this.errorFrame("task.validation_failed", "supersede 需要填写理由");
    n.status = "superseded";
    n.supersedeReason = reason;
    return this.frame("kg.node.supersede.result", { ok: true });
  }

  /** kg.bootstrap.impact：内置引用边推导（E-B3 → E-B2；superseded 引用方排除）。 */
  private replyBootstrapImpact(p: Record<string, unknown>): EventEnvelope {
    const row = resolveProjectName(p.project, this.projects);
    if (row === undefined) return this.paramError();
    const target = String(p.nodeId ?? "");
    const affected = [...this.produceEdges.get(target)?.map((id) => this.produceNodes.get(id)) ?? []]
      .filter((n): n is KgProduceNodeDto => n !== undefined && n.status !== "superseded")
      .map((n) => ({
        nodeId: n.nodeId,
        name: n.name,
        kind: n.kind,
        digestFirstLine: (n.digest.split("\n")[0] ?? n.digest).trim(),
      }));
    return this.frame("kg.bootstrap.impact.result", { affected, count: affected.length });
  }

  /** kg.graph.purge：清空 mock 图谱镜像（节点/报告/产出清零 + 索引态复位 absent）。 */
  private replyGraphPurge(p: Record<string, unknown>): EventEnvelope {
    const row = resolveProjectName(p.project, this.projects);
    if (row === undefined) return this.paramError();
    const nodesRemoved = this.nodes.length;
    const symbolsRemoved = row.symbolCount ?? 0;
    this.nodes = [];
    this.report = { iterationId: ITER, entries: [] };
    this.produceNodes.clear();
    this.produceEdges.clear();
    Object.assign(row, { status: "absent" as const, symbolCount: undefined, nodeCount: undefined, syncedAt: undefined, degradedNote: undefined });
    return this.frame("kg.graph.purge.result", { purged: true, nodesRemoved, symbolsRemoved, filesRemoved: symbolsRemoved > 0 ? 1 : 0 });
  }

  /** kg.index.delete：删索引镜像（状态复位 absent；知识节点保留——职责分层）。 */
  private replyIndexDelete(p: Record<string, unknown>): EventEnvelope {
    const row = resolveProjectName(p.project, this.projects);
    if (row === undefined) return this.paramError();
    Object.assign(row, { status: "absent" as const, symbolCount: undefined, syncedAt: undefined, degradedNote: undefined });
    return this.frame("kg.index.delete.result", { deleted: true, state: "absent", watcherStopped: true });
  }

  /** 在途构建推进（elapsed → done/total；完成即 synced）。 */
  private advanceBuilds(): void {
    for (const [name, startedAt] of this.buildingSince) {
      const row = this.projects.find((p) => p.name === name);
      if (row === undefined) {
        this.buildingSince.delete(name);
        continue;
      }
      const total = MOCK_BUILD_TOTALS[name] ?? 28;
      const elapsed = Date.now() - startedAt;
      if (elapsed >= BUILD_DURATION_MS) {
        this.buildingSince.delete(name);
        Object.assign(row, { status: "synced" as const, symbolCount: total, nodeCount: 0, syncedAt: new Date().toISOString(), degradedNote: undefined });
      } else {
        row.status = "building";
      }
    }
  }

  private projectsRows(): KgProjectRow[] {
    this.advanceBuilds();
    return this.projects.map((p) => ({ ...p }));
  }

  private replyList(p: Record<string, unknown>): EventEnvelope {
    const row = resolveProjectName(p.project, this.projects);
    if (row === undefined) return this.paramError();
    const q = typeof p.q === "string" ? p.q.toLowerCase() : "";
    const kind = typeof p.kind === "string" ? p.kind : "";
    const status = typeof p.status === "string" ? p.status : "";
    const all = this.nodes.map((n) => this.listRow(n));
    const matched = all.filter((n) => {
      if (kind !== "" && n.kind !== kind) return false;
      if (status !== "" && n.status !== status) return false;
      if (q !== "" && !n.name.toLowerCase().includes(q) && !n.digest.toLowerCase().includes(q)) return false;
      return true;
    });
    return this.frame("kg.list.result", { total: all.length, matched: matched.length, nodes: matched });
  }

  private replyIndex(p: Record<string, unknown>): EventEnvelope {
    const row = resolveProjectName(p.project, this.projects);
    if (row === undefined) return this.paramError();
    if (p.rebuild === true) {
      if (row.status === "absent" || row.status === "degraded") {
        row.status = "building";
        this.buildingSince.set(row.name, Date.now());
      }
    }
    this.advanceBuilds();
    return this.frame("kg.index.status.result", this.indexDto(row));
  }

  /** 行 → 索引状态 DTO（replyIndex 与 kg.health 复用）。 */
  private indexDto(row: KgProjectRow): KgIndexStatusDto {
    return row.status === "synced"
      ? { state: "synced", symbolCount: row.symbolCount, syncedAt: row.syncedAt }
      : row.status === "degraded"
        ? { state: "degraded", degradedNote: row.degradedNote }
        : row.status === "building"
          ? { state: "building", progress: { done: this.buildDone(row.name), total: MOCK_BUILD_TOTALS[row.name] ?? 28 } }
          : { state: "absent" };
  }

  /** kg.health：空态体检镜像（conflicts/orphans 空集 + 索引状态复用 + 台账四态零计）。 */
  private replyHealth(p: Record<string, unknown>): EventEnvelope {
    const row = resolveProjectName(p.project, this.projects);
    if (row === undefined) return this.paramError();
    this.advanceBuilds();
    const dto: KgHealthDto = {
      conflicts: [],
      orphans: [],
      orphanCount: 0,
      index: this.indexDto(row),
      candidates: { pending: 0, deferred: 0, applied: 0, discarded: 0 },
    };
    return this.frame("kg.health.result", dto);
  }

  /** kg.candidates.list：空态台账镜像（unbound = 空集非报错）。 */
  private replyCandidatesList(p: Record<string, unknown>): EventEnvelope {
    const row = resolveProjectName(p.project, this.projects);
    if (row === undefined) return this.paramError();
    const dto: KgCandidatesListDto = { total: 0, rows: [] };
    return this.frame("kg.candidates.list.result", dto);
  }

  private buildDone(name: string): number {
    const startedAt = this.buildingSince.get(name);
    const total = MOCK_BUILD_TOTALS[name] ?? 28;
    if (startedAt === undefined) return 0;
    return Math.min(total, Math.floor(((Date.now() - startedAt) / BUILD_DURATION_MS) * total));
  }

  /** 详情物化（relations/supersede 的 peer 引用补 name/kind——AD-16）。 */
  private materialize(n: KgNodeDetailDto): KgNodeDetailDto {
    const digestOf = (id: string): { name: string; kind: "rule" | "entity"; digestFirstLine: string } => {
      const peer = this.nodes.find((x) => x.id === id);
      return peer === undefined
        ? { name: "已删除节点", kind: n.kind, digestFirstLine: "" }
        : { name: peer.name, kind: peer.kind, digestFirstLine: peer.digest.split("。")[0] + "。" };
    };
    const sup = n.supersede as unknown as { history: string[]; current: string };
    return {
      ...n,
      relations: (n.relations as unknown as { verb: string; peer: { id: string } }[]).map((r) => ({
        verb: r.verb,
        peer: { id: r.peer.id, ...digestOf(r.peer.id) },
      })),
      supersede: {
        history: sup.history.map((id) => ({ id, ...digestOf(id) })),
        current: { id: sup.current, ...digestOf(sup.current) },
      },
    };
  }

  private listRow(n: KgNodeDetailDto): KgNodeListRow {
    return { id: n.id, name: n.name, kind: n.kind, domain: n.domain, status: n.status, digest: n.digest };
  }

  private frame(type: string, payload: unknown): EventEnvelope {
    return { v: PROTOCOL_VERSION, type, sessionId: SYSTEM_SESSION_ID, channel: "kg", payload } as EventEnvelope;
  }

  private paramError(): EventEnvelope {
    return this.errorFrame("KG_E_PARAM", "project 缺失或无法解析");
  }

  private errorFrame(code: string, message: string): EventEnvelope {
    return {
      v: PROTOCOL_VERSION, type: "connection.error", sessionId: SYSTEM_SESSION_ID, channel: "notification",
      payload: { code, message },
    } as EventEnvelope;
  }
}

/** 模块级单例（同页多连接共享 mock 状态——confirm 写与构建时基跨连接可见）。 */
export const kgMockStore = new KgMockStore();

/** kg 族命令判定（fake-transport send 钩子用）。 */
export function isKgCommand(type: string): boolean {
  return (
    type === "kg.projects" || type === "kg.list" || type === "kg.node.detail" ||
    type === "kg.change.report" || type === "kg.node.confirm" || type === "kg.index.status" ||
    // kg-bootstrap 批五命令（T3.2；mock daemon 镜像同轨）
    type === "kg.bootstrap.create" || type === "kg.bootstrap.produce" ||
    type === "kg.node.update" || type === "kg.node.supersede" || type === "kg.bootstrap.impact" ||
    // kg 维护批两命令（C1；mock daemon 镜像同轨）
    type === "kg.graph.purge" || type === "kg.index.delete" ||
    // 体检/台账/评审发起批四命令（M39；mock daemon 镜像同轨）
    type === "kg.health" || type === "kg.candidates.list" ||
    type === "kg.review.create" || type === "code.review.create"
  );
}
