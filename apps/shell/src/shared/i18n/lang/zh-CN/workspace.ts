/** zh-CN 词条分片：workspace 域（barrel 见 ../zh-CN.ts）。
 *
 * 业务域分片重构（体量门）：本文件是该域词条的唯一定义处，键/值/嵌套
 * 结构与批次溯源注释自原 zh-CN.ts 原样迁移（零改写）。
 */
export const workspace = {
  // ── workspace 门禁（W3 选择页 + connecting 占位；设计稿 §2.2）──
  workspace: {
    gate: {
      title: "选择工作空间",
      subtitle: "为本次会话选择一个工作区根目录，helix 将在该目录下管理项目与知识。",
      recentsTitle: "最近使用",
      recentsAriaLabel: "最近使用的工作空间",
      invalid: "已失效",
      lastUsedAt: "上次使用 {time}",
      inputTitle: "输入路径",
      pathPlaceholder: "/path/to/workspace",
      browse: "浏览…",
      browseErrorTitle: "目录选择失败",
      open: "打开",
      opening: "打开中…",
      cancelSwitch: "取消，返回主界面",
      error: {
        invalidRoot: "路径无效：目录不存在、不是目录、不可读，或为危险根（文件系统根/主目录）。",
        activeAgent: "存在运行中的智能体，暂时不能切换工作空间。",
        sendFailed: "发送失败：与 daemon 的连接不可用，请稍后重试。",
        generic: "打开工作空间失败，请检查路径后重试。",
      },
    },
    boot: {
      errorTitle: "无法连接 daemon",
      errorSub: "请确认 daemon 已启动，或点击重试。",
      retry: "重试连接",
    },
    // ── 主壳指示器（W4；设计稿 §2.3 top-bar）──
    indicator: {
      label: "工作空间：{name}",
      busyTitle: "有智能体运行中，暂不能切换工作空间（{path}）",
    },
    // ── 设置页分区（W4；设计稿 §2.3）──
    settings: {
      currentLabel: "当前绑定",
      unbound: "未绑定",
      switchAction: "切换工作空间",
      busyNote: "存在运行中的会话/智能体，请先等待收尾或中止后再切换工作空间。",
    },
  },
};
