/**
 * AppLayout 统一应用壳（S1 应用壳统一；后续任务依赖的核心布局契约）。
 *
 * 结构契约：`.app-layout`（100dvh flex column，自身不滚）→ `<header
 * className="app-header">`（48px 全宽置顶，复用既有视觉；headerLeft …
 * 弹性 spacer（.header-right margin-left:auto）… headerRight）→
 * `.layout-body`（flex row，min-height:0）→ sidebar 槽（可省）+
 * `<main className="layout-main">`（flex:1，min-width:0，唯一滚动容器——
 * 页面滚动只发生在此）。根元素 position:relative（承接原 .workbench 的
 * absolute 定位上下文职责，供浮层挂靠）。
 *
 * 纯展示纪律（TR-AD-8）：组件只负责布局，不感知槽内容语义、不读 store。
 * chat 页用法见 pages/chat/ui/P-1-workbench；trace/settings 等页由后续
 * 任务迁入。
 */
import type { ReactNode } from "react";

export interface AppLayoutProps {
  /** 页面标题槽（chat：会话标题+chips；其他页：页名） */
  headerLeft?: ReactNode;
  /** 页面动作槽（chat：StatsBadge+模型徽章+连接状态；可为空） */
  headerRight?: ReactNode;
  /** 可选左栏槽。本次仅 chat 使用；组件侧只负责布局，不感知内容语义 */
  sidebar?: ReactNode;
  /** 主区内容（.layout-main 是唯一滚动容器） */
  children: ReactNode;
}

const AppLayout = function AppLayout({ headerLeft, headerRight, sidebar, children }: AppLayoutProps) {
  return (
    <div className="app-layout">
      <header className="app-header">
        {headerLeft}
        {headerRight !== undefined && <div className="header-right">{headerRight}</div>}
      </header>
      <div className="layout-body">
        {sidebar}
        <main className="layout-main">{children}</main>
      </div>
    </div>
  );
};

export default AppLayout;
