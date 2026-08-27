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
"#;

fn main() {
    let shutdown = Arc::new(AtomicBool::new(false));
    // 放弃路径退出码（0 = 运行中/正常关停；1 = Fatal 后用户关窗）
    let exit_code = Arc::new(AtomicI32::new(0));
    let supervisor_handle: Arc<Mutex<Option<JoinHandle<()>>>> = Arc::new(Mutex::new(None));

    let app = tauri::Builder::default()
        // W6a 原生目录选择：官方三平台对话框插件（能力面见 capabilities/default.json）
        .plugin(tauri_plugin_dialog::init())
        .setup({
            let shutdown = Arc::clone(&shutdown);
            let exit_code = Arc::clone(&exit_code);
            let supervisor_handle = Arc::clone(&supervisor_handle);
            move |app| {
                let handle = app.handle().clone();
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
        let handle = self.handle.clone();
        let handle2 = handle.clone();
        // 重启场景窗口已在：前端经自身重连退避恢复 WS（TR-AD-12），壳不干预
        let _ = handle.run_on_main_thread(move || {
            if handle2.get_webview_window("main").is_none() {
                let _ = WebviewWindowBuilder::new(&handle2, "main", WebviewUrl::App("index.html".into()))
                    .title("helix")
                    .inner_size(1280.0, 800.0)
                    // W6a：页面脚本加载前注入 helixPickDirectory（前端经 seam 探测，
                    // 纯浏览器 dev 无此挂载点 → 浏览钮不渲染，输入框仍可用）
                    .initialization_script(PICK_DIRECTORY_INIT_SCRIPT)
                    .build();
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
