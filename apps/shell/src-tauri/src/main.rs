//! helix 桌面壳入口（薄监督者，architecture.md §4.2 / AD-4）。
//!
//! 职责仅限：窗口 + sidecar 进程看护（lib.rs）+ bundle 资源定位。
//! 零业务逻辑；与 daemon 的全部交互 = spawn 参数 + stdout ready 行 + 信号
//! （contracts/sidecar-lifecycle.md）。前端一律 WS 连 daemon（TR-AD-12），
//! 壳不传任何业务数据。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use helix_shell::{
    run_supervisor, ReadyInfo, SidecarSpec, SupervisorConfig, SupervisorExit, SupervisorHooks,
};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// sidecar 二进制名（externalBin 落位带 target-triple 后缀，前缀匹配）。
const SIDECAR_BIN_PREFIX: &str = "helix-daemon";

/// W6a 原生目录选择注入脚本（F3 裁决：壳唯一原生 UX 能力面）。
///
/// 挂 `window.helixPickDirectory`：调 tauri-plugin-dialog 的 open（directory+
/// 单选），选中返回平台原生路径字符串（Windows 反斜杠等形态一律透传，
/// 零业务解析）；取消/空串 → null。`initial`（可选 defaultPath 提示位）由
/// 前端传入当前输入——相对/无效由对话框自身忽略，壳不预校验。
///
/// 注：`__TAURI_INTERNALS__` 字样只允许出现在本 Rust 字符串里（AG-17
/// FORM_BRANCH_RE 只扫 apps/shell/src 与 scripts/——前端零该字样，经
/// shared/api/native-capability.ts seam 受控访问 globalThis 挂载点）。
const PICK_DIRECTORY_INIT_SCRIPT: &str = r#"
window.helixPickDirectory = (initial) =>
  window.__TAURI_INTERNALS__.invoke('plugin:dialog|open', {
    directory: true,
    multiple: false,
    ...(initial ? { defaultPath: initial } : {}),
  }).then((r) => (typeof r === 'string' && r.length > 0 ? r : null));
// W6e：主题提示回写（挂载时+主题变更时；壳侧缓存为下次启动窗口底色）
window.helixThemeHint = (theme) =>
  window.__TAURI_INTERNALS__.invoke('theme_hint', { theme });
"#;

// ── 窗口底色主题感知（W6e：先导页方案退役后的简化方案）──────────
// webview 冷启动首帧前只能显示背景色（WebKit 无 pre-document 内容面）；
// 先导页时间窗口过短不可靠（用户实证），改为让底色与当前主题一致。
// 壳读不到 webview localStorage → 前端经 theme_hint 命令回写提示到
// <app_config_dir>/theme-hint（窗口域能力，非业务解析）；缺失/读失败
// → 暗色缺省（应用主题缺省即暗）。

/// 主题提示缓存文件路径（app_config_dir 随 tauri 标识位派生）。 */
fn theme_hint_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("theme-hint"))
}

/// 窗口底色：light → #F4F2EC（boot-light 同值），否则 #060910（--void）。 */
fn theme_window_background(app: &tauri::AppHandle) -> tauri::utils::config::Color {
    let light = theme_hint_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim() == "light")
        .unwrap_or(false);
    eprintln!("[helix-shell] 窗口底色主题感知：{}", if light { "light #F4F2EC" } else { "dark #060910" });
    if light {
        tauri::utils::config::Color(244, 242, 236, 255)
    } else {
        tauri::utils::config::Color(6, 9, 16, 255)
    }
}

/// 前端回写主题提示（挂载时 + 主题变更时调用；写失败静默——缓存仅影响
/// 下次启动的窗口底色，不影响本次应用主题）。W6f：同时**运行时立即**刷新
/// NSWindow 底色与标题栏外观（本窗口即刻跟随，不必等下次启动）。 */
#[tauri::command]
fn theme_hint(app: tauri::AppHandle, theme: String) {
    let Some(dir) = app.path().app_config_dir().ok() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join("theme-hint"), &theme);
    let light = theme.trim() == "light";
    set_native_window_background(
        &app,
        "main",
        if light {
            tauri::utils::config::Color(244, 242, 236, 255)
        } else {
            tauri::utils::config::Color(6, 9, 16, 255)
        },
    );
    set_native_window_appearance(&app, "main", !light);
}

// ── 原生窗口底色/外观（W6f：v1 desk window_workspace.rs 同款投携）──
// 关键实证（v1 注释同源）：wry/Tauri 的 background_color 只写 WKWebView 的
// underPageBackgroundColor（页面越界回弹区域），**空窗期透出的是 NSWindow
// 的 backgroundColor——必须经原生 API 设置**。NSWindow 是 MainThreadOnly，
// 切主线程执行；指针经 usize 转递避开 Send 界限（v1 同款）。

/// 设置窗口空窗期真正显示的颜色（macOS；非 macOS no-op，Windows 由
/// tauri set_background_color 覆盖）。
#[cfg(target_os = "macos")]
fn set_native_window_background(app: &tauri::AppHandle, label: &str, color: tauri::utils::config::Color) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window(label) else { return };
    let Ok(ptr) = window.ns_window() else { return };
    let addr = ptr as usize;
    let tauri::utils::config::Color(r, g, b, _a) = color;
    let _ = app.run_on_main_thread(move || unsafe {
        use objc2_app_kit::{NSColor, NSWindow};
        let ns_window = &*(addr as *const NSWindow);
        let ns_color = NSColor::colorWithSRGBRed_green_blue_alpha(
            r as f64 / 255.0,
            g as f64 / 255.0,
            b as f64 / 255.0,
            1.0,
        );
        ns_window.setBackgroundColor(Some(&ns_color));
    });
}

#[cfg(not(target_os = "macos"))]
fn set_native_window_background(_app: &tauri::AppHandle, _label: &str, _color: tauri::utils::config::Color) {}

/// 设置窗口外观（macOS）：标题栏文字/控件配色跟随应用主题而非系统主题
/// （应用主题与系统不一致时标题文字色不错配）。dark=true → DarkAqua。
#[cfg(target_os = "macos")]
fn set_native_window_appearance(app: &tauri::AppHandle, label: &str, dark: bool) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window(label) else { return };
    let Ok(ptr) = window.ns_window() else { return };
    let addr = ptr as usize;
    let _ = app.run_on_main_thread(move || unsafe {
        use objc2_app_kit::{
            NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua,
            NSAppearanceNameDarkAqua, NSWindow,
        };
        let ns_window = &*(addr as *const NSWindow);
        let name = if dark { NSAppearanceNameDarkAqua } else { NSAppearanceNameAqua };
        if let Some(appearance) = NSAppearance::appearanceNamed(name) {
            ns_window.setAppearance(Some(&appearance));
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn set_native_window_appearance(_app: &tauri::AppHandle, _label: &str, _dark: bool) {}

fn main() {
    let shutdown = Arc::new(AtomicBool::new(false));
    // 放弃路径退出码（0 = 运行中/正常关停；1 = Fatal 后用户关窗）
    let exit_code = Arc::new(AtomicI32::new(0));
    let supervisor_handle: Arc<Mutex<Option<JoinHandle<()>>>> = Arc::new(Mutex::new(None));

    let app = tauri::Builder::default()
        // W6a 原生目录选择：官方三平台对话框插件（能力面见 capabilities/default.json）
        .plugin(tauri_plugin_dialog::init())
        // W6e：主题提示回写命令（前端挂载时+主题变更时调用；缓存下次启动的窗口底色）
        .invoke_handler(tauri::generate_handler![theme_hint])
        .setup({
            let shutdown = Arc::clone(&shutdown);
            let exit_code = Arc::clone(&exit_code);
            let supervisor_handle = Arc::clone(&supervisor_handle);
            move |app| {
                let handle = app.handle().clone();
                // 主窗口提前到应用启动即建（W6c：不候 sidecar ready）——终端
                // 启动屏（index.html 纯 CSS）即启动屏，覆盖 daemon 启动等待；
                // 前端以 WS 重连退避（TR-AD-12）+ connecting 屏消化 daemon
                // 未就绪窗口（端口静态解析：VITE_HELIX_PORT 缺省 7333，与
                // ready 行无关）。原"ready 后建窗"会留下启动等待期无窗/黑屏
                // （用户实证）；on_ready 保留幂等兜底（重启场景窗口已在）。
                // W6e：先导页方案退役（时间窗口不可靠，用户实证）——首导航
                // 直接指向应用；底色主题感知（theme-hint 回写缓存）。
                if handle.get_webview_window("main").is_none() {
                    let _ = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                        .title("helix")
                        .inner_size(1280.0, 800.0)
                        // webview 层（underPageBackgroundColor/越界回弹）主题感知
                        .background_color(theme_window_background(&handle))
                        // W6a：页面脚本加载前注入 helixPickDirectory；W6e 追加
                        // helixThemeHint（前端挂载时+主题变更时回写提示）
                        .initialization_script(PICK_DIRECTORY_INIT_SCRIPT)
                        .build();
                    // W6f：NSWindow 底色 + 标题栏外观原生设置（空窗期真正透出
                    // 的颜色——v1 desk 实证 builder background_color 到不了这里）
                    let bg = theme_window_background(&handle);
                    let dark = matches!(bg, tauri::utils::config::Color(6, 9, 16, 255));
                    set_native_window_background(&handle, "main", bg);
                    set_native_window_appearance(&handle, "main", dark);
                }
                let spec = resolve_sidecar_spec();
                let join = std::thread::spawn(move || {
                    let mut hooks = ShellHooks {
                        handle: handle.clone(),
                    };
                    let exit = match spec {
                        Ok(spec) => {
                            run_supervisor(&spec, &SupervisorConfig::default(), &shutdown, &mut hooks)
                        }
                        Err(e) => SupervisorExit::Fatal(e),
                    };
                    match exit {
                        SupervisorExit::Shutdown => handle.exit(0),
                        SupervisorExit::Fatal(message) => {
                            exit_code.store(1, Ordering::SeqCst);
                            show_error_window(&handle, &message);
                        }
                    }
                });
                *supervisor_handle.lock().unwrap() = Some(join);
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("helix 壳初始化失败");

    app.run(move |handle, event| {
        if let RunEvent::ExitRequested { code, api, .. } = event {
            // 程序化退出（看护线程收尾 handle.exit / fatal 非零退出）直接放行，
            // 避免重复进入回收逻辑（看护线程自 join 会死锁）。
            if code.is_some() {
                return;
            }
            let fatal_code = exit_code.load(Ordering::SeqCst);
            if fatal_code != 0 {
                // 放弃路径：错误窗口已展示，用户关窗 → 非零退出（契约 §3）
                handle.exit(fatal_code);
                return;
            }
            // 用户关窗的正常关停：拦下默认退出，先回收 sidecar（SIGTERM→5s→SIGKILL）
            api.prevent_exit();
            shutdown.store(true, Ordering::SeqCst);
            let join = supervisor_handle.lock().unwrap().take();
            if let Some(join) = join {
                let _ = join.join(); // 看护线程内 graceful stop 有 5s+SIGKILL 兑底
            }
            handle.exit(0);
        }
    });
}

/// 壳事件回口：ready → 加载主窗口（打包 = frontendDist 静态产物；dev =
/// devUrl——同一 WebviewUrl::App 代码路径，双形态不分支）；日志转发到壳 stdout。
struct ShellHooks {
    handle: AppHandle,
}

impl SupervisorHooks for ShellHooks {
    fn on_ready(&mut self, ready: &ReadyInfo) {
        eprintln!("[helix-shell] sidecar ready：port={}（token 经 ready 行持有，不落壳日志）", ready.port);
        // 幂等兜底：主窗口已在应用启动即建（W6c 提前，见 setup）；此处仅
        // 覆盖窗口被用户关闭后的 sidecar 重启场景（前端经 WS 重连退避恢复，
        // TR-AD-12，壳不干预连接）。
        let handle = self.handle.clone();
        let handle2 = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if handle2.get_webview_window("main").is_none() {
                let _ = WebviewWindowBuilder::new(&handle2, "main", WebviewUrl::App("index.html".into()))
                    .title("helix")
                    .inner_size(1280.0, 800.0)
                    .background_color(theme_window_background(&handle2))
                    // W6a：页面脚本加载前注入 helixPickDirectory（前端经 seam 探测，
                    // 纯浏览器 dev 无此挂载点 → 浏览钮不渲染，输入框仍可用）
                    .initialization_script(PICK_DIRECTORY_INIT_SCRIPT)
                    .build();
                // W6f：原生底色/外观同步（同 setup 路径）
                let bg = theme_window_background(&handle2);
                let dark = matches!(bg, tauri::utils::config::Color(6, 9, 16, 255));
                set_native_window_background(&handle2, "main", bg);
                set_native_window_appearance(&handle2, "main", dark);
            }
        });
    }

    fn on_log(&mut self, line: String) {
        eprintln!("[helix-shell][sidecar] {line}");
    }
}

/// bundle 资源定位（architecture.md §4.2 职责 4）：只定位壳自身包内资源，
/// 不解析任何业务路径。
///
/// sidecar 解析序：
/// 1. `HELIX_SIDECAR_PATH` env 覆盖（dev 编排注入位；dev 形态 daemon 由
///    bun 直跑源码，scripts/dev-desktop 负责生成该指向，见 architecture §4.6）；
/// 2. 打包形态：当前 exe 同目录的 externalBin（`helix-daemon-<target-triple>`）。
///
/// rg 注入接线位（契约 §1）：包内 `Resources/bin/rg` 存在 → 经 env
/// `HELIX_RG_PATH` 注入；dev 形态无该资源 → 自然不注入（rg 二进制 T3.1 落位）。
fn resolve_sidecar_spec() -> Result<SidecarSpec, String> {
    let mut rg_path = None;
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // macOS bundle 布局：<app>/Contents/MacOS/exe → <app>/Contents/Resources/bin/rg
            let candidate = exe_dir.join("../Resources/bin/rg");
            if candidate.is_file() {
                rg_path = candidate.canonicalize().ok();
            }
        }
    }

    if let Ok(path) = std::env::var("HELIX_SIDECAR_PATH") {
        return Ok(SidecarSpec {
            program: PathBuf::from(path),
            args: vec!["--sidecar".into()],
            rg_path,
        });
    }

    let exe = std::env::current_exe().map_err(|e| format!("定位壳 exe 失败：{e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "壳 exe 无父目录".to_string())?;
    let entries = std::fs::read_dir(exe_dir).map_err(|e| format!("枚举 externalBin 目录失败：{e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(SIDECAR_BIN_PREFIX) && entry.path().is_file() {
            return Ok(SidecarSpec {
                program: entry.path(),
                args: vec!["--sidecar".into()],
                rg_path,
            });
        }
    }
    Err(format!(
        "未找到 daemon sidecar 二进制（{} 同目录前缀 {}*）；dev 形态请经 HELIX_SIDECAR_PATH 注入",
        exe_dir.display(),
        SIDECAR_BIN_PREFIX,
    ))
}

/// 放弃路径：窗口内明确错误提示（非静默挂死，契约 §3）。
/// 错误页 = shell 静态资产 shell-error.html（dev = vite public 伺服；
/// 打包 = frontendDist 产物），消息经 query param 传递。
fn show_error_window(handle: &AppHandle, message: &str) {
    let url = WebviewUrl::App(format!("shell-error.html?message={}", percent_encode(message)).into());
    let handle2 = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        // 已加载主窗口则先关（窗口关闭不触发退出——error 窗口随后补上）
        if let Some(window) = handle2.get_webview_window("main") {
            let _ = window.close();
        }
        let _ = WebviewWindowBuilder::new(&handle2, "error", url)
            .title("helix — 启动失败")
            .inner_size(720.0, 480.0)
            .build();
    });
}

/// 最小 percent-encode（错误消息进 query param；非 ASCII 与控制字符全编码）。
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
