/** zh-CN 词条分片：tk 域（barrel 见 ../zh-CN.ts）。
 *
 * 业务域分片重构（体量门）：本文件是该域词条的唯一定义处，键/值/嵌套
 * 结构与批次溯源注释自原 zh-CN.ts 原样迁移（零改写）。
 */
export const tk = {
  // ── P-2 任务页（T3.1；iter-20260829-ys7q；文案源 = prototype/P-2-task.html + review.md R-1~R-9/R-19）──
  tk: {
    title: "任务",
    status: {
      pending: "装配中",
      running: "运行中",
      paused: "已暂停",
      done: "已完成",
      failed: "失败",
      cancelled: "已取消",
    },
    stage: { pending: "待启动", running: "进行中", done: "已完成", failed: "失败" },
    batch: { pending: "待启动", running: "进行中", done: "完成", failed: "失败" },
    filter: { all: "全部", allProjects: "全部项目" },
    countLine: "共 {n} 个任务 · 运行中置顶",
    list: {
      progPending: "装配中",
      progDone: "全部完成",
      progFailed: "失败",
      progCancelled: "已取消",
      progRunning: "{stage} · 批次 {done}/{total}",
      progPaused: "{stage} · 批次 {done}/{total}",
      created: "{at} 创建",
    },
    dur: {
      sec: "{n} 秒",
      min: "{n} 分钟",
      hourMin: "{h} 小时 {m} 分钟",
      running: "已运行 {dur}",
      final: "运行 {dur}",
      createdAgo: "创建于 {dur}前",
    },
    emptyList: {
      title: "暂无任务",
      sub: "任务从宿主上下文发起：在「项目」页选中项目可创建 kg-bootstrap 任务，或在会话中让 MainAgent 发起。任务创建后会出现在这里。",
      cta: "前往「项目」页 →",
    },
    emptyDetail: { title: "没有可展示的任务", sub: "任务创建后即可在此观察进度、批次中间状态与结果。" },
    noSelect: { title: "未选中任务", sub: "从左侧列表选择一个任务，查看阶段进度、批次中间状态与结果。" },
    filterEmpty: {
      title: "没有匹配的任务",
      sub: "当前状态 / 项目过滤下没有任务，调整过滤条件试试。",
      clear: "清除过滤",
    },
    head: { created: "{at} 创建", srcPage: "「项目」页发起", srcChat: "会话发起", goProject: "前往「项目」页 →" },
    act: { pause: "暂停", resume: "继续", cancel: "取消", retry: "重试", delete: "删除" },
    confirm: {
      cancelText:
        "确认取消任务「{title}」？进行中的批次会收口，已完成阶段的产出保留（confirmed 正式知识），未启动的批次不再执行。取消不可撤销。",
      cancelYes: "确认取消",
      deleteText:
        "确认删除任务「{title}」？将清理该任务的全部任务域记录（任务 / 阶段 / 批次行与各批次实例工作台账），不可撤销；kg 产出（知识节点）不受影响，仍可在「项目」页查看与修正。",
      deleteYes: "确认删除",
      back: "返回",
    },
    toast: {
      paused: "任务已暂停：当前批次完成后挂起，未派新批次",
      resumed: "任务已继续：从挂起点恢复批次派发",
      retried: "任务已重试：失败批次预算已重置，从失败阶段继续（已完成阶段不重跑）",
      cancelled: "任务已取消：已完成阶段产出保留（confirmed）",
      deleted: "任务已删除：{title}（任务域记录已清理，kg 产出保留）",
      failed: "操作失败：{msg}",
      sendFailed: "发送失败：与 daemon 的连接不可用，请稍后重试",
    },
    stageSub: {
      done: "已完成",
      running: "进行中",
      runningBatches: " · 批次 {done}/{total}",
      failed: "失败",
      pending: "待启动",
      prep: "备料中（编排直执）",
      toAggregate: "待汇总（编排直执）",
    },
    batches: "批次",
    noBatches: {
      title: "批次尚未划分",
      sub: "编排器装配完成后将按阶段划定批次，批次的工作台账（实例 plan）会实时呈现在这里。",
    },
    batchPlan: {
      doneCount: "{done}/{total} 项完成",
      doing: "正在：",
      open: "收起工作台账 ▴",
      closed: "展开工作台账 ▾",
      queue: "待启动：批次范围已划定，队列中等待派发。",
      none: "该实例未建工作台账。",
    },
    retry: "自动重试 {n} 次",
    /** retryNote 留史前缀：批次已越过失败（done/重派 running）时标注——区别于 failed 态的当前失败原因。 */
    retryNoteHistory: "历史：{note}",
    /** ⑤ 链 A：批次行实例徽标 parked 形态尾缀（「agent-3 · 挂起(任务暂停)」）。 */
    instParked: "挂起(任务暂停)",
    result: {
      tabProgress: "进度",
      tabResult: "任务结果",
      emptyTitle: "尚无阶段产物",
      emptySub: "阶段完成后，编排器会把产出节点集与阶段摘要聚合到这里。",
      /** M10 批⑥：artifacts 拉取失败错误面（带重试入口，不谎报空态）。 */
      errorTitle: "产物加载失败",
      errorSub: "拉取阶段产物时出错，可重试。",
      retry: "重试",
    },
  },
};
