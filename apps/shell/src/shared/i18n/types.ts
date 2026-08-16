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
    steerOnlyRunning: string;
    steerOnlyRunningSub: string;
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
  theme: {
    dark: string;
    light: string;
  };
  /** 时间戳格式（"HH:mm"） */
  tsFormat: string;
}

export interface Translations {
  chat: ChatTranslations;
}

export type Lang = "zh-CN" | "en-US";
