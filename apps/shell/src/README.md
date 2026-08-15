# apps/shell/src/ — 前端源码（FSD 五层，W7/CL-7 落地）

P-1 主会话聊天页（唯一页面）：React 18 + vite + Tailwind v3（preflight 关闭，
自研 Cyber HUD 组件类）。

```
app/                     入口组装（providers × ChatPage；main.tsx 挂载）
pages/chat/              页面组装件（header / conn-banner / overlay + ChatPage）
widgets/chat-stream/     消息流（MessageFlow / MessageBubble / ToolCard /
                         MarkdownMessage / SessionEmpty）
features/
  send-message/          Composer（发送/steer 分流、草稿、禁用规则）
  reconnect/             ErrorCard（失败卡 + 手动重试）
entities/session/        会话投影 reducer（纯函数，AD-16）+ SessionContext 接线
shared/
  api/                   HelixWsClient（token fetch + 握手 + 重连退避 +
                         transport 注入点 = M3 mock 挂点）
  ui/                    styles/（tokens.css + app.css）、theme、Toast
  config/                env（端口/地址派生）、theme（THEME_VAR）
  lib/                   cn、format
  i18n/                  轻量 i18n（context + zh-CN/en-US 词条包）
tests/                   AG 架构守护扫描（AG-13/14/15/16 前端半）
```

- 协议类型唯一来源 `@helix/protocol`（vite 经 resolve.alias 接线，AG-13）；
- 视觉唯一真源 `helix/docs/design-system/tokens.md` → `shared/ui/styles/tokens.css`
  （暗 `:root` 默认 + 亮 `html.light`，`rgb(var(--x-rgb)/α)` 通道模式）；
- 测试：根目录 `bunx vitest run apps/shell`（reducer 纯投影 / WS 客户端 / i18n / AG 扫描）。
