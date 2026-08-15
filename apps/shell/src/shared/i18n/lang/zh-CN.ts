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
    theme: {
      dark: "DARK",
      light: "LIGHT",
    },
    tsFormat: "HH:mm",
  },
};
