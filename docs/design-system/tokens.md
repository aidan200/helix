# helix Design Token Registry - Cyber HUD（双主题）

> 真源继承自 `helix-desk/src/shared/styles/cyber-hud.css`（暗色值原样钉死，不做自由发挥）。
> 本文是 helix 前端的**主题注册表（theme registry）**：全维度变量统一登记，同名变量双主题值对照，便于后期整体调整。
> 所有页面/组件的色值、字体、透明度、间距、圆角、阴影、动效时长必须从这里引用，禁止内联散落 hex。
> 可视化参照：`docs/design-system/style-board.html`（右上角 DARK/LIGHT 切换实测，文末含「主题注册表实时总览」区块）。

## 0. 总则与整体调整指南

### 总则

- **双主题**：暗色 = V1 定稿（`:root`，逐字节不动）；亮色 = V4 定稿（`html.light` 覆盖块：冷白底 + 蓝系 accent）。主题演进史见第 15 节。
- CSS 变量是唯一真源。Tailwind 颜色一律走 `rgb(var(--x-rgb) / <alpha-value>)` 通道变量模式，改色只改 CSS 变量。
- 字号用 7 档语义阶梯（`var(--text-*)` / tailwind `text-micro` 等），禁止写死 px/rem。
- 主题切换语义：`darkMode: "class"`，暗 = `:root` 默认（无类），亮 = `html.light` 覆盖。

### 整体调整指南（How to Theme）

- **改主题 = 只改某列值**：本 registry 每个变量一行、暗色/亮色双列对照。例如整体换 accent，只改第 05 节 `--accent / --accent-hover / --accent-rgb` 三行的目标列；派生变量（`--border / --border-strong / --bg-hover / --bg-selected / --glow-*` 引用通道变量的）自动跟随，无需另改。
- **新增主题 = 复制一列**：CSS 新增 `html.<theme>` 覆盖块（复制亮色列的写法），本文档各表加一列。
- **通道同步铁律**：改任何色值必须同步改同名 `-rgb` 通道变量（`--accent` 与 `--accent-rgb` 成对），否则所有 alpha 派生渲染不跟随。
- **亮色氛围降档原则**（V2 确立、V4 延续）：扫描线关闭、网格调淡、辉光 alpha 降档、blur 半径降档（见第 07 节）。
- 字号 / 间距 / 圆角 / 动效时长为跨主题共享维度（双列同值），改一处两主题同变。

## 1. 主题注册表

### 01 色彩 - 背景层

| 变量 | 暗色值（V1） | 亮色值（V4） | 用途 |
|---|---|---|---|
| `--void` | `#060910` | `#F8FAFC`（slate-50 冷白） | 最深底（窗口底色 / 启动屏，`THEME.void`） |
| `--void-rgb` | `6 9 16` | `248 250 252` | void 通道（card-fill 等派生引用） |
| `--bg` | `#0a0e16` | `#FFFFFF` | 页面底色（hud-page） |
| `--bg-elevated` | `#0f1521` | `#FFFFFF` | 抬升层底（亮色下靠边框 + 软投影分层） |

### 02 色彩 - 表面层

| 变量 | 暗色值（V1） | 亮色值（V4） | 用途 |
|---|---|---|---|
| `--panel-solid` | `#0B1120` | `#FFFFFF` | 实心面板底（气泡 / 浮层，区别于半透面板） |
| `--panel-solid-rgb` | `11 17 32` | `255 255 255` | 通道（assistant 气泡底 0.35 档引用） |
| `--bg-panel` | `rgba(15,21,33,0.4)` | `rgba(255,255,255,0.6)` | 半透玻璃面板（header / 代码块底） |
| `--card-fill` | `rgb(var(--void-rgb) / 0.32)` | `rgb(var(--void-rgb) / 0.75)` | 卡片填充（hud-card） |
| `--popover-fill` | `rgba(15,21,33,0.8)` | `rgba(255,255,255,0.92)` | 弹出层 0.8 档（下拉 / 抽屉 / 瞬时浮层，压住下层） |
| `--glass-fill` | `rgba(15,21,33,0)` | `rgba(255,255,255,0)` | 毛玻璃填充（全透明，靠 blur 成像） |
| `--bg-hover` | `rgb(var(--accent-rgb) / 0.08)` | 同左（派生自动跟随） | 列表 hover 底 |
| `--bg-selected` | `rgb(var(--accent-rgb) / 0.12)` | 同左（派生自动跟随） | 选中底 |

### 03 色彩 - 边线

| 变量 | 暗色值（V1） | 亮色值（V4） | 用途 |
|---|---|---|---|
| `--border` | `rgb(var(--accent-rgb) / 0.15)` | 同左（派生自动跟随） | 常规边框（accent 派生） |
| `--border-strong` | `rgb(var(--accent-rgb) / 0.35)` | 同左（派生自动跟随） | hover / 强调边框 |
| `--edge-rgb` | `255 255 255` | `15 23 42`（slate-900 通道） | 中性边线（描边 / 分隔线 / 弱徽标底），配 0.06-0.12 alpha 档；亮色下渲染出 slate-200/300 级（约 `#E2E8F0` / `#CBD5E1`）边线层次 |

### 04 色彩 - 文字四档

| 变量 | 暗色值（V1） | 亮色值（V4） | 用途 |
|---|---|---|---|
| `--text` | `#E2E8F0`（slate-200） | `#0F172A`（slate-900） | 主文字 |
| `--text-rgb` | `226 232 240` | `15 23 42` | 主文字通道 |
| `--text-muted` | `#94A3B8`（slate-400） | `#475569`（slate-600） | 次要文字 |
| `--text-muted-rgb` | `148 163 184` | `71 85 105` | 次要文字通道 |
| `--text-dim` | `#64748B`（slate-500） | `#64748B`（slate-500，双主题同值） | 说明 / 辅助（输入 placeholder、hud-label） |
| `--text-dim-rgb` | `100 116 139` | `100 116 139` | 同值 |
| `--text-faint` | `#475569`（slate-600） | `#94A3B8`（slate-400） | 痕迹文字（时间戳 / var 名标注；弱化档，豁免 AA） |
| `--text-faint-rgb` | `71 85 105` | `148 163 184` | 痕迹文字通道 |

镜像关系：暗 muted（`#94A3B8`）= 亮 faint、暗 faint（`#475569`）= 亮 muted、dim 两主题同值。同一套 slate 色阶明暗互用，切换主题 = 明度换挡。

### 05 色彩 - 品牌与状态

| 变量 | 暗色值（V1） | 亮色值（V4） | 用途 |
|---|---|---|---|
| `--accent` | `#22D3EE`（cyan-400，hue 187.9°） | `#2563EB`（blue-600，hue 221.2°） | **主色**。聚焦边框、主按钮文字、HUD 角标、SectionLabel、状态点 |
| `--accent-rgb` | `34 211 238` | `37 99 235` | 主色通道（全部 alpha 派生引用） |
| `--accent-hover` | `#67E8F9`（cyan-300） | `#1D4ED8`（blue-700） | 主色 hover 档（暗 = 提亮，亮 = 加深） |
| `--violet` | `#A855F7`（purple-500，hue 270.7°） | `#9333EA`（purple-600，hue 271.5°） | 副强调（用户消息、Agent 角色、第二操作） |
| `--violet-rgb` | `168 85 247` | `147 51 234` | 副强调通道 |
| `--search` | `#F97316`（orange-500） | `#EA580C`（orange-600） | 搜索高亮专用功能色（调色板外，不做装饰；背景用途，正文 AA 豁免） |
| `--search-rgb` | `249 115 22` | `234 88 12` | 通道 |
| `--success` | `#34D399`（emerald-400，hue 158.1°） | `#15803D`（green-700，hue 142.4°） | 成功徽标 / 完成态工具卡 / ok 状态点 |
| `--success-rgb` | `52 211 153` | `21 128 61` | 通道 |
| `--warning` | `#FBBF24`（amber-400，hue 43.3°） | `#B45309`（amber-700，hue 26.0°） | 降级 / 警告 |
| `--warning-rgb` | `251 191 36` | `180 83 9` | 通道 |
| `--error` | `#F87171`（red-400，hue 0°） | `#B91C1C`（red-700，hue 0°） | 失败徽标 / 错误态边框（40%）/ danger 按钮 |
| `--error-rgb` | `248 113 113` | `185 28 28` | 通道 |

**V4 色相距离红线论证**（详算见迭代报告 V4 节）：accent blue-600（221.2°）与 success green-700（142.4°）轴距 **78.8°**、与绿色语义域上边界（160°）距离 **61.2°**，双口径 ≥60° 达标。对比 V2 失败组合（cyan-700 与绿域边界仅 32.9°），根因消除。状态色微调原则：色相语义不变（红/绿/黄），仅明度加深适配白底。

### 06 字体（跨主题同值）

| 变量 / 档位 | 暗色值 | 亮色值 | 用途 |
|---|---|---|---|
| `--font-mono` | `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace` | 同 | HUD 主字体（按钮 / 徽标 / 标签 / 代码 / 输入框全部 mono） |
| `--font-sans` | `"Inter", ui-sans-serif, system-ui, sans-serif` | 同 | 长正文可读性补充 |
| `--text-micro` | 10px | 同 | 徽章 / 角标 / 超小标签 |
| `--text-cap` | 11px | 同 | 说明文字 / 元信息 / section-label |
| `--text-body` | 12px | 同 | 列表 / 次要正文（主力档） |
| `--text-main` | 13px | 同 | 主正文 / 代码 |
| `--text-title` | 15px | 同 | 面板标题 / 强调行 |
| `--text-head` | 16px | 同 | 页面级标题 |
| `--text-stat` | 20px | 同 | 统计大数字（NumberTicker） |
| weight 约定 | 400 正文 / 500 标签徽标 / 600 标题强调 / 700 stat 与 avatar 字符 | 同 | mono 全档覆盖 |

Tailwind 映射：`text-micro / text-cap / text-body / text-main / text-title / text-head / text-stat`（extend fontSize，引用 `var(--text-*)`）。

### 07 透明度与 alpha 档

| 档位场景 | 暗色 | 亮色 | 载体 / 说明 |
|---|---|---|---|
| 玻璃面板底 | 0.4 | 0.6 | `--bg-panel`（亮色白底压住底纹） |
| 卡片填充 | 0.32 | 0.75 | `--card-fill`（亮色白卡浮起） |
| 弹出层 | 0.8 | 0.92 | `--popover-fill` |
| 毛玻璃填充 | 0 | 0 | `--glass-fill`（全透明靠 blur 成像） |
| 列表 hover / 选中 | 0.08 / 0.12 | 同 | `--bg-hover / --bg-selected`（accent 派生） |
| 常规 / 强调边框 | 0.15 / 0.35 | 同 | `--border / --border-strong`（accent 派生） |
| 中性边线（edge） | 0.06-0.12 | 同 | 描边 / 分隔 / 弱徽标底（edge-rgb 派生） |
| 徽标底 / 徽标边 | 0.08-0.1 / 0.3-0.4 | 同 | hud-badge 组件类 |
| 头像 / 气泡底 | 0.1 / 0.06 | 同 | avatar、user 气泡（violet 派生） |
| 辉光 ring / 弥散 | 0.25 / 0.18 | **0.20 / 0.10** | `--glow-*`（亮色降档） |
| 蓝图网格线 | 0.14 | **0.045-0.06** | GridPattern / body 亮色底纹（亮色调淡） |
| 扫描线 | 0.025（常驻） | **关闭** | 氛围层（亮色隐藏） |
| glass blur 半径 | 6px | **4px** | `.glass` |
| popover blur 半径 | 14px | **10px** | `.hud-popover` |

### 08 间距（跨主题同值）

4px 基数（Tailwind 默认刻度照用）。约定节奏：

- 组件内间隙：`gap-2`（8px）/ `gap-3`（12px）
- 卡片 padding：`p-4`（16px）
- 区块间：`gap-4` / `gap-5`（16/20px）
- 页面留白：`px-5 py-4`（20/16px）起步，版心 `max-w-[1400px]`
- 按钮高度 32px，徽标 padding `2px 8px`，chip padding `1px 6px`

### 09 圆角（跨主题同值）

| 值 | Tailwind | 用途 |
|---|---|---|
| 4px | rounded-sm | 徽标、工具卡小图标 |
| 5px | - | 代码块 |
| 6px | rounded-md | 按钮、输入框、头像 |
| 8px | rounded-lg | 消息气泡（user 右上角 2px / assistant 左上角 2px 变体）、工具调用卡 |
| 10px | rounded-[10px] | pixel-card |
| 12px | rounded-xl | hud-card、hud-modal |
| 999px | rounded-full | chip、状态点 |

### 10 阴影与辉光

| 变量 / 场景 | 暗色值（V1） | 亮色值（V4） | 用途 |
|---|---|---|---|
| `--glow-cyan` | `0 0 0 1px rgb(var(--accent-rgb)/0.25), 0 0 18px rgb(var(--accent-rgb)/0.18)` | `0 0 0 1px rgb(var(--accent-rgb)/0.2), 0 0 18px rgb(var(--accent-rgb)/0.1)` | 主色辉光（focus / hover 卡 / assistant 头像）；亮色 alpha 降档 |
| `--glow-violet` | `0 0 0 1px rgb(var(--violet-rgb)/0.25), 0 0 18px rgb(var(--violet-rgb)/0.18)` | `0 0 0 1px rgb(var(--violet-rgb)/0.2), 0 0 18px rgb(var(--violet-rgb)/0.1)` | 副强调辉光；亮色降档 |
| `--shadow-inset-hud` | `inset 0 1px 0 rgba(255,255,255,0.04), inset 0 0 24px rgba(2,6,16,0.6)` | `inset 0 1px 0 rgba(255,255,255,0.9), inset 0 0 24px rgba(15,23,42,0.05)` | HUD 面板内嵌氛围（亮色：顶部高光 + 极淡 slate 内晕） |
| hud-card 静态投影 | 无（暗色靠辉光分层） | `0 1px 3px rgba(15,23,42,0.06)` | 亮色靠软投影分层 |
| hud-popover 投影 | 无（0.8 实底自带压制） | `0 8px 24px rgba(15,23,42,0.12)` | 亮色浮层投影 |

### 11 动效时长（跨主题同值，registry 登记 + 后续升变量约定）

| 场景 | 值 | 动机 |
|---|---|---|
| 组件过渡（bg / border / glow） | 0.15s | hud-btn / hud-input / 主题切换按钮 |
| 卡片边框过渡 | 0.2s | hud-card hover |
| StatusDot pulse | 2s ease-in-out | 运行态心跳 |
| beam-sweep 输入光束 | 4s linear | 输入焦点引导 |
| shimmer 扫光 | 3.5s linear | ShimmerButton |
| BorderBeam 环绕 | 6s linear | 聚焦引导 |
| 空态呼吸 | 4s ease-in-out | awaiting 文案 |
| 光标闪烁 | 1.1s steps(1) | empty cursor |
| NumberTicker 滚入 | 1.4s（JS easeOut cubic） | 统计数字进入 |
| PixelCard 溶解 | 900ms | hover 反馈 |
| DNA 双螺旋 | 900ms 周期 | loading 持续态 |

全部动效 honor `prefers-reduced-motion`。值目前登记于文档（组件 CSS/JS 内联），后续实现侧可升级为 `--dur-*` 变量族（WKWebView 场景注意：延迟等参数在组件端预计算，不在 `animation` 简写里内嵌 `var()`/`calc()`）。

## 12. Dial 档位

| Dial | 档位 | 理由 |
|---|---|---|
| **DESIGN_VARIANCE** | **低（3/10）** | 开发者工作台，一致性 > 布局花样。聊天页是结构性重复的信息流（消息 / 工具卡 / 输入区），HUD 个性全部来自氛围层（辉光 / 扫描线 / 网格 / 角标）而非不对称布局。 |
| **MOTION_INTENSITY** | **中（5/10）** | 动效全部功能动机：StatusDot pulse = 运行态、beam-sweep = 输入焦点、BorderBeam = 聚焦引导、PixelCard 溶解 = hover 反馈、log-rise = 新消息进入、subagent-enter/exit = 卡片进出。无装饰性大动效；全部 honor `prefers-reduced-motion`。 |
| **VISUAL_DENSITY** | **中高（7/10）** | 终端式工作台：主力字号 12-13px、按钮 32px、徽标 10px、mono 主导、信息密度高；用 16-20px 区块间距保持呼吸，避免压迫。 |

## 13. Design System 选择记录

**裁决：自研 Cyber HUD（Tailwind v3 + CSS 变量 token + 原子组件自持有 + Magic UI 特效组件 copy-in）。不引入 shadcn。**

- **Tailwind v3**（颜色经 `rgb(var(--x-rgb) / <alpha-value>)` 通道变量引用真源）。双主题：`darkMode: "class"`，暗 = `:root` 默认、亮 = `html.light` 覆盖（V4 恢复双主题切换语义）。注意 desk 配置 `corePlugins: { preflight: false }`，helix 沿用时需保留自定义 reset。
- **原子组件自持有**（helix 对应 `shared/ui/hud/`）：Panel、HudCorners、SectionLabel、StatusDot（+ cyber-hud.css 组件类：hud-btn / hud-badge / hud-chip / hud-input / hud-card / hud-code / hud-empty / hud-dot / hud-popover / hud-state-overlay）。
- **Magic UI 5 件 copy-in**（`shared/ui/magicui/`，适配 TW v3）：BorderBeam、GridPattern、MagicCard、NumberTicker、ShimmerButton。
- **react-bits 移植**：PixelCard（canvas 像素溶解）。
- **自有组件**：LoadingIndicator（DNA 双螺旋）、Toast。
- 动效库：motion（`motion/react`）；tailwind keyframes 登记：shimmer-slide / spin-around / pulse-ring / log-rise / beam-sweep / subagent-enter / subagent-exit。
- 字体例外说明：Inter 属 skill 不鼓励的 AI 默认字体，但本项目为**既有风格裁决继承**（desk 已定 Inter + JetBrains Mono，mono 主导），一致性优先。
- 前端实现需要主题分支：`html.light` 覆盖块 + 主题切换控件 + 主题持久化（localStorage）。氛围层按主题开关（扫描线亮色隐藏、网格调淡、辉光降档）。

## 14. 聊天页组件形态契约（首迭代直接引用）

- **用户气泡**：`rounded-lg` + 右上角 2px 小角；边框 `cyber-violet/20`，底 `cyber-violet/[0.06]`；28px violet 描边头像。
- **助手气泡**：`rounded-lg` + 左上角 2px 小角；边框 `cyber-cyan/20`，底 `panelSolid/35`；28px cyan 头像 + glow-cyan。
- **工具调用卡**：全宽 `rounded-lg`，底 `void/40`；三态边框：running `cyan/30`（+ 脉冲点）/ done `ok/25`（+ done 徽标）/ error `err/40`；头部 20px 方图标格 + mono 名 + 参数省略行；参数 / 结果用 `pre` 块（`cyan/15` 边 + `void/60` 底 + text-body）。
- **输入区**：`hud-input` 风格复合条（`cyan/20` 边 + `void/50` 底 + 内置 SEND 按钮）。
- **空态**：`hud-empty` + 呼吸文案 + violet 方块光标闪烁。

组件契约描述用暗色语境的语义名（cyan = accent 槽位、violet = 副强调槽位），亮色主题下同名变量渲染 V4 值（accent = blue-600），形态契约不变。

## 15. 主题决策史（V1 亮色 → V2 亮色 → V3 dark-only → V4 双主题）

### 决策链

1. **V1 磷绿撞色版**（继承 desk 方向 C：暖米底 `#F4F2EC` + 磷绿 accent `#047857`）：用户实测反馈「亮色版本不舒服、撞色」，诊断三因：色温打架（暖底配冷强调）/ 品牌色断裂（暗色 cyan 与亮色磷绿不同族）/ 无主导色（绿紫绯红三高饱和 hue 并列）→ 否决。
2. **V2 cyan 明度反转版**（`#0E7490` 深青 accent + 冷白 slate 底）：用户实测后 accent 深青与执行状态绿在浅底上色相认知混淆，主色与状态色难以区分 → 否决。量化复盘：cyan-700（hue 192.9°）本质是蓝绿混合（G/B 占比 0.81），明度压低后绿分量感知上升；与绿色语义域上边界（160°）仅隔 32.9°，低 alpha 徽标渲染下双方向灰绿收敛。
3. **V3 dark-only 裁决**：两轮亮色尝试均不满意，暂定暗色为唯一主题，亮色延后。
4. **V4 双主题定稿（当前生效，2026-08-15 用户指示）**：亮色现在就做新版 + 统一主题变量提取（本 registry）。设计红线：① accent 与执行状态绿拉开色相距离（hue 差 ≥60°）② 冷白底禁暖色混入。

### V4 定稿值与红线应答

- **accent = blue-600 `#2563EB`（hue 221.2°）**，hover blue-700 `#1D4ED8`。用户推荐方向「sky-600 或同级蓝」的取舍：sky-600（200.4°）与 green-700 轴距 58.0°、与绿域边界距 40.4°，双口径均不达 60° 红线；blue-600 轴距 78.8°、域边界距 61.2°，双口径达标。品牌连续性让步说明：与暗色 cyan-400（187.9°）hue 差 33.3°，仍在蓝青大族（180°-250°）内，切主题读作同族深浅两档。
- **success = green-700 `#15803D`（hue 142.4°）**：从 V1/V2 的 lime-600（84.8° 黄绿）收正绿。emerald-600（161.4°）与 blue-600 轴距 59.8° 差临门一脚且白底对比度不足（约 3.9:1），green-700 双达标（78.8° + 5.02:1）。色相语义仍为绿色（emerald 轴 158° → green 轴 142°，同语义域内微调）。
- **底色系**：void `#F8FAFC` / bg、elevated、panel-solid `#FFFFFF`（冷白家族，零暖色，V1 暖米病根不复发）。
- **文字四档 / edge**：slate 冷墨四档（V2 值保留，未被否决部分）+ edge-rgb `15 23 42`。
- **violet = purple-600 `#9333EA`**：与暗色 purple-500 hue 差仅 0.8°（真同族明度反转），与 blue-600 主副差 50.3°（可区分）。
- **warning / error**：amber-700 `#B45309` / red-700 `#B91C1C`，色相语义不变、明度加深适配白底（red 两主题 hue 完全同轴 0°；error 由 red-600 加深至 red-700，因红色徽标自带 tint 底，red-600 在底上仅 4.13:1，red-700 拉到 5.5:1）。
- **氛围降档**：扫描线关、网格淡（0.045-0.06）、辉光 alpha 降档（0.25/0.18 → 0.20/0.10）、blur 半径降档（6→4px / 14→10px）、亮色组件靠软投影分层。

### V1/V2 亮色值废弃声明

V1（磷绿暖底）与 V2（cyan-700 深青）两版亮色值均已废弃，实现不得引用（V4 为唯一有效亮色契约）。V2 的冷白底色家族与 slate 文字四档经论证合格，被 V4 继承（继承的仅此两族，见 01/04 节）。
