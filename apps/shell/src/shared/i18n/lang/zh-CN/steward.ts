/** zh-CN 词条分片：steward 域（barrel 见 ../zh-CN.ts）。
 *
 * 业务域分片重构（体量门）：本文件是该域词条的唯一定义处，键/值/嵌套
 * 结构与批次溯源注释自原 zh-CN.ts 原样迁移（零改写）。
 */
export const steward = {
  steward: {
    title: "文本管家",
    close: "关闭",
    stateOn: "在线",
    stateOff: "未开启",
    disabledTitle: "管家未开启",
    disabledHint: "管家开关默认关闭；到「设置 → 通用」开启后可在这里问询全局状态，写动作需经确认。",
    feedTitle: "事件流",
    feedEmpty: "暂无事件",
    thinking: "思考中…",
    // ── 过程反馈 UI 批：状态区状态文（工具执行期；{name} 单大括号——TR-222）──
    activityTool: "正在调用 {name}…",
    // ── 工具态醒目面批：光球工具行前缀（badge 结构拆键——面板仍用 activityTool 整句）──
    activityToolPrefix: "正在调用",
    // ── A1 工作记忆批：过程可见面（thinking 折叠 / 工具行 / 新对话）──
    thinkingLabel: "思考过程",
    newChat: "新对话",
    newChatTitle: "清空当前对话（管家记忆与显示同步清空）",
    activity: {
      openTitle: "查看活动时间线",
      pageTitle: "管家活动",
      rangeToday: "今天",
      rangeYesterday: "昨天",
      rangeThisWeek: "本周",
      rangeAll: "全部",
      refresh: "刷新",
      clear: "清空记录",
      clearArmed: "确认清空",
      empty: "这个时间段还没有活动记录",
      loading: "正在读取活动记录…",
      live: "实时",
      domainTask: "任务",
      domainSession: "会话",
      domainAgent: "帮手",
      domainSurface: "界面",
      domainCli: "终端",
      domainNotify: "通知",
      attributionUser: "我",
      attributionSteward: "管家",
      attributionSystem: "后台",
    },
    memory: {
      pageTitle: "管家记忆",
      openTitle: "管理长期记忆",
      searchPlaceholder: "搜索记忆…",
      stats: "{count} 条 · {dim} 维",
      statsFaded: "淡忘 {count}",
      statsPinned: "置顶 {count}",
      add: "新增",
      addModalTitle: "新增记忆",
      addModalSub: "保存后自动向量化入库（走当前端点嵌入）；手动新增的永不淡忘",
      textLabel: "记忆文本",
      kindLabel: "类别",
      emptyTextErr: "记忆文本不得为空",
      empty: "暂无记忆条目",
      vectorizing: "向量化中…",
      unavailable: "记忆未启用或向量端点未就绪（设置 → 通用 → 长期记忆）",
      justNow: "刚刚",
      source: {
        manual: "手动",
        stewardTurn: "对话记录",
        sessionSummary: "总结沉淀",
        sessionProgress: "会话进展",
        autoSediment: "自动沉淀",
      },
      // ── domain 维度批：业务领域（徽标/筛选/新增打标）──
      domain: {
        habit: "习惯",
        general: "通用",
        project: "项目",
      },
      domainLabel: "业务领域",
      projectLabel: "项目名",
      projectPlaceholder: "项目目录名（如 helix）",
      filterKindAll: "全部类别",
      filterDomainAll: "全部领域",
      // ── 遗忘机制批：筛选/排序/分页/淡忘/置顶 ──
      filterAll: "全部",
      filterActive: "活跃",
      filterFaded: "淡忘",
      filterPinned: "置顶",
      sortUpdated: "最近更新",
      sortCreated: "最早创建",
      sortRecalled: "被想起最多",
      fadedChip: "淡忘中",
      pinnedChip: "已置顶",
      pinAction: "置顶",
      unpinAction: "取消置顶",
      restoreAction: "恢复",
      recalledNever: "从未被想起",
      recalledTimes: "被想起 {n} 次",
      lastRecalled: "最后想起 {span}",
      pageSizeLabel: "每页",
      pageRange: "第 {from}–{to} 条 / 共 {total}",
    },
    inputPlaceholder: "问管家：现在有什么在跑？",
    send: "发送",
    // 手动停止批：在途停止按钮 + stopped 回执文案（{count} 插值）
    stop: "停止",
    stoppedNotice: "已停止当前处理",
    stoppedNoticeDropped: "已停止当前处理（丢弃 {count} 条排队输入）",
    // L1 件二：排队确认帧文案（{position} 插值）
    askQueued: "已排队（第 {position} 位）——当前回答完成后自动接续",
    // M3-a（CAND-601）：主动汇报实时帧文案——与 daemon 工作记忆记录逐字节
    // 同形（回放同构：en 同文，见 en-US 同键注释）
    proactiveTitle: "【主动汇报】{title}",
    proactiveSuggestion: "建议：{label}（点按才动）",
    memoryAdded: "已记入长期记忆",
    memoryUpdated: "记忆已更新（同一条覆盖）",
    confirmTitle: "写动作待确认",
    confirmTarget: "目标",
    confirmBody: "内容",
    confirmYes: "确认执行",
    confirmNo: "放弃",
    // ── B1 全局确认卡栈（左下角 ConfirmStack）+ 建议导航 toast ──
    cardAccepted: "受理中…",
    cardDone: "已完成",
    cardMore: "还有 {n} 张",
    actionDone: "动作已完成",
    actionFailed: "动作执行失败",
    // ── 语音模式（V3a：双模切换 + 说话闭环面板面；文本模式零发声）──
    voice: {
      // ── B2 全局语音批：光球层（StewardVoiceLayer）──
      welcome: "我在，请说。",
      orbLabel: "管家语音",
      orbMuted: "麦克风已静音，点击恢复",
      orbStopRead: "点击停止朗读",
      // ── 光球健康角标批：左上 TTS 队列计数 + 右上故障组件徽标 ──
      orbQueueBadge: "TTS 播报队列 {n} 条",
      orbHealthJudge: "判官",
      orbHealthTts: "TTS",
      orbHealthStt: "转写",
      orbHealthLlm: "模型",
      orbHealthTitle: "语音链异常：{list}",
      cmdConfirmOk: "已确认 {target}",
      cmdCancelOk: "已取消 {target}",
      cmdNoCards: "没有待确认的卡片",
      cmdNotFound: "没有 {n} 号卡片",
      cmdSettled: "{n} 号卡片已处理过",
      cmdCancelAllOk: "已取消 {n} 张待确认卡片",
      // ── ③ 语音触达（语音闭环批）：弹卡即播短句（仅双工会话活跃期）──
      cardPending: "有个投递等你确认",
      // ── M3-c 声纹批：授权点拒绝白话（纯语音明示 + 卡保留——TR-243/TR-249；
      //    闸门对应修复批：附相似度 pct——reject 三因（真旁人/阈值未达/取样段
      //    偏差）可辨）──
      // ── 光球分区批：左侧输入流水闸门注记（零播报——旁人零出声裁决不动；
      //    声纹未过附相似度与阈值、非交流意图、转写失败三种可辨）──
      inputVoiceprintReject: "声纹未过（相似度 {pct}%，阈值 {th}%）",
      inputJudgeReject: "非交流意图",
      inputAsrFail: "转写失败",
      // 批 3b 退役：bargeInQueued/bargeInVerifySkip（排队插话与 skip 提示）随裁决 #2 拆除
    },
  },
};
