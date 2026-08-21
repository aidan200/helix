/** P-1 聊天页文案命名空间（AD-18：UI 文案全 key；领域数据不在此列）。 */
export interface ChatTranslations {
  header: {
    session: string;
    home: string;
  };
  conn: {
    connected: string;
    connecting: string;
    disconnected: string;
    error: string;
  };
  banner: {
    reconnecting: string;
    reconnectAttempt: string;
    reconnectingAddr: string;
  };
  overlay: {
    connecting: string;
    addr: string;
  };
  error: {
    title: string;
    desc: string;
    retry: string;
    retryOk: string;
    retryOkSub: string;
  };
  empty: {
    title: string;
    suggest: {
      read: string;
      test: string;
      grep: string;
    };
  };
  /** 终验热修：引擎错误卡（engine.error 帧投影） */
  engineError: {
    title: string;
    hint: string;
  };
  composer: {
    placeholder: string;
    placeholderConnecting: string;
    placeholderWaiting: string;
    send: string;
    /** 值内 [[x]] 标记渲染为 kbd 键帽（如 "[[Enter]] 发送"） */
    enterHint: string;
    projectionNote: string;
  };
  steer: {
    hint: string;
    queued: string;
    drained: string;
    /** 定向 steer chip（CL-3 双处同构细条：「steer → {id}」） */
    directedChip: string;
  };
  restore: {
    toast: string;
    toastSub: string;
  };
  msg: {
    you: string;
    agent: string;
  };
  tool: {
    running: string;
    done: string;
    error: string;
    args: string;
    result: string;
    resultFailed: string;
  };
  /** SubAgent 卡片与 spawn 提示词条（review.md sa.card 与 sa.spawn 清单；CL-1） */
  sa: {
    card: {
      queued: string;
      waiting: string;
      queueFoot: string;
      running: string;
      channelSub: string;
      doneBadge: string;
      failedBadge: string;
      /** AD-10：重启收口恢复态，区别 failed（本迭代新增，无原型演示位） */
      cancelledBadge: string;
      cancelledSub: string;
      failedFoot: string;
      injectedMain: string;
      /** 快照恢复的 done 卡无本地收口时间（DTO 无 closure 时间戳）时的无时间变体 */
      injectedMainNoTime: string;
      openDrawer: string;
    };
    spawn: {
      toast: string;
      toastSub: string;
    };
  };
  /** thinking 块三态（F2.3/F2.4）与 compaction 里程碑条（F4.1）词条
   *  （review.md think/compact 清单；CL-2/CL-4） */
  think: {
    /** streaming 态微标签（accent 脉冲点旁） */
    streaming: string;
    /** complete 折叠条标题（s = 取整秒，n = tokens 档位） */
    done: string;
  };
  compact: {
    /** 里程碑条标题（before/after = fmtTokens 档位） */
    bar: string;
    /** 展开 summary 后的保留注（v0.1 DTO 无尾部/文件计数字段 → 无数字变体） */
    note: string;
  };
  /** 统计徽标与 usage popover（F3.3/F3.4；review.md stats 清单 + 清单外新增
   *  mainRunning/mainIdle/kind* 展示键，沿 T4.1 cancelled 先例） */
  stats: {
    badge: string;
    popTitle: string;
    total: string;
    footNote: string;
    cacheSub: string;
    reasoningSub: string;
    compactSub: string;
    /** main 行状态 chip（SubAgent/compaction 行用协议状态字面量，领域词汇不进词条） */
    mainRunning: string;
    mainIdle: string;
    /** 行 kind 标签（main/SubAgent/compaction） */
    kindMain: string;
    kindSub: string;
    kindCompact: string;
  };
  /** SubAgent 抽屉（P-2；review.md drawer 清单 + T4.3 补齐 close/slot 声明键；CL-1 F1.2/F1.8） */
  drawer: {
    /** ✕/背板关闭 aria 标签 */
    close: string;
    task: string;
    channel: string;
    kill: string;
    killConfirm: string;
    killedToast: string;
    killedToastSub: string;
    stalled: string;
    stalledLc: string;
    steerMark: string;
    steerToast: string;
    steerToastSub: string;
    /** 底部 steer 输入栏（CL-3 F(3.3).3，仅 running 渲染）：目标行标签 /
     *  输入占位（{id} = 绑定实例）/ 输入框 aria 标签 */
    steerTarget: string;
    steerPlaceholder: string;
    steerInputLabel: string;
    queuedHint: string;
    reportFoot: string;
    instanceMeta: string;
    /** 模型解析行槽位描述（profile.model 声明/缺省继承，AD-6） */
    slotDeclared: string;
    slotInherited: string;
    lc: {
      spawned: string;
      modelResolved: string;
      crashed: string;
      terminated: string;
    };
    closure: {
      title: string;
    };
  };
  /** P-2 会话列表（widgets/session-sidebar；CL-1 F(1.2)/F(2.1).2；T3.2） */
  sidebar: {
    /** 「新建会话」按钮（新建草稿，本地态零 daemon 帧） */
    newSession: string;
    /** 列表分区标签 Sessions */
    sessions: string;
    /** 草稿卡片时间位文案（未发送） */
    notSent: string;
    /** 草稿徽标 */
    draft: string;
    /** 运行态徽标三态 + 草稿（SessionMeta.runState 同源） */
    runStreaming: string;
    runSubagent: string;
    runIdle: string;
    /** 折叠/展开侧栏（icon 按钮 title） */
    collapse: string;
    expand: string;
    /** 删除入口（trash 按钮 title）与二次确认条 */
    deleteTitle: string;
    deleteConfirmText: string;
    deleteConfirm: string;
    deleteCancel: string;
    /** 删除命令交代 toast（确认后即时反馈；daemon 取消链异步收口） */
    deleteToast: string;
    deleteToastSub: string;
    /** 相对时间档位（relativeTimeSpan 档位 → 文案） */
    timeJustNow: string;
    timeMinutes: string;
    timeHours: string;
    timeYesterday: string;
    timeDays: string;
  };
  /** 顶栏信息区（widgets/top-bar；F(2.1).3；T3.2） */
  topbar: {
    /** 草稿态会话标题 */
    draftTitle: string;
    /** 模型徽标（P-3 入口位；点击行为 T3.3） */
    modelTitle: string;
  };
  /** P-1s 切换两阶段 + 分页（F(1.2).3；T3.2） */
  paging: {
    /** 恢复骨架状态行（n = 尾窗条数） */
    status: string;
    /** 输入禁用 placeholder */
    placeholder: string;
    /** 分页胶囊（n = 已载 / m = 全量）；加载尽后禁用态同文案 */
    loadEarlier: string;
    loadedCount: string;
  };
  /** 草稿空态（F(1.2).1：新建后主区空白聊天区） */
  draftEmpty: {
    title: string;
    hint: string;
  };
  /** 活跃事件条（T5.5：右侧活跃事件条；折叠/展开两态 + 类型注册表标签） */
  rail: {
    label: string;
    open: string;
    expand: string;
    collapse: string;
    typeSubagent: string;
  };
  /** P-4 模型/厂商配置路由壳（页面本体 T3.3；本任务仅返回壳） */
  /** 设置页（S2 实页化：AppLayout 壳 + 分区导航；模型配置分区 = 原 P-4 页迁入） */
  settings: {
    /** 模型设置分区标题（原独立页页名沿用） */
    title: string;
    /** 分区导航（SettingsNav）词条族 */
    nav: {
      /** 分区导航栏 aria-label/组标签 */
      label: string;
      /** 分区项：模型设置 */
      models: string;
    };
  };
  /** IconRail 导航壳 + 四占位页施工牌（widgets/nav-rail + pages/*；CL-4 F(4.4).1/F(4.4).3；T3.4） */
  nav: {
    /** 主导航 aria-label */
    railLabel: string;
    /** 施工牌「规划中」徽标（hud-badge-cyan） */
    plannedBadge: string;
    /** 主题切换单钮（S1：IconRail 底部，Sun/Moon 显示切换目标） */
    themeToggle: string;
    pages: {
      chat: { label: string };
      /** 占位页：label = 页名；preview = 一句话能力预告（≤32ch，无时间承诺词） */
      skills: { label: string; preview: string };
      trace: { label: string };
      project: { label: string; preview: string };
      /** 设置（S2 实页化，非施工牌；仅 label） */
      settings: { label: string };
    };
  };
  /** P-3 模型切换弹出菜单（features/model-switch；CL-3 F(3.3).1-F(3.3).3；T3.3） */
  modelSwitch: {
    searchPlaceholder: string;
    emptyTitle: string;
    emptySub: string;
    resetToDefault: string;
    effectiveHint: string;
    defaultBadge: string;
    /** 零可用（无任何 configured provider 且当前模型不在目录）空态引导（T5.3） */
    noProviderTitle: string;
    noProviderSub: string;
    switchedToast: string;
  };
  /** 模型与厂商配置（S2 归设置页模型分区；CL-3 F(3.4).1-F(3.4).6；T3.3） */
  modelsConfig: {
    defaultLabel: string;
    refresh: string;
    refreshedJustNow: string;
    refreshedAt: string;
    providersLabel: string;
    unconfigured: string;
    connUnverified: string;
    connVerifying: string;
    connOk: string;
    connFail: string;
    test: string;
    changeKey: string;
    deleteKey: string;
    confirmDelete: string;
    configureKey: string;
    colModel: string;
    colContext: string;
    colInput: string;
    colOutput: string;
    colCacheRead: string;
    colCacheWrite: string;
    tableCaption: string;
    defaultChip: string;
    modalTitle: string;
    modalSub: string;
    apiKeyLabel: string;
    apiKeyPlaceholder: string;
    apiKeyEmptyErr: string;
    cancel: string;
    save: string;
    keyDeletedToast: string;
    refreshedToast: string;
    defaultUpdatedToast: string;
  };
  /** 时间戳格式（"HH:mm"） */
  tsFormat: string;
}

/** P-1 TracePage 文案命名空间（CL-5，T2.2；原型 P-1-trace.html 文案逐条对齐）。 */
export interface TraceTranslations {
  title: string;
  controls: {
    ariaLabel: string;
    range: string;
    types: string;
    typesGroup: string;
    rangeAll: string;
    range1h: string;
    range15m: string;
    range5m: string;
  };
  /** sidebar 上下分区（S3b：上 = 会话列表；下 = 实例分区标题/计数/空态复用 trace.panel.*） */
  sidebar: {
    /** 侧栏整体 aria 标签 */
    ariaLabel: string;
    /** 上分区标题（会话列表） */
    sessions: string;
    /** 上分区空态（无会话） */
    sessionsEmpty: string;
    /** 下分区空态（未选会话） */
    pickSession: string;
  };
  panel: {
    ariaLabel: string;
    title: string;
    count: string;
    all: string;
    allSub: string;
    eventCount: string;
    empty: string;
    mainName: string;
    statusRunning: string;
    statusCompleted: string;
    statusFailed: string;
    statusKilled: string;
    /** running 实例起止时间行（{start} = 起时，{dur} = 已运行时长） */
    timeRunning: string;
  };
  ctx: {
    ariaLabel: string;
    title: string;
    /** agent.instantiated 来源行（{time} = 起时） */
    source: string;
    taskCite: string;
    model: string;
    tools: string;
    compaction: string;
    compactionValue: string;
    compactionOff: string;
    baseModel: string;
    prompt: string;
    promptChars: string;
    expand: string;
    collapse: string;
    timeline: string;
    current: string;
    compactionMilestone: string;
    compactionEvent: string;
    snapshotMissing: string;
    snapshotMissingHint: string;
  };
  table: {
    time: string;
    instance: string;
    type: string;
    summary: string;
    hit: string;
    copyJson: string;
    copied: string;
    copyFailed: string;
    payloadHead: string;
  };
  paging: {
    meta: string;
    more: string;
    allLoaded: string;
  };
  state: {
    emptySession: string;
    emptySessionHint: string;
    emptyFiltered: string;
    emptyFilteredHint: string;
    errorTitle: string;
    retry: string;
    connTitle: string;
    connDesc: string;
    reconnect: string;
    reconnectedToast: string;
    notConnected: string;
  };
}

/** 智能体配置页（pages/skills，M6 T4；导航名「智能体」，路由 /skills 不变） */
export interface AgentsTranslations {
  title: string;
  mainTitle: string;
  subTitle: string;
  modelLabel: string;
  modelFollowMain: string;
  modelFollowSub: string;
  modelNoteMain: string;
  modelNoteSub: string;
  toolsLabel: string;
  skillsLabel: string;
  skillsEmpty: string;
  diagLabel: string;
  loading: string;
  errorTitle: string;
  retry: string;
  skippedToast: string;
  notConnected: string;
  switchOn: string;
  switchOff: string;
}

export interface Translations {
  chat: ChatTranslations;
  trace: TraceTranslations;
  agents: AgentsTranslations;
}

export type Lang = "zh-CN" | "en-US";
