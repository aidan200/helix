//! 系统通知链路 spike（P0 gate）——最小验证体：不碰 helix 壳主代码。
//!
//! 启动数秒后由 Rust 侧直接调 `tauri-plugin-notification` 的权限面 + 投递面，
//! 每步结果追加写入 `HELIX_SPIKE_LOG`（缺省 `.helix/tmp/spike-notify.log`），
//! 供场景 A（cargo run 裸 binary）/ 场景 B（tauri build .app）自动化对账。
//! 标签由 `HELIX_SPIKE_TAG` 区分（A/B）。
//!
//! 时序设计（关键：`request_permission` 在 macOS 会阻塞到用户在系统授权框上
//! 点选——spike 体不能把证据链卡在人工交互上）：
//!   t=3s   读 permission_state(before)
//!   t=3s   另起线程 request_permission（结果到达才记日志，未点也要往下走）
//!   t=8s   show() #1（授权未定时仍调用——记录失败形态，本身就是坑清单素材）
//!   t=12s  show() #2（重复投递面）
//!   t=15s  自退（自动化收口，不等交互）

use std::io::Write;
use std::time::Duration;

use tauri_plugin_notification::NotificationExt;

fn log_path() -> std::path::PathBuf {
    match std::env::var_os("HELIX_SPIKE_LOG") {
        Some(p) => std::path::PathBuf::from(p),
        None => std::path::PathBuf::from("/Users/siyong/AI_Project/.helix/tmp/spike-notify.log"),
    }
}

fn tag() -> String {
    if let Ok(t) = std::env::var("HELIX_SPIKE_TAG") {
        return t;
    }
    // 未显式给 tag 时按 exe 路径自判形态：.app bundle 内 exe 路径含
    // `.app/Contents/MacOS`（`open` 启动场景拿不到环境变量）
    let exe = std::env::current_exe().unwrap_or_default();
    let s = exe.to_string_lossy();
    if s.contains(".app/Contents/MacOS") {
        "B-bundle".to_string()
    } else {
        "A-bare".to_string()
    }
}

fn log(tag: &str, msg: &str) {
    let line = format!("[{}] {}\n", tag, msg);
    eprint!("{}", line);
    let path = log_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn main() {
    let tag = tag();
    log(
        &tag,
        &format!(
            "START exe={:?} pid={}",
            std::env::current_exe().unwrap_or_default(),
            std::process::id()
        ),
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup({
            let tag = tag.clone();
            move |app| {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let perm = handle.notification();
                    std::thread::sleep(Duration::from_millis(3000));
                    match perm.permission_state() {
                        Ok(s) => log(&tag, &format!("STEP1 permission_state(before) = {:?}", s)),
                        Err(e) => log(&tag, &format!("STEP1 permission_state(before) ERR = {}", e)),
                    }
                    log(&tag, "STEP2 request_permission() 发起（系统授权框出现即用户可点；未点也继续）");
                    {
                        // 授权框阻塞等待用户点选——放独立线程，证据链不等交互
                        let req_handle = handle.clone();
                        let req_tag = tag.clone();
                        std::thread::spawn(move || match req_handle.notification().request_permission() {
                            Ok(s) => log(&req_tag, &format!("STEP2 request_permission = {:?}", s)),
                            Err(e) => log(&req_tag, &format!("STEP2 request_permission ERR = {}", e)),
                        });
                    }
                    std::thread::sleep(Duration::from_millis(5000));
                    match handle.notification().permission_state() {
                        Ok(s) => log(&tag, &format!("STEP2b permission_state(after) = {:?}", s)),
                        Err(e) => log(&tag, &format!("STEP2b permission_state(after) ERR = {}", e)),
                    }
                    let stamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    log(&tag, "STEP3 show() notification#1…");
                    match handle
                        .notification()
                        .builder()
                        .title(format!("spike {} 系统通知", tag))
                        .body(format!("plugin 投递验证 ts={}", stamp))
                        .show()
                    {
                        Ok(()) => log(&tag, "STEP3 show() OK"),
                        Err(e) => log(&tag, &format!("STEP3 show() ERR = {}", e)),
                    }
                    std::thread::sleep(Duration::from_millis(4000));
                    log(&tag, "STEP4 show() notification#2（重复投递面）…");
                    match handle
                        .notification()
                        .builder()
                        .title(format!("spike {} 第二条", tag))
                        .body("重复投递面验证")
                        .show()
                    {
                        Ok(()) => log(&tag, "STEP4 show() OK"),
                        Err(e) => log(&tag, &format!("STEP4 show() ERR = {}", e)),
                    }
                    log(&tag, "DONE");
                    std::thread::sleep(Duration::from_millis(500));
                    handle.exit(0);
                });
                Ok(())
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| log(&tag, &format!("RUN EXIT ERR = {}", e)));
}
