//! helix-shell 监督者运行时（薄监督者核心，contracts/sidecar-lifecycle.md 的壳侧实现）。
//!
//! 职责边界（architecture.md §4.2 / AD-4）：本模块只做 sidecar 进程看护——
//! spawn、stdout ready 行解析、崩溃重启节流、优雅关停；零业务逻辑（无
//! SQL/RPC 桥/watcher/kg，不读 `~/.helix/` 任何文件——token 只认 ready 行）。
//! 与 daemon 的全部交互 = spawn 参数（argv/env）+ stdout ready 行 + 信号。
//!
//! Tauri 接线在 main.rs；本模块不 import tauri，保证 `cargo test` 可独立
//! 驱动握手/看护状态机。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

// ── 契约常量（sidecar-lifecycle.md §2/§3）────────────────────────────────

/// 握手超时：spawn 后 15s 未收到合法 ready 行 → 判定启动失败。
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// 重启节流：60s 窗口内最多重启 3 次。
pub const RESTART_MAX: usize = 3;
pub const RESTART_WINDOW: Duration = Duration::from_secs(60);
/// 优雅关停：SIGTERM 后至多等 5s，SIGKILL 兑底。
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// 看护参数（Default = 契约值；测试注入小值驱动超时/节流分支）。
#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    pub handshake_timeout: Duration,
    pub restart_max: usize,
    pub restart_window: Duration,
    pub shutdown_grace: Duration,
    /// 看护轮询间隔（try_wait + shutdown 标志检查）。
    pub poll_interval: Duration,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            handshake_timeout: HANDSHAKE_TIMEOUT,
            restart_max: RESTART_MAX,
            restart_window: RESTART_WINDOW,
            shutdown_grace: SHUTDOWN_GRACE,
            poll_interval: Duration::from_millis(100),
        }
    }
}

// ── ready 行解析（契约 §2）───────────────────────────────────────────────

/// ready 行载荷：`{"type":"ready","port":N,"token":"..."}`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyInfo {
    pub port: u16,
    pub token: String,
}

/// stdout 行分类：ready 行 = 生命周期信号；其余行 = 日志（壳只转发不解析）。
/// 协议候选行（`{` 起首）但 JSON 非法 / type=ready 缺字段 → Invalid，
/// 视同启动失败（契约 §5 错误模型，同 ready 超时分支）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadyLine {
    Ready(ReadyInfo),
    Log(String),
    Invalid(String),
}

pub fn classify_stdout_line(line: &str) -> ReadyLine {
    let trimmed = line.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') {
        return ReadyLine::Log(line.to_string());
    }
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => return ReadyLine::Invalid(format!("协议候选行不是合法 JSON：{e}")),
    };
    if value.get("type").and_then(|t| t.as_str()) != Some("ready") {
        // 非 ready 的 JSON 行按日志转发（daemon 正常不输出，容错不判死）
        return ReadyLine::Log(line.to_string());
    }
    let port = value
        .get("port")
        .and_then(|p| p.as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p > 0);
    let token = value
        .get("token")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty());
    match (port, token) {
        (Some(port), Some(token)) => ReadyLine::Ready(ReadyInfo {
            port,
            token: token.to_string(),
        }),
        _ => ReadyLine::Invalid(format!("ready 行缺合法 port/token 字段：{trimmed}")),
    }
}

// ── 退出分类（契约 §3）───────────────────────────────────────────────────

/// 子进程退出原因（std ExitStatus 的可测试投影）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitCause {
    Code(i32),
    Signalled(i32),
}

impl From<ExitStatus> for ExitCause {
    fn from(status: ExitStatus) -> Self {
        use std::os::unix::process::ExitStatusExt;
        match status.code() {
            Some(code) => ExitCause::Code(code),
            None => ExitCause::Signalled(status.signal().unwrap_or(-1)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitClass {
    /// 壳发起关停后的退出（唯一正常面）。
    Clean,
    /// 异常退出：exit code 0 但壳未发起关停 / 非零退出 / 信号杀死（SIGKILL 等）。
    Abnormal,
}

pub fn classify_exit(cause: ExitCause, shutdown_initiated: bool) -> ExitClass {
    match (cause, shutdown_initiated) {
        (ExitCause::Code(0), true) => ExitClass::Clean,
        _ => ExitClass::Abnormal,
    }
}

// ── 重启节流（契约 §3：60s 窗口最多 3 次）────────────────────────────────

#[derive(Debug)]
pub struct RestartThrottle {
    max: usize,
    window: Duration,
    attempts: VecDeque<Instant>,
}

impl RestartThrottle {
    pub fn new(max: usize, window: Duration) -> Self {
        Self {
            max,
            window,
            attempts: VecDeque::new(),
        }
    }

    /// 记录一次重启诉求并判定是否放行：窗口内已达 max 次 → false（放弃路径）。
    pub fn allow(&mut self, now: Instant) -> bool {
        while let Some(front) = self.attempts.front() {
            if now.duration_since(*front) >= self.window {
                self.attempts.pop_front();
            } else {
                break;
            }
        }
        if self.attempts.len() >= self.max {
            return false;
        }
        self.attempts.push_back(now);
        true
    }
}

// ── 握手错误（契约 §5 错误模型）──────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeError {
    /// 15s（配置值）内未收到合法 ready 行。
    Timeout,
    /// 协议候选行非法（JSON 非法 / 缺字段）——视同启动失败。
    InvalidReady(String),
    /// sidecar 提前关闭 stdout（进程已退出或管道断裂）。
    Eof,
    Io(String),
}

impl std::fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandshakeError::Timeout => write!(f, "ready 行等待超时"),
            HandshakeError::InvalidReady(why) => write!(f, "ready 行非法：{why}"),
            HandshakeError::Eof => write!(f, "sidecar stdout 提前关闭（未上报 ready）"),
            HandshakeError::Io(e) => write!(f, "读取 sidecar stdout 失败：{e}"),
        }
    }
}

// ── 看护运行时 ───────────────────────────────────────────────────────────

/// sidecar spawn 规格（壳的 bundle 资源定位产物，main.rs 解析）。
#[derive(Debug, Clone)]
pub struct SidecarSpec {
    /// sidecar 可执行文件路径（打包 = externalBin 落位；dev = HELIX_SIDECAR_PATH 注入）。
    pub program: PathBuf,
    /// argv（`--sidecar` 等；契约 §1）。
    pub args: Vec<String>,
    /// 包内 rg 绝对路径（Some → 经 env HELIX_RG_PATH 注入；dev 形态 None = 不注入）。
    pub rg_path: Option<PathBuf>,
    /// 包内 codegraph launcher 绝对路径（Some → 经 env HELIX_CODEGRAPH_PATH 注入）。
    pub codegraph_path: Option<PathBuf>,
}

/// 看护事件回口（main.rs 实现：窗口加载/日志转发）。重启后每次握手成功都会
/// 再次回调 on_ready（前端经自身重连退避恢复 WS，TR-AD-12）。
pub trait SupervisorHooks {
    fn on_ready(&mut self, ready: &ReadyInfo);
    fn on_log(&mut self, line: String);
}

/// 看护终局。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupervisorExit {
    /// 壳发起关停，sidecar 已优雅回收（SIGTERM→5s→SIGKILL）。
    Shutdown,
    /// 放弃路径：节流超限 / 持续启动失败——窗口内明确错误提示 + 非零退出。
    Fatal(String),
}

/// 看护主循环（阻塞；由 main.rs 在独立线程驱动）。
///
/// 循环不变式：spawn → 握手 → 看护轮询；任一面失败按契约错误模型计入
/// 节流，超限转 Fatal。陈旧单例锁由 daemon 自身抢占（TR-AD-11），壳不碰
/// 锁文件。
pub fn run_supervisor(
    spec: &SidecarSpec,
    config: &SupervisorConfig,
    shutdown: &Arc<AtomicBool>,
    hooks: &mut dyn SupervisorHooks,
) -> SupervisorExit {
    let mut throttle = RestartThrottle::new(config.restart_max, config.restart_window);
    loop {
        if shutdown.load(Ordering::SeqCst) {
            return SupervisorExit::Shutdown;
        }
        let stderr_tail = StderrTail::new();
        let mut child = match spawn_sidecar(spec, &stderr_tail) {
            Ok(c) => c,
            Err(e) => {
                if !throttle.allow(Instant::now()) {
                    return SupervisorExit::Fatal(format!(
                        "daemon sidecar 反复启动失败（{} 秒内已重启 {} 次），放弃：{e}",
                        config.restart_window.as_secs(),
                        config.restart_max,
                    ));
                }
                continue;
            }
        };
        let stdout = child.stdout.take();
        let mut lines = stdout.map(|s| spawn_line_reader(s));

        match handshake(lines.as_mut(), config, hooks) {
            Ok(ready) => hooks.on_ready(&ready),
            Err(e) => {
                stop_child(&mut child, config);
                if !throttle.allow(Instant::now()) {
                    return SupervisorExit::Fatal(format!(
                        "daemon sidecar 握手反复失败（{} 秒内已重启 {} 次），放弃：{e}{}",
                        config.restart_window.as_secs(),
                        config.restart_max,
                        stderr_tail.render(),
                    ));
                }
                continue;
            }
        }

        // 看护轮询：shutdown 标志 / 子进程退出 / stdout 日志转发
        let status = loop {
            if shutdown.load(Ordering::SeqCst) {
                stop_child(&mut child, config);
                return SupervisorExit::Shutdown;
            }
            if let Some(rx) = lines.as_ref() {
                while let Ok(Ok(line)) = rx.try_recv() {
                    forward_line(line, hooks);
                }
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => thread::sleep(config.poll_interval),
                Err(e) => {
                    return SupervisorExit::Fatal(format!("看护轮询失败：{e}"));
                }
            }
        };

        // 到达此处 = 壳未发起关停而 sidecar 已退出 → 恒为异常（契约 §3）
        kill_process_group(child.id() as i32); // 兜底清可能持管道的子孙（同 stop_child）
        let cause = ExitCause::from(status);
        debug_assert_eq!(classify_exit(cause, false), ExitClass::Abnormal);
        if !throttle.allow(Instant::now()) {
            return SupervisorExit::Fatal(format!(
                "daemon sidecar 反复异常退出（{} 秒内已重启 {} 次），放弃：{}{}",
                config.restart_window.as_secs(),
                config.restart_max,
                describe_exit(cause),
                stderr_tail.render(),
            ));
        }
    }
}

fn describe_exit(cause: ExitCause) -> String {
    match cause {
        ExitCause::Code(code) => format!("退出码 {code}"),
        ExitCause::Signalled(sig) => format!("被信号 {sig} 杀死"),
    }
}

fn forward_line(line: String, hooks: &mut dyn SupervisorHooks) {
    match classify_stdout_line(&line) {
        // ready 之后的协议行/日志一律按日志转发（契约 §2：不做协议解析）
        ReadyLine::Log(l) => hooks.on_log(l),
        other => hooks.on_log(format!("{other:?}")),
    }
}

fn spawn_sidecar(spec: &SidecarSpec, stderr_tail: &StderrTail) -> std::io::Result<Child> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdin(Stdio::null()) // 契约 §2：壳不使用 stdin 发指令
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(rg) = &spec.rg_path {
        command.env("HELIX_RG_PATH", rg);
    }
    if let Some(cg) = &spec.codegraph_path {
        command.env("HELIX_CODEGRAPH_PATH", cg);
    }
    // 独立进程组：SIGKILL 兑底杀整组——sidecar 子孙进程（rg 等）继承 stdio
    // 管道，只杀主进程会导致管道不 EOF、stderr 收尾线程悬挂。
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                libc::setpgid(0, 0);
                Ok(())
            });
        }
    }
    let mut child = command.spawn()?;
    if let Some(stderr) = child.stderr.take() {
        stderr_tail.spawn_reader(stderr);
    }
    Ok(child)
}

fn spawn_line_reader(stdout: impl std::io::Read + Send + 'static) -> Receiver<std::io::Result<String>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let is_err = line.is_err();
            if tx.send(line).is_err() || is_err {
                return;
            }
        }
    });
    rx
}

/// 握手：spawn 后等待合法 ready 行（超时/非法/Eof 按契约 §5 视同启动失败）。
fn handshake(
    lines: Option<&mut Receiver<std::io::Result<String>>>,
    config: &SupervisorConfig,
    hooks: &mut dyn SupervisorHooks,
) -> Result<ReadyInfo, HandshakeError> {
    let rx = lines.ok_or(HandshakeError::Eof)?;
    let deadline = Instant::now() + config.handshake_timeout;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(HandshakeError::Timeout)?;
        match rx.recv_timeout(remaining) {
            Err(RecvTimeoutError::Timeout) => return Err(HandshakeError::Timeout),
            Err(RecvTimeoutError::Disconnected) => return Err(HandshakeError::Eof),
            Ok(Err(e)) => return Err(HandshakeError::Io(e.to_string())),
            Ok(Ok(line)) => match classify_stdout_line(&line) {
                ReadyLine::Ready(ready) => return Ok(ready),
                ReadyLine::Invalid(why) => return Err(HandshakeError::InvalidReady(why)),
                ReadyLine::Log(l) => hooks.on_log(l),
            },
        }
    }
}

/// 优雅关停（契约 §3）：SIGTERM（仅主进程——daemon 自行优雅回收其子进程）
/// → 至多等 shutdown_grace → SIGKILL 兑底（整组，防子孙持管道悬挂）。
fn stop_child(child: &mut Child, config: &SupervisorConfig) {
    let pid = child.id() as i32;
    // SAFETY: 向自身子进程发信号，pid 有效。
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    let deadline = Instant::now() + config.shutdown_grace;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                kill_process_group(pid); // 主进程已退，兜底清可能持管道的子孙
                return;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    break;
                }
                thread::sleep(config.poll_interval.min(Duration::from_millis(50)));
            }
            Err(_) => break,
        }
    }
    kill_process_group(pid);
    let _ = child.kill();
    let _ = child.wait();
}

/// SIGKILL 兑底杀整组（spawn 时已 setpgid，pgid=pid）；组不存在（ESRCH）忽略。
fn kill_process_group(pid: i32) {
    // SAFETY: kill 系统调用本身安全；组不存在时返回错误，调用面忽略。
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
}

/// daemon stderr 尾行环形缓冲（契约 §5：错误提示含 daemon stderr 尾行）。
struct StderrTail {
    lines: Arc<Mutex<VecDeque<String>>>,
    reader: Mutex<Option<thread::JoinHandle<()>>>,
}

impl StderrTail {
    const CAP: usize = 50;

    fn new() -> Self {
        Self {
            lines: Arc::new(Mutex::new(VecDeque::new())),
            reader: Mutex::new(None),
        }
    }

    fn spawn_reader(&self, stderr: impl std::io::Read + Send + 'static) {
        let lines = Arc::clone(&self.lines);
        let handle = thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut guard = lines.lock().unwrap();
                if guard.len() >= Self::CAP {
                    guard.pop_front();
                }
                guard.push_back(line);
            }
        });
        *self.reader.lock().unwrap() = Some(handle);
    }

    fn render(&self) -> String {
        // 调用面保证子进程已回收（stderr 管道 EOF）→ reader 线程即刻收尾，
        // join 排空缓冲，避免尾行竞态丢失。
        if let Some(handle) = self.reader.lock().unwrap().take() {
            let _ = handle.join();
        }
        let guard = self.lines.lock().unwrap();
        if guard.is_empty() {
            return String::new();
        }
        format!("；daemon stderr 尾行：{}", guard.back().unwrap())
    }
}

// ── 测试（test-design §CL-1/F1.2、F1.4 映射）─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ── ready 行解析 ────────────────────────────────────────────────────

    #[test]
    fn 合法_ready_行提取_port_token() {
        let line = r#"{"type":"ready","port":7333,"token":"abc123"}"#;
        assert_eq!(
            classify_stdout_line(line),
            ReadyLine::Ready(ReadyInfo {
                port: 7333,
                token: "abc123".into(),
            })
        );
    }

    #[test]
    fn ready_行缺字段视同启动失败() {
        for line in [
            r#"{"type":"ready","port":7333}"#,          // 缺 token
            r#"{"type":"ready","token":"abc"}"#,        // 缺 port
            r#"{"type":"ready","port":0,"token":"a"}"#, // port=0 非法（随机端口须上报真实端口）
            r#"{"type":"ready","port":7333,"token":""}"#, // 空 token
            r#"{"type":"ready","port":"7333","token":"a"}"#, // port 类型错
        ] {
            assert!(
                matches!(classify_stdout_line(line), ReadyLine::Invalid(_)),
                "应判 Invalid：{line}"
            );
        }
    }

    #[test]
    fn 协议候选行_json_非法视同启动失败() {
        assert!(matches!(
            classify_stdout_line(r#"{"type":"ready","port":7333,"#),
            ReadyLine::Invalid(_)
        ));
    }

    #[test]
    fn 非协议行按日志转发() {
        assert_eq!(
            classify_stdout_line("[daemon] listening..."),
            ReadyLine::Log("[daemon] listening...".into())
        );
        // 非 ready 的合法 JSON 也按日志（容错，不误判死）
        assert!(matches!(
            classify_stdout_line(r#"{"level":"info","msg":"hi"}"#),
            ReadyLine::Log(_)
        ));
    }

    // ── 退出分类（契约 §3）───────────────────────────────────────────────

    #[test]
    fn 退出分类_契约判据() {
        // exit 0 且壳发起关停 = 正常（唯一正常面）
        assert_eq!(classify_exit(ExitCause::Code(0), true), ExitClass::Clean);
        // exit 0 但壳未发起关停 = 异常
        assert_eq!(classify_exit(ExitCause::Code(0), false), ExitClass::Abnormal);
        // 非零退出 = 异常
        assert_eq!(classify_exit(ExitCause::Code(1), false), ExitClass::Abnormal);
        assert_eq!(classify_exit(ExitCause::Code(1), true), ExitClass::Abnormal);
        // 信号杀死（SIGKILL 等）= 异常
        assert_eq!(
            classify_exit(ExitCause::Signalled(9), false),
            ExitClass::Abnormal
        );
    }

    // ── 重启节流（契约 §3：3 次/60s）────────────────────────────────────

    #[test]
    fn 节流_窗口内3次后放弃() {
        let mut throttle = RestartThrottle::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(throttle.allow(t0)); // 重启 1
        assert!(throttle.allow(t0 + Duration::from_secs(10))); // 重启 2
        assert!(throttle.allow(t0 + Duration::from_secs(20))); // 重启 3
        assert!(!throttle.allow(t0 + Duration::from_secs(30))); // 超限 → 放弃
    }

    #[test]
    fn 节流_窗口滑出后恢复() {
        let mut throttle = RestartThrottle::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        for i in 0..3 {
            assert!(throttle.allow(t0 + Duration::from_secs(i * 10)));
        }
        // 61s 后最早一次滑出窗口 → 恢复放行
        assert!(throttle.allow(t0 + Duration::from_secs(61)));
    }

    // ── 看护状态机集成（假 sidecar 驱动真实 run_supervisor）──────────────

    struct RecordingHooks {
        ready: Vec<ReadyInfo>,
        logs: Vec<String>,
    }
    impl RecordingHooks {
        fn new() -> Self {
            Self {
                ready: Vec::new(),
                logs: Vec::new(),
            }
        }
    }
    impl SupervisorHooks for RecordingHooks {
        fn on_ready(&mut self, ready: &ReadyInfo) {
            self.ready.push(ready.clone());
        }
        fn on_log(&mut self, line: String) {
            self.logs.push(line);
        }
    }

    fn test_config() -> SupervisorConfig {
        SupervisorConfig {
            // 握手即时成功的用例给足超时（并行跑测试时进程/线程调度有抖动）；
            // 专测超时分支的用例用 test_config_fast_timeout。
            handshake_timeout: Duration::from_secs(5),
            restart_max: 3,
            restart_window: Duration::from_secs(60),
            shutdown_grace: Duration::from_millis(300),
            poll_interval: Duration::from_millis(10),
        }
    }

    fn test_config_fast_timeout() -> SupervisorConfig {
        SupervisorConfig {
            handshake_timeout: Duration::from_millis(400),
            ..test_config()
        }
    }

    /// 写一个可执行假 sidecar 脚本到临时目录。
    fn fake_sidecar(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        write!(f, "{body}").unwrap();
        drop(f);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    fn spec_for(program: PathBuf) -> SidecarSpec {
        SidecarSpec {
            program,
            args: vec!["--sidecar".into()],
            rg_path: None,
            codegraph_path: None,
        }
    }

    #[test]
    fn 握手成功_on_ready_且_sigterm_优雅关停() {
        let dir = std::env::temp_dir().join(format!("helix-shell-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = fake_sidecar(
            &dir,
            "ok.sh",
            "echo '{\"type\":\"ready\",\"port\":7333,\"token\":\"tok\"}'; echo 'plain log'; sleep 60\n",
        );
        let shutdown = Arc::new(AtomicBool::new(false));
        // 通道 hooks：跨线程观测 on_ready / on_log
        #[derive(Debug)]
        enum Ev {
            Ready(ReadyInfo),
            Log(String),
        }
        struct ChanHooks(mpsc::Sender<Ev>);
        impl SupervisorHooks for ChanHooks {
            fn on_ready(&mut self, ready: &ReadyInfo) {
                let _ = self.0.send(Ev::Ready(ready.clone()));
            }
            fn on_log(&mut self, line: String) {
                let _ = self.0.send(Ev::Log(line));
            }
        }
        let (tx, rx) = mpsc::channel::<Ev>();
        let shutdown2 = Arc::clone(&shutdown);
        let handle = thread::spawn(move || {
            let mut hooks = ChanHooks(tx);
            run_supervisor(&spec_for(program), &test_config(), &shutdown2, &mut hooks)
        });
        // 握手成功 → on_ready（其后日志行也转发）
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ev::Ready(ready)) => {
                assert_eq!(ready.port, 7333);
                assert_eq!(ready.token, "tok");
            }
            other => panic!("应收到 on_ready，实际 {other:?}"),
        }
        // 壳发起关停 → SIGTERM（脚本 sleep 默认响应 SIGTERM 终止）→ Shutdown
        shutdown.store(true, Ordering::SeqCst);
        let exit = handle.join().expect("看护线程不 panic");
        assert_eq!(exit, SupervisorExit::Shutdown);
    }

    #[test]
    fn ready_超时计入重启_超限转_fatal() {
        let dir = std::env::temp_dir().join(format!("helix-shell-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 永不输出 ready → 每次握手 500ms 超时 → 重启 3 次后 Fatal
        let program = fake_sidecar(&dir, "silent.sh", "sleep 60\n");
        let shutdown = Arc::new(AtomicBool::new(false));
        let mut hooks = RecordingHooks::new();
        let exit = run_supervisor(&spec_for(program), &test_config_fast_timeout(), &shutdown, &mut hooks);
        match exit {
            SupervisorExit::Fatal(msg) => assert!(msg.contains("握手"), "应含握手失败：{msg}"),
            other => panic!("应为 Fatal，实际 {other:?}"),
        }
        assert!(hooks.ready.is_empty());
    }

    #[test]
    fn 非法ready行视同启动失败_超限转_fatal() {
        let dir = std::env::temp_dir().join(format!("helix-shell-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = fake_sidecar(
            &dir,
            "bad.sh",
            "echo '{\"type\":\"ready\",\"port\":7333}'; sleep 60\n",
        );
        let shutdown = Arc::new(AtomicBool::new(false));
        let mut hooks = RecordingHooks::new();
        let exit = run_supervisor(&spec_for(program), &test_config(), &shutdown, &mut hooks);
        assert!(matches!(exit, SupervisorExit::Fatal(m) if m.contains("非法")));
        assert!(hooks.ready.is_empty());
    }

    #[test]
    fn 异常退出重启恢复_超限转_fatal_含退出码() {
        let dir = std::env::temp_dir().join(format!("helix-shell-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // ready 后立即以非零码退出 → 异常退出分类 → 节流内重启 → 超限 Fatal
        let program = fake_sidecar(
            &dir,
            "crash.sh",
            "echo '{\"type\":\"ready\",\"port\":7333,\"token\":\"tok\"}'; echo 'boom' >&2; exit 1\n",
        );
        let shutdown = Arc::new(AtomicBool::new(false));
        let mut hooks = RecordingHooks::new();
        let exit = run_supervisor(&spec_for(program), &test_config(), &shutdown, &mut hooks);
        match exit {
            SupervisorExit::Fatal(msg) => {
                assert!(msg.contains("退出码 1"), "应含退出码：{msg}");
                assert!(msg.contains("boom"), "应含 stderr 尾行：{msg}");
            }
            other => panic!("应为 Fatal，实际 {other:?}"),
        }
        // 初始 spawn + 3 次重启 = 4 次握手成功
        assert_eq!(hooks.ready.len(), 4);
    }
}
