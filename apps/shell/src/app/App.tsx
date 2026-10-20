/**
 * app 入口组装（FSD 顶层）：providers（主题/i18n/Toast/会话/workspace
 * 门禁）× 门禁分支（W3：phase !== main 全屏占位，主壳不渲染即无
 * kg/session 消费者——结构保证 gate 态零提权请求）× 应用壳
 * （IconRail 常驻导航 + 页面域路由位——路由清单以 ./route 的 AppRoute 联合为单源）。
 *
 * 会话连接在 SessionProvider 挂载时自动启动（连接状态机见 shared/api）；
 * workspace 门禁（W3）在 SessionProvider 之内、主壳之外：连接就绪自动
 * workspace.get → bound（phase=main）渲染主壳（零改动）/ null（gate）
 * 渲染选择页 / 判定前（connecting）终端风连接屏（W6b：与静态启动屏
 * 同类族；W6o 升格双形态开场：首启 hold 显完整 16 行序列，重连 status
 * 形态）——门禁是前端状态，
 * 不是壳职责（TR-AD-4）。路由层在 Provider 之内——工作台常驻 DOM
 * （display 切换保状态，F(4.4).2），路由切换不重建 WS/不丢活跃会话与输入。
 * IconRail 为页面域纯展示组件（不读会话 store，TR-AD-8 页面域/会话域
 * 分离；主题态由本层 useTheme 注入，S1）；S2：models 独立页退役（模型
 * 配置迁入设置页分区）；skills 位已升格为智能体页（M6 T4，
 * 路由 /skills 不动），trace 实页，project 为 P-1 单页 master-detail 实页
 * （V-3：项目域+知识图谱查看）。scanline 氛围层全局单份（S1 上提）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, FolderKanban, Layers, ListTodo, MessageSquare, Settings } from "lucide-react";
import { I18nProvider, useI18n } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider, useToast } from "@/shared/ui/Toast";
import { subscribeOpenSettings } from "@/shared/lib/open-settings-signal";
import { subscribeOpenSteward } from "@/shared/lib/steward-open-signal";
import { requestSettingsSection, type ModelsTab } from "@/pages/settings/settings-section-bus";
import { SessionProvider } from "@/entities/session/SessionContext";
import { useSession } from "@/entities/session/SessionContext";
import { WorkspaceProvider, useWorkspace } from "@/entities/workspace/WorkspaceContext";
import ChatPage from "@/pages/chat/ChatPage";
import AgentPage from "@/pages/skills/AgentPage";
import TracePage from "@/pages/trace/TracePage";
import ProjectPage from "@/pages/P-1/ProjectPage";
import TasksPage from "@/pages/tasks/ui/TasksPage";
import SettingsPage from "@/pages/settings/SettingsPage";
import WorkspaceGatePage from "@/pages/workspace/WorkspaceGatePage";
import WorkspaceBootScreen from "@/pages/workspace/WorkspaceBootScreen";
import IconRail, { type IconRailItem } from "@/widgets/nav-rail/ui/IconRail";
import { useTheme } from "@/shared/ui/theme";
import {
  ROUTE_PROJECT,
  ROUTE_SETTINGS,
  ROUTE_SKILLS,
  ROUTE_STEWARD_MEMORY,
  ROUTE_STEWARD_ACTIVITY,
  ROUTE_TASKS,
  ROUTE_TRACE,
  ROUTE_WORKBENCH,
  type AppRoute,
} from "./route";
import { useAppRoute } from "./useAppRoute";
import TaskSyncHintToast from "./TaskSyncHintToast";
import CoordNoticeToast from "./CoordNoticeToast";
import StewardNotifyToast from "./StewardNotifyToast";
import { useVoiceBroadcast } from "@/features/voice/model/useVoiceBroadcast";
import StewardDock from "@/features/steward/ui/StewardDock";
import ConfirmStack from "@/features/steward/ui/ConfirmStack";
import StewardVoiceLayer from "@/features/steward/ui/StewardVoiceLayer";
import StewardMemoryPage from "@/pages/steward-memory/StewardMemoryPage";
import StewardActivityPage from "@/pages/steward-activity/StewardActivityPage";
import { useStewardNavigate } from "@/features/steward/model/useStewardNavigate";
import { useShellSurface } from "@/features/surface/model/useShellSurface";

/**
 * 设置页「模型分区」tab 白名单（shared 信号 → pages 类型的收敛闸）。
 *
 * Record<ModelsTab, true> 形态让「联合新增 tab 忘了接线」变成编译错误：
 * 手写 `tab === "x" || ...` 串联漏项只会静默丢弃（classifier 曾漏一版）。
 */
const MODELS_TAB_SET: Record<ModelsTab, true> = {
  chat: true,
  embedding: true,
  classifier: true,
  provider: true,
};

/** shared 信号宽 string → ModelsTab 收敛（非白名单字面量丢 tab 只指路分区）。 */
export function resolveModelsTab(tab: string | undefined): ModelsTab | undefined {
  return tab !== undefined && tab in MODELS_TAB_SET ? (tab as ModelsTab) : undefined;
}

/** IconRail 导航位（序沿 review.md §6 R-P4-1 去 models 位；S2：模型配置归设置页；T3.1：任务位入列；清单以本数组为单源）。 */
const RAIL_ITEMS: readonly IconRailItem<AppRoute>[] = [
  { id: "chat", route: ROUTE_WORKBENCH, labelKey: "chat.nav.pages.chat.label", icon: MessageSquare },
  { id: "skills", route: ROUTE_SKILLS, labelKey: "chat.nav.pages.skills.label", icon: Layers },
  { id: "trace", route: ROUTE_TRACE, labelKey: "chat.nav.pages.trace.label", icon: Activity },
  { id: "project", route: ROUTE_PROJECT, labelKey: "chat.nav.pages.project.label", icon: FolderKanban },
  { id: "tasks", route: ROUTE_TASKS, labelKey: "chat.nav.pages.tasks.label", icon: ListTodo },
  { id: "settings", route: ROUTE_SETTINGS, labelKey: "chat.nav.pages.settings.label", icon: Settings },
];

/**
 * 主壳路由域（导出供 App 级测试消费——App.gate-hold / App.steward-global
 * 先例；页面桩 + useSession/useWorkspace mock 口径见同名测试）。
 */
export function AppRoutes() {
  const { route, navigate } = useAppRoute();
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  // 管家全局弹层开合（管家全局化批：app 壳级能力——开合态在 app 层，
  // 入口 IconRail 管家位 / 弹层 StewardDock 均本层装配；toggle/close 提取
  // useCallback（stopWeb 同规：常驻壳上受控钮内联箭头每渲染新引用）
  const [stewardOpen, setStewardOpen] = useState(false);
  const toggleSteward = useCallback(() => setStewardOpen((v) => !v), []);
  const closeSteward = useCallback(() => setStewardOpen(false), []);
  // B2 全局语音层（steward-open-signal 接线方改唤起光球，D1=A：唤醒=
  // 光球浮现+欢迎语+持续麦双工，不弹面板）：app 层计数信号递进 → Layer
  // 消费唤起（已在会话无感幂等；热键路径在 hook 内直连 wake-hotkey 零经信号）
  const [voiceWakeSignal, setVoiceWakeSignal] = useState(0);
  useEffect(
    () => subscribeOpenSteward(() => setVoiceWakeSignal((n) => n + 1)),
    [],
  );
  // B2-④ 入口①：StewardPanel 头部记忆钮 → 记忆独立页（关面板 + 导航）
  const openStewardMemory = useCallback(() => {
    setStewardOpen(false);
    navigate(ROUTE_STEWARD_MEMORY);
  }, [navigate]);
  // M3-d1 感知兑现批：StewardPanel 头部活动钮 → 活动时间线页（关面板 + 导航）
  const openStewardActivity = useCallback(() => {
    setStewardOpen(false);
    navigate(ROUTE_STEWARD_ACTIVITY);
  }, [navigate]);
  // 「打开设置页某分区」信号接线（Bug 修复批：P-3 零可用空态逃生口——
  // features 层发起 shared 信号，本层订阅 navigate + 分区指路；
  // AG-15：app → pages 引 settings-section-bus 合法）
  useEffect(
    () =>
      subscribeOpenSettings((section, tab) => {
        // shared 信号 tab 为宽 string（依赖方向：shared 不引 pages 类型）；
        // 本层收敛——非模型 tab 字面量直接丢弃（只指路，不猜义）。
        // 白名单 = Record<ModelsTab, true> 形态：ModelsTab 联合新增成员时
        // 编译期报缺键，避免手写联合白名单漏项被静默丢弃（classifier 曾漏）
        const modelsTab = resolveModelsTab(tab);
        requestSettingsSection(section, modelsTab);
        navigate(ROUTE_SETTINGS);
      }),
    [navigate],
  );
  // 页内指路出口（T3.1/T3.2）：P-2 任务页 → /project；P-1 bootstrap 入口卡与
  // 产出分组 → /tasks（页面间闭环流转，review.md §页面间闭环）
  const goProject = useCallback(() => navigate(ROUTE_PROJECT), [navigate]);
  const goTasks = useCallback(() => navigate(ROUTE_TASKS), [navigate]);
  // T4 web 族（契约 v0.7）：联网状态读面（topology.webStatus，拓扑级消费）
  // + 停止写面（web.stop 命令帧）→ IconRail props 注入（IconRail 纯展示）；
  // T7 显式启动写面（web.start，v0.9）同链注入
  const { topology, sendWebStop, sendWebStart } = useSession();
  // T4/T7 web 双写面 send 返回值消费（TR-84/TR-168，code-review 低危组9）：
  // false（断线窗口未发出）err toast 交代——IconRail 纯展示零反馈面，收口
  // 归装配层；文案复用 modelsConfig.sendFailToast 通用「未连接 daemon」面
  //（新增 i18n 键超出本组 shared/ 冻结边界）
  const stopWeb = useCallback((): boolean => {
    const ok = sendWebStop();
    if (ok === false) toast.push("err", t("chat.modelsConfig.sendFailToast"));
    return ok;
  }, [sendWebStop, toast, t]);
  const startWeb = useCallback((): boolean => {
    const ok = sendWebStart();
    if (ok === false) toast.push("err", t("chat.modelsConfig.sendFailToast"));
    return ok;
  }, [sendWebStart, toast, t]);
  // 主题切换提取 useCallback（stopWeb/startWeb 同规）：IconRail 常驻壳上
  // 组件，内联箭头每次渲染新建 props 引用
  const onToggleTheme = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [theme, setTheme]);
  const onWorkbench = route === ROUTE_WORKBENCH;
  // 语音播报批 V2：全局播放钩子（连接就绪 + 偏好开 → voice.subscribe；
  // voice.broadcast → seq 去重保序 Audio 播放）——App 根单份，与会话无关
  useVoiceBroadcast();
  // navigate 动作消费（surface.action 收编 + 语义修正）：帧到达 = 确认闸
  // 已过的授权动作，直接切页（与侧栏点击同一路径）；回执真执行后发
  // （navigated）。toast+点按二次授权形态已退役（2026-10-07 实测事故）。
  // 帧经订阅闸（enabled∧connected，B1 起不随面板开合），无自激面。
  const { switchSession } = useSession();
  useStewardNavigate(
    useCallback(
      (sessionId: string) => {
        if (route !== ROUTE_WORKBENCH) navigate(ROUTE_WORKBENCH);
        switchSession(sessionId);
      },
      [route, navigate, switchSession],
    ),
  );
  // M0 表面协议地基：shell surface adapter（页面级——连接就绪恒注册
  // surface.register；感知开关（默认 off）门内 activated/navigated 上行；
  // App 根单份，与路由层同生命周期）
  useShellSurface(route);
  return (
    <>
      <div className="app-shell">
        <IconRail
          items={RAIL_ITEMS}
          active={route}
          onNavigate={navigate}
          theme={theme}
          onToggleTheme={onToggleTheme}
          webStatus={topology.webStatus}
          onStopWeb={stopWeb}
          onStartWeb={startWeb}
          stewardOpen={stewardOpen}
          onToggleSteward={toggleSteward}
        />
        <div className="page-area">
          {/* 工作台常驻 DOM：非工作台路由 display:none（状态/WS 全保留） */}
          <div className="route-layer" data-route={onWorkbench ? "on" : "off"}>
            <ChatPage />
          </div>
          {route === ROUTE_SKILLS && <AgentPage path={ROUTE_SKILLS} />}
          {route === ROUTE_TRACE && <TracePage path={ROUTE_TRACE} />}
          {route === ROUTE_PROJECT && <ProjectPage path={ROUTE_PROJECT} onOpenTasks={goTasks} />}
          {route === ROUTE_TASKS && <TasksPage path={ROUTE_TASKS} onOpenProject={goProject} />}
          {route === ROUTE_SETTINGS && (
            <SettingsPage path={ROUTE_SETTINGS} onOpenStewardMemory={() => navigate(ROUTE_STEWARD_MEMORY)} />
          )}
          {route === ROUTE_STEWARD_MEMORY && <StewardMemoryPage path={ROUTE_STEWARD_MEMORY} />}
          {route === ROUTE_STEWARD_ACTIVITY && <StewardActivityPage path={ROUTE_STEWARD_ACTIVITY} />}
        </div>
      </div>
      {/* 管家全局弹层（管家全局化批）：rail 右缘 fixed 浮动面板，页面域之外
          ——路由切换不卸载（app 生命周期态）；B2-④ 记忆钮注入开页回调 */}
      <StewardDock open={stewardOpen} onClose={closeSteward} onOpenMemory={openStewardMemory} onOpenActivity={openStewardActivity} />
      {/* B1 确认卡栈（左下角全局 fixed 视口层——E-135 真全屏语义）：多卡并存
          独立于面板开合/光球（纯文本期照常出现）；数据面单实例挂载于此 */}
      <ConfirmStack />
      {/* B2 管家全局光球层（app 壳级独立 root——E-135 真全屏语义，D1=A）：
          光球+字幕+语音双工常驻挂载（duplex 期渲染，不在场零 DOM）；z 序
          压过 StewardDock/scanline */}
      <StewardVoiceLayer wakeSignal={voiceWakeSignal} />
      {/* 产品氛围层（S1 上提全局单份：fixed + pointer-events:none；各页历史副本已随 AppLayout 迁移全数清理） */}
      <div className="scanline-overlay" aria-hidden="true" />
      {/* W2-D kg sync 提示全局 toast（task.changed 随行 syncHint 直渲；页面无关常驻） */}
      <TaskSyncHintToast />
      {/* U5 占用协调轻通知（coord.changed 全局广播直渲；escalated 用 warn 提级） */}
      <CoordNoticeToast />
      {/* 管家感知批 M0.5 主动通知（steward.notify 分诊呈现轨；接续提案点按才动） */}
      <StewardNotifyToast onOpenTasks={goTasks} />
    </>
  );
}

/**
 * 门禁组装（W3；设计稿 §2.1）：依赖注入点——从 SessionContext 提取连接就绪
 * 与 workspace 命令/帧订阅面注入 WorkspaceProvider（AG-15 entities 跨 slice
 * 零互引，app 层组装；SessionProvider TransportFactory 注入同构）。
 */
function WorkspaceGate() {
  const { state, sendWorkspaceGet, sendWorkspaceOpen, subscribeWorkspaceFrames } = useSession();
  const connected = state.conn === "connected";
  const deps = useMemo(
    () => ({ connected, sendGet: sendWorkspaceGet, sendOpen: sendWorkspaceOpen, subscribe: subscribeWorkspaceFrames }),
    [connected, sendWorkspaceGet, sendWorkspaceOpen, subscribeWorkspaceFrames],
  );
  return (
    <WorkspaceProvider deps={deps}>
      <WorkspaceGateBranch />
    </WorkspaceProvider>
  );
}

/**
 * 首启 boot 序列 hold 时长（W6o；W6p 调参至 0.9s 档）：序列末行 --d
 * 0.81s + 入场余量 ≈ 0.9s——序列播完的兜底下限（连接就绪早于此则等待，
 * 晚于此由连接就绪条件收口）。导出供门禁 hold 测试消费（fake timers 步进基准）。
 */
export const BOOT_HOLD_MS = 900;

/**
 * 门禁分支（W3；W4 切换流复用；W6o 首启 hold）：phase=gate → 选择页
 * （首启无导航逃逸；切换流入口带取消逃逸——switching 态页面自渲染返回钮，
 * 首启语义不变）；connecting → 终端风连接屏（W6b；conn=error 时重试占位）；
 * main → 主壳（AppRoutes 零改动）。phase 由 entities/workspace 状态机驱动。
 *
 * 首启 hold（W6o）：打包形态 JS 内嵌秒载、React 立即替换静态 boot 序列
 * （来不及播），真实等待转移到 daemon 连接段——连接屏升格为完整开场动画。
 * 首启在「连接就绪（phase 离开 connecting）且序列播完（挂载起 BOOT_HOLD_MS
 * 兜底）」前恒显 boot 屏（full 形态，即使 phase 已到 gate/main——gate 选择页
 * 同受 hold，开场体验统一）；双条件齐备置 firstBootDone（ref+state：ref 供
 * effect 内同步判重，state 驱动渲染）后恒不复发——此后 phase 回 connecting
 * （重连）→ status 形态直显（无 hold，中途断连不重播序列防打扰）。切换流
 * 是 main 态内路由（firstBootDone 已置）不受影响。导出供门禁 hold 测试消费。
 */
export function WorkspaceGateBranch() {
  const { state } = useWorkspace();
  const [seqDone, setSeqDone] = useState(false);
  const [firstBootDone, setFirstBootDone] = useState(false);
  const firstBootRef = useRef(false);

  // 序列播完兜底：挂载起计时（非阻塞 setTimeout；卸载清理）
  useEffect(() => {
    const timer = setTimeout(() => setSeqDone(true), BOOT_HOLD_MS);
    return () => clearTimeout(timer);
  }, []);

  // 双条件齐备 → firstBootDone 恒置（不回退）。「门禁已判定」≠连接态：
  // phase 离开 connecting 即视为已判定（真连接态在 state.conn，一词两义防混）
  const phaseSettled = state.phase !== "connecting";
  useEffect(() => {
    if (!firstBootRef.current && seqDone && phaseSettled) {
      firstBootRef.current = true;
      setFirstBootDone(true);
    }
  }, [seqDone, phaseSettled]);

  if (!firstBootDone) return <WorkspaceBootScreen variant="full" />;
  if (state.phase === "connecting") return <WorkspaceBootScreen variant="status" />;
  if (state.phase === "gate") return <WorkspaceGatePage />;
  return <AppRoutes />;
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <SessionProvider>
            <WorkspaceGate />
          </SessionProvider>
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
