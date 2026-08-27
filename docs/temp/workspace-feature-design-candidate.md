# 设计：workspace 选择门禁与绑定闭环

> 状态：设计稿 v2（完整需求版，2026-08-27）。取代同文件早期"设计候选"，
> 供迭代立项切片。分叉点 F1~F4 待裁决后定稿。
> 由来：dev 形态 cwd 漂移事故（pid 占用重启循环）→ step1 止血（wrapper
> cd，commit 85eb866/34dcd0e/58de25e）→ 本设计为产品化根治。

## 0. 基础逻辑（第一原则）

**workspace 必须显式指定；没有时让用户选，零静默猜测。**

- 不存在"推导出来的 workspace"（home/父目录/仓库根/cwd 都不可作缺省）；
- 打包安装形态无终端、无 env——**唯一可用通道是 UI 门禁 + WS RPC +
  daemon 持久化**，与 dev/CLI 形态同一代码路径；
- 猜出来的 workspace 不是"能用"，是"错着用"（事故实证）。

## 1. 用户流程（闭环）

```
应用启动
 └─ 壳 spawn daemon（无 argv/env 变更）→ ready → 前端加载
      └─ WS 连接（重连退避，TR-AD-12 既有机制）
           └─ workspace.get（门禁判定）
                ├─ bound（含重启后自动恢复的持久化 current）
                │    └─ 主壳（五页签 + workspace 指示器）
                │         └─ 切换入口 → 选择页（可取消返回）
                └─ null（首次启动 / current 校验失败降级）
                     └─ 【新增】选择工作空间页
                          ├─ recents 列表（最近使用，可点选）
                          ├─ 路径输入（+ F3：原生目录浏览）
                          └─ workspace.open {root}
                               ├─ 校验失败 → 行内错误（见 §3.3）
                               └─ 成功 → 持久化(current+recents)
                                    → kg 栈惰性重建 → workspace_changed 广播
                                    → 进主壳
```

降级路径（闭环完整性）：恢复时 current 指向的目录已删除/不可读 →
视为未绑定进选择页，**带一行说明**（"上次的工作空间已不可用：…"），
recents 中该项标记失效（不自动删除，用户可重选或换）。

## 2. 前端设计（apps/shell，FSD）

### 2.1 启动门禁状态机

位置：`SessionProvider`（连接就绪）与主壳（AppLayout/IconRail+五页签）
之间——**门禁是前端状态，不是壳职责**（TR-AD-4：壳零业务逻辑，
业务路由归前端+daemon）。

```
boot → connecting → workspace.get ─→ bound   → <AppRoutes/>（现五页签）
                          │
                          └→ null → <WorkspaceGatePage/>
```

- gate 状态放 `entities/workspace`（新）：`{ phase: "connecting"|"gate"|"main",
  current: string|null, recents: WorkspaceRecent[], notice?: string }`；
- 现有连接失败/重连 UI（features/reconnect ErrorCard）不动——门禁在
  连接成功后才分流，连接层零改动。

### 2.2 新增页面：选择工作空间页（`pages/workspace/WorkspaceGatePage`）

- **recents 区**：MRU 列表（名称=basename、路径、上次使用时间；失效项
  置灰带原因），点击即 open；
- **输入区**：路径输入框 + 确认；行内校验态（不存在/不是目录/不可读/
  危险根——错误文案来自 daemon 返回，前端不重复实现校验）；
- **F3（裁决后）**：原生目录浏览按钮（壳 IPC `pick_directory`，见 §6）；
- 页面无导航逃逸（门禁语义：不选不进主壳）；i18n 文案键全量登记。

### 2.3 主壳增量

- top-bar 增 workspace 指示器（basename + tooltip 全路径）；
- 设置页增"工作空间"分区：当前绑定 + 切换按钮（路由回选择页，带
  取消）；切换成功广播后各页签自行刷新（项目域/kg 面重取数）。

## 3. daemon RPC 面（protocol 包契约 + handlers）

### 3.1 命令与事件

```
workspace.get  {} → { current: { root } | null,
                      recents: WorkspaceRecent[],   // MRU，上限 8
                      notice?: string }             // 降级说明（恢复失败等）
workspace.open { root: string } → { root, projects: ProjectEntry[] }
事件 workspace_changed { root } —— 广播，前端各域刷新依据
```

无 close/unbind 命令（v1）：切换 = open 另一个 root；"回选择页"是前端
路由行为，daemon 保持绑定直到下次 open。

### 3.2 绑定语义与未绑定态

- daemon 启动 = **未绑定态**（desktop/sidecar 形态）；恢复持久化 current
  成功 = 已绑定；
- 未绑定态：kg 面/项目域 RPC 返回空集 + `workspace_unbound` 语义标记
  （非报错——门禁前端本就不发这些请求，此为防御性契约）；**会话创建
  依赖绑定**（toolCwd 基准 = 绑定 root，未绑定拒绝创建并指引选择）；
- open 幂等：同 root 重复 open = no-op（仍广播一次 changed 供前端对齐）；
  open 不同 root = 状态重建（kg 栈 dispose + 惰性重扫，复用 shutdown 的
  per-project dispose 语义）；
- **CLI 例外条款**：CLI 形态 cwd 即用户显式选择（终端站位=选择），
  启动时等价于已 open(cwd)——写进契约防误读为"cwd 缺省回潮"。

### 3.3 校验规则（daemon 单点，前端只显示）

1. realpath 规范化（消 symlink 双写：/tmp vs /private/tmp 实证过）；
2. 存在且为目录且可读（stat + 读探测）；
3. **危险根拒绝**：root === 文件系统根 / === $HOME → 拒绝并说明
   （扫描面失控；引导选具体工作区目录）；
4. recents 中失效项在 get 时惰性探测标记（不自动删除）。

## 4. 持久化（daemon 是唯一事实源）

- 落点：`helix.db` runtime_config KV 表（`workspace.current` /
  `workspace.recents`）——**不新增状态文件**（TR-AD-6 路径面零扩），
  走 WriteQueue 唯一写通道（AG-06），与 default_model 同模式先例；
- 写时机：每次 open 成功（current + recents MRU 去重，上限 8）；
- 恢复时机：daemon 启动读 KV → 校验（§3.3）→ 通过则绑定，失败则
  未绑定 + notice；
- 前端不持久化 workspace（可缓存 last-known 供瞬时绘制，权威恒查
  daemon——多端一致）。

## 5. kg 栈与绑定生命周期（F5 的消解）

- 物化（per-project schema 库创建）从 **boot** 移到 **open 之后**：
  未绑定的 daemon 什么都不建；绑定 = 用户显式选择了容器，一级目录
  建库自带授权语义——事故根源（boot 盲扫）自然消解；
- open 状态重建 = dispose 全部 per-project 连接 → 重扫 → 惰性重连
  （读面不建库口径不变：已建库项目可见，写面按需建）。

## 6. 分叉点（立项裁决）

- **F1 单活 vs 多 workspace 并存**：v1 单活（P-1 单窗口）；RPC 按绑定
  建模（workspaceId 预留位），多窗口时单值扩 map 不破坏调用面。
- **F2 切换时运行中 agent**：禁止切换（有活跃 agent 时入口置灰 +
  说明）v 收尾后切 v 按 workspace 隔离。建议 v1 禁止（最简、无数据
  一致性问题），产品规则进契约。
- **F3 原生目录浏览**：需要壳 IPC `pick_directory`（Tauri dialog）。
  边界论证：目录选择是窗口/原生 UX 能力（同窗口管理职责族），壳只
  返回路径字符串、零业务解析（TR-AD-4 不破）。v1 可先纯输入框。
- **F4 TR-AD-6 补款**：cwd 条款收窄为"CLI 形态来源"；desktop/sidecar
  形态 workspace 恒经绑定，无 cwd 兼容缺省。sidecar-lifecycle 契约
  §1 零变更（本设计零 argv/env 面——全部走 WS）。

## 7. 迁移与兼容

- **零 spawn 面变更**：argv/env/AG-08 全不动；已装用户升级 = 下次启动
  未绑定 → 选一次 → 持久化（一次性引导成本）；
- **step1 退役路径**：本设计落地后，dev-desktop 的 workspace 旋钮
  （HELIX_DESKTOP_WORKSPACE_ROOT/TTY）从"必需"降级为"可选预绑定"——
  e2e/CI 无头场景仍用它跳过交互门禁（保留价值），交互开发走前端门禁；
- CLI 形态行为不变（cwd 例外条款）。

## 8. 测试策略

- daemon 单元：校验规则全分支（含危险根/realpath/失效 recents）、
  KV 读写、open 幂等、未绑定态防御契约；
- daemon 集成：open → kg 重扫 → 项目域来自新 root；恢复成功/失败
  两分支；绑定后 toolCwd 基准正确；
- protocol 契约：RPC schema 登记（workspace 族三面）；
- 前端：门禁状态机（mock WS）、选择页组件（recents/校验态/失效项）、
  切换流程；e2e：首启→选→主壳；重启→自动恢复直进主壳；恢复失败
  →选择页带 notice。

## 9. 任务切片建议（供立项）

| 切片 | 内容 | 层 |
|------|------|----|
| W1 | protocol 契约 + daemon workspace 状态机/校验/KV | daemon |
| W2 | kg 栈 open 重建 + 未绑定态防御 + 物化时机迁移 | daemon |
| W3 | 前端 entities/workspace + 门禁状态机 + 选择页 | shell |
| W4 | 主壳指示器/设置分区/切换流 + workspace_changed 刷新链 | shell |
| W5 | dev-desktop 旋钮降级 + e2e 预绑定通道 + F1~F3 裁决落契 | 工程面 |

---

## 10. 落地记录（2026-08-27，W1~W5 同列车）

| 切片 | commit | 内容 |
|------|--------|------|
| W1 | b211978 + 289beb4(W1F) | protocol 三面 + WorkspaceService + 持有者接缝重绑 + 未绑定态 + CLI 例外 + 物化迁移 + 评审修复（resolveToolCwd 接线/SubagentLauncher 现值化/bind 半途态等 7 项） |
| W3 | c4ecd32 | entities/workspace 三相门禁 + App 门禁分支 + WorkspaceGatePage + dispatcher W3 豁免清理 |
| W4 | 158c109 | 重绑卸载旧会话（评审必清债）+ top-bar 指示器 + 设置分区 + 切换流（首启无逃逸钉住）+ changed 刷新链 |
| W5 | 7a7ffd8 | dev-desktop 旋钮降级可选预绑定（WS hello/open）+ TTY prompt 删除 + AG-17 守卫扩白 |

**裁决落定**：F1 单活（扩展位注释）；F2 有活跃 agent 双层拦截（UI 禁用 + daemon open 门禁）；
F3 纯输入框；F4 TR-AD-6 cwd 条款收窄为 CLI 形态来源（sidecar 恒经 WS 绑定）。

**实现裁量（与设计稿字面的偏差，均已测试钉住）**：
- 参数型 kg 命令未绑定回 `workspace.unbound` 错误帧（kg.projects/list 空集口径不变）
- 首绑不卸装配期会话（CLI 恢复连续性权衡；重绑恒卸载）
- WorkspaceService.dispose 清 current（shutdown 专用契约）
- ErrorCode 混排（workspace.unbound 小写 vs WORKSPACE_E_*）保留待统一

**合并约束（评审裁定）**：W1..W5 同列车合入；W1 单独进桌面发布线会使 sidecar
恒未绑定+会话全拒。**合并列车已执行**（本记录同批）。

**验证基线**：daemon 1226 / protocol 97 / shell 607+ / typecheck 四包；实机无 env
未绑定态起跑 0 杀壳重建（daemon cwd=src-tauri 亦无害——结构性消解）；F4.2 预绑定
全链冒烟（真 WS hello→open→get 回执 + 两轮零残留）。
