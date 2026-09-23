/**
 * shared/api —— 壳原生能力 seam（W6a 原生目录选择；F3 裁决）。
 *
 * 壳（src-tauri）经 initialization_script 在页面脚本前挂
 * `window.helixPickDirectory`（内部走 tauri-plugin-dialog 的目录选择，
 * 平台差异由插件消化：macOS NSOpenPanel / Windows IFileOpenDialog / Linux
 * GTK）。本 seam 是前端唯一访问点——受控 `globalThis` 访问，探测 + 调用
 * 两函数；零 Tauri 内部形态词（AG-17：该字样只许在 Rust 源码字符串里），
 * 纯浏览器 dev 无此挂载点 → hasNativePicker()=false，调用面自然降级。
 *
 * 路径零变换透传（W6a 验收 4）：选中返回的是平台原生路径串（Windows 反斜杠
 * 等），本 seam 与消费面一律透传——禁斜杠转换/拼接/规范化，realpath/校验
 * 由 daemon 侧 workspace.open 在对应平台语义下单点处理（§3.3 前端不重复
 * 实现校验）。
 */

/** 壳注入的原生目录选择函数形态（挂载点声明见 globals.d.ts）。 */
type NativePicker = (initial?: string) => Promise<string | null>;

/** 受控取挂载点（undefined = 无能力：纯浏览器 dev / 壳未注入；
 *  类型面 = globals.d.ts 的全局声明）。 */
function pickerFn(): NativePicker | undefined {
  const fn = globalThis.helixPickDirectory;
  return typeof fn === "function" ? fn : undefined;
}

/** 原生目录选择能力探测（gate 页浏览钮渲染判据）。 */
export function hasNativePicker(): boolean {
  return pickerFn() !== undefined;
}

/**
 * 原生目录选择：`initial` 透传为对话框 defaultPath 提示位（相对/无效由
 * 对话框自身忽略，不预校验）。无能力 → null（降级面等价于未选中）；
 * 选中 → 平台原生路径串原样返回（零变换）；取消 → null。
 * 底层异常（能力未授予/插件故障等）**上抛**供消费面行内展示（W6j：
 * 静默吞错把能力面故障伪装成“取消”，无法诊断——browse 钮点了没反应
 * 的实证 bug 根因之一）。
 */
export async function nativePickDirectory(initial?: string): Promise<string | null> {
  const pick = pickerFn();
  if (pick === undefined) return null;
  return await pick(initial);
}

// ── B4 全局组合键（W6a 同构 seam：壳注入挂载点受控访问）──────────
//
// 壳（src-tauri）另经 initialization_script 挂 `window.helixHotkeyRegister` /
// `window.helixHotkeyUnregister`（内部走 tauri-plugin-global-shortcut 自带命令面
// + ShortcutJsEvent 通道，平台差异由插件消化）。`accel` 形态 = 插件约定
// （如 "CommandOrControl+Shift+K"，由 shared/lib/hotkey-combo comboToAccel
// 单点换算）；触发回调仅在按下（Pressed）时被壳侧调用。纯浏览器 dev 无挂载点
// → 探测 false，注册面自然降级（快捷键特性在纯浏览器形态休眠）。

/** 壳注入的全局组合键注册函数形态（挂载点声明见 globals.d.ts）。 */
type HotkeyRegister = (accel: string, onFire: () => void) => Promise<void>;
type HotkeyUnregister = (accel: string) => Promise<void>;

function hotkeyRegisterFn(): HotkeyRegister | undefined {
  const fn = globalThis.helixHotkeyRegister;
  return typeof fn === "function" ? fn : undefined;
}

function hotkeyUnregisterFn(): HotkeyUnregister | undefined {
  const fn = globalThis.helixHotkeyUnregister;
  return typeof fn === "function" ? fn : undefined;
}

/** 全局组合键能力探测（注册面降级判据；双挂载点齐备才算有能力）。 */
export function hasHotkeyCapability(): boolean {
  return hotkeyRegisterFn() !== undefined && hotkeyUnregisterFn() !== undefined;
}

/**
 * 注册全局组合键：`accel` 零变换透传（格式正确性由插件裁决）；`onFire` 为
 * 按下触发回调。无能力 → 静默 no-op（纯浏览器 dev）；底层异常（组合键被
 * 占用/能力未授予）**上抛**供注册面 failed 交代（W6j 同规：不吞错）。
 */
export async function nativeHotkeyRegister(accel: string, onFire: () => void): Promise<void> {
  const reg = hotkeyRegisterFn();
  if (reg === undefined) return;
  await reg(accel, onFire);
}

/** 注销全局组合键（无能力静默 no-op；异常上抛）。 */
export async function nativeHotkeyUnregister(accel: string): Promise<void> {
  const unreg = hotkeyUnregisterFn();
  if (unreg === undefined) return;
  await unreg(accel);
}
