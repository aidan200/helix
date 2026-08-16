/**
 * zh-CN 默认词条包（AD-18；AG-16-② 完备性由 zh-CN.test.ts 守护）。
 *
 * 文案来自 prototype/review.md「P-1 文案 key 清单」（原型文案逐条对齐）；
 * 变量占位 {n}/{addr}/{code}；enterHint 的 [[x]] 标记渲染为 kbd 键帽。
 */
import type { Translations } from "../types";

export const zhCN: Translations = {
  chat: {
    header: {
      session: "main-session",
      home: "~/.helix",
    },
    conn: {
      connected: "已连接",
      connecting: "连接中",
      disconnected: "已断开",
      error: "连接失败",
    },
    banner: {
      reconnecting: "连接中断 · 自动重连中",
      reconnectAttempt: "第 {n} 次尝试",
      reconnectingAddr: "正在重新连接 daemon",
    },
    overlay: {
      connecting: "正在连接 daemon",
      addr: "{addr}",
    },
    error: {
      title: "无法连接 daemon",
      desc: "连接被拒绝，已自动重试 {n} 次。",
      retry: "重试连接",
      retryOk: "连接已建立",
      retryOkSub: "会话投影从 daemon 快照重建",
    },
    empty: {
      title: "等待第一条指令",
      suggest: {
        read: "读一下 packages/protocol 的结构",
        test: "跑一遍 workspace 测试",
        grep: "搜下握手相关的 TODO",
      },
    },
    composer: {
      placeholder: "输入消息，Enter 发送",
      placeholderConnecting: "正在建立连接…",
      placeholderWaiting: "等待连接恢复…",
      send: "发送",
      enterHint: "[[Enter]] 发送 · [[Shift+Enter]] 换行",
      projectionNote: "main-session · 会话投影由 daemon 快照重建",
    },
    steer: {
      hint: "主会话生成中 · 发送的消息进入 steer 队列，本轮结束后注入",
      queued: "STEER · 已入队",
      drained: "已注入 · 本轮结束",
    },
    restore: {
      toast: "会话已恢复",
      toastSub: "daemon 快照 + 增量事件重放 · {n} 条投影已重建",
    },
    msg: {
      you: "用户",
      agent: "主会话",
    },
    tool: {
      running: "执行中",
      done: "完成",
      error: "失败",
      args: "参数",
      result: "结果",
      resultFailed: "结果 · exit {code}",
    },
    sa: {
      card: {
        queued: "排队 #{n}",
        waiting: "等待空位 · 前方实例释放后自动出队",
        queueFoot: "FIFO 队列 · 位次随出队递减",
        running: "执行中 · {elapsed}",
        channelSub: "per-instance channel 订阅中",
        doneBadge: "closure · done",
        failedBadge: "failed",
        cancelledBadge: "cancelled",
        cancelledSub: "daemon 重启 · 排队任务收口",
        failedFoot: "closure failed 已注入主线下轮",
        injectedMain: "closure 已注入主线下轮 · {time}",
        injectedMainNoTime: "closure 已注入主线下轮",
        openDrawer: "实例全流 →",
      },
      spawn: {
        toast: "spawn 秒回",
        toastSub: "{id} · {profile} · 预算内立即执行",
      },
    },
    think: {
      streaming: "思考中",
      done: "已思考 {s}s · {n} tokens",
    },
    compact: {
      bar: "上下文已压缩 {before}→{after}",
      note: "保留尾部消息与 SubAgent 卡片状态 · 摘要调用 usage 已入账（见账目 popover compaction 行）",
    },
    stats: {
      badge: "{tokens} tok · ${cost}",
      popTitle: "会话账目 · 分实例",
      total: "{tokens} tok · ${cost}",
      footNote: "turn 完成时刷新 · 流式中账面冻结 · 含 compaction 摘要调用",
      cacheSub: "cache R {r} · W {w}",
      reasoningSub: "reasoning {n}",
      compactSub: "main {before}→{after}",
      mainRunning: "生成中",
      mainIdle: "空闲",
      kindMain: "主会话",
      kindSub: "SubAgent",
      kindCompact: "compaction",
    },
    drawer: {
      close: "关闭抽屉",
      task: "任务",
      channel: "channel · 实例全流",
      kill: "终止实例",
      killConfirm: "确认终止？",
      killedToast: "实例已终止",
      killedToastSub: "{id} · closure 将以 failed 注入主线下轮",
      stalled: "stalled · idle {dur}",
      stalledLc: "stalled · idle {dur} 无事件增量（警示不自动杀）",
      steerMark: "⇦ 主线 steer 注入",
      steerToast: "steer 已注入实例",
      steerToastSub: "{id} · 经 Agent.steer() 转投",
      steerOnlyRunning: "仅运行中实例可注入",
      steerOnlyRunningSub: "排队/终态实例无活动上下文",
      queuedHint: "排队中 · 空位释放后自动开始执行，channel 将在此展开",
      reportFoot: "任务报告经 daemon 单写队列落盘",
      instanceMeta: "spawn 由主线 agent_spawn 发起 · 事件挂 instanceId（AD-3 trace 四维）",
      slotDeclared: "profile.model 声明值",
      slotInherited: "profile.model 缺省继承主线",
      lc: {
        spawned: "spawned · {profile} · 单任务收敛 SOP",
        modelResolved: "模型解析 · {model}（{slot}）",
        crashed: "crashed · {error}",
        terminated: "terminated · 用户手动终止（终止权在用户，AD-7）",
      },
      closure: {
        title: "任务收敛",
      },
    },
    theme: {
      dark: "DARK",
      light: "LIGHT",
    },
    tsFormat: "HH:mm",
  },
};
