//! Python CAD 引擎调用(常驻进程模式)
//!
//! 工作流:
//! 1. 首次 generate 时 spawn `python jig_generator.py --server`(常驻)
//! 2. 每次生成 = 往 stdin 写一行 JSON 请求,等 stdout 的 JSON 响应(响应带临时 STL 路径)
//! 3. 读路径上的 STL 字节返回;进程崩溃/超时则 kill 并在下一次请求时重新拉起
//!
//! 协议细节见 python/jig_generator.py 的 serve()。
//! 相比每次 spawn 的旧方案,省掉 Python + build123d 重复导入(~0.5-1s/次)。
use crate::commands::{Part, ScadParams};
use crate::error::AppError;
use crate::generation;
use crate::python_detect;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, oneshot};
use tokio::time::{timeout, Duration};

const REQUEST_TIMEOUT_SECS: u64 = 120;

// ---------------------------------------------------------------------------
// 协议结构
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ServerRequest<'a> {
    id: u32,
    cmd: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    part: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<&'a ScadParams>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gap: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_ids: Option<&'a [String]>,
}

#[derive(Deserialize, Debug)]
struct ServerResponse {
    id: u32,
    ok: bool,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    error: Option<String>,
    /// stats 命令返回:实体体积(mm³)
    #[serde(default)]
    volume: Option<f64>,
    /// stats 命令返回:实体表面积(mm²)
    #[serde(default)]
    area: Option<f64>,
    #[serde(default)]
    inspection: Option<serde_json::Value>,
    #[serde(default)]
    validation: Option<serde_json::Value>,
    #[serde(default)]
    merge: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// 常驻 server 管理
// ---------------------------------------------------------------------------

type Pending = Arc<StdMutex<HashMap<u32, oneshot::Sender<ServerResponse>>>>;

struct Server {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
    next_id: u32,
    /// 引擎可执行文件路径(出错时一并展示,便于判断用的是内置还是系统 Python)
    python: String,
    /// Python stderr 日志(进程崩溃时读尾部 traceback)
    log_path: PathBuf,
}

/// Preview/metrics warm worker; admission order is controlled by generation.rs.
static SERVER: OnceLock<Mutex<Option<Server>>> = OnceLock::new();
// Export has a separate warm process: stopping preview never kills an export.
static EXPORT_SERVER: OnceLock<Mutex<Option<Server>>> = OnceLock::new();

fn server_cell() -> &'static Mutex<Option<Server>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

async fn spawn_server(
    python_path: &str,
    script_path: &std::path::Path,
    log_path: &std::path::Path,
) -> Result<Server, AppError> {
    // Python 的 stderr(含 traceback)重定向到日志文件:渲染失败时可直接定位根因
    // (此前是 Stdio::null(),错误被吞,用户只能看到"生成失败"这种无信息文案)
    // 日志目录(app_log_dir 的 logs/)首次可能不存在,先确保目录已创建,
    // 否则 OpenOptions 会在缺失目录下创建文件时报"系统找不到指定的路径"
    if let Some(dir) = log_path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| {
                AppError::Other(format!("创建日志目录失败 {}: {}", dir.display(), e))
            })?;
        }
    }
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(log_path)
        .map_err(|e| AppError::Other(format!("打开日志文件失败 {}: {}", log_path.display(), e)))?;

    let mut cmd = Command::new(python_path);
    cmd.arg("-u") // 关键:禁用 stdout 缓冲,行协议才实时
        .arg(script_path)
        .arg("--server")
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log_file));

    // Windows: 隐藏控制台黑窗口
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        AppError::Io(format!(
            "启动 Python 服务失败: {}\n引擎: {}\n日志: {}",
            e,
            python_path,
            log_path.display()
        ))
    })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Other("无法获取 Python 服务 stdin".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other("无法获取 Python 服务 stdout".into()))?;

    // 读循环:分发响应;EOF(进程退出)时丢弃所有 pending(接收端收到 Err)
    let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
    let reader_pending = pending.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = String::new();
        loop {
            buf.clear();
            match reader.read_line(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = buf.trim();
                    if line.is_empty() {
                        continue;
                    }
                    // 只认协议 JSON;杂散输出(Python 库往 stdout 打印的东西)忽略
                    if let Ok(resp) = serde_json::from_str::<ServerResponse>(line) {
                        if let Some(tx) = reader_pending.lock().unwrap().remove(&resp.id) {
                            let _ = tx.send(resp);
                        }
                    }
                }
            }
        }
        reader_pending.lock().unwrap().clear();
    });

    Ok(Server {
        child,
        stdin,
        pending,
        next_id: 0,
        python: python_path.to_string(),
        log_path: log_path.to_path_buf(),
    })
}

impl Server {
    async fn request(
        &mut self,
        cmd: &str,
        part: Option<&str>,
        format: Option<&str>,
        params: Option<&ScadParams>,
        output: Option<&str>,
        gap: Option<f64>,
        selected_ids: Option<&[String]>,
    ) -> Result<ServerResponse, AppError> {
        self.next_id += 1;
        let id = self.next_id;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let req = ServerRequest {
            id,
            cmd,
            part,
            format,
            params,
            output,
            gap,
            selected_ids,
        };
        let mut line = serde_json::to_string(&req)
            .map_err(|e| AppError::Other(format!("序列化请求失败: {}", e)))?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| AppError::Io(format!("写入 Python 服务失败: {}", e)))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| AppError::Io(format!("flush Python 服务失败: {}", e)))?;

        match timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS), rx).await {
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(_)) => {
                // 进程已退出:把 stderr 日志尾部和引擎路径透出来,
                // 否则用户只能看到"引擎已退出",无法判断是杀软拦截还是缺 DLL
                let tail = log_tail(&self.log_path, 10);
                let mut msg = format!(
                    "Python CAD 引擎已退出(进程崩溃或依赖缺失)\n引擎: {}\n日志: {}",
                    self.python,
                    self.log_path.display()
                );
                if !tail.is_empty() {
                    msg.push_str("\n---- 引擎最后输出 ----\n");
                    msg.push_str(&tail);
                }
                Err(AppError::RenderFailed(msg))
            }
            Err(_) => Err(AppError::Timeout("Python 生成超时(120s)".into())),
        }
    }
}

/// 读取诊断日志尾部(空行剔除,限制条数与总长度,避免撑爆 UI 提示)
fn log_tail(path: &std::path::Path, max_lines: usize) -> String {
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let lines: Vec<&str> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    let tail = lines[lines.len().saturating_sub(max_lines)..].join("\n");
    if tail.chars().count() > 1200 {
        let cut: String = tail.chars().skip(tail.chars().count() - 1200).collect();
        return format!("…{}", cut);
    }
    tail
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/// 内置 Python 引擎可执行文件名
/// Windows: python.exe (嵌入式发行版)
/// Unix: bin/python3 (python-build-standalone)
#[cfg(target_os = "windows")]
const BUNDLED_PYTHON_EXE: &str = "python.exe";
#[cfg(not(target_os = "windows"))]
const BUNDLED_PYTHON_EXE: &str = "bin/python3";

/// 内置 Python 引擎(随安装包分发,用户零配置)
/// 查找顺序:开发源目录(完整,dev 权威)→ resource 目录(打包;数组语法保留目录树,
/// 落在 resource_dir/resources/python-env)→ exe 旁(便携部署)
pub fn bundled_python(app: Option<&AppHandle>) -> Option<String> {
    // 开发模式:resources 原地(CARGO_MANIFEST_DIR 编译期常量,发布机上不存在,自然跳过)
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("python-env")
        .join(BUNDLED_PYTHON_EXE);
    if dev.exists() {
        return Some(dev.to_string_lossy().into_owned());
    }
    if let Some(app) = app {
        if let Ok(dir) = app.path().resource_dir() {
            for rel in ["resources/python-env", "python-env"] {
                let p = dir.join(rel).join(BUNDLED_PYTHON_EXE);
                if p.exists() {
                    return Some(p.to_string_lossy().into_owned());
                }
            }
        }
    }
    // 兜底:exe 同级(便携部署)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("python-env").join(BUNDLED_PYTHON_EXE);
            if p.exists() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// 解析 Python 可执行文件路径:用户配置 > 内置引擎 > 系统搜索
fn resolve_python(app: Option<&AppHandle>, configured: Option<&str>) -> Option<String> {
    if let Some(p) = configured {
        if !p.is_empty() && std::path::Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    bundled_python(app).or_else(python_detect::detect_python)
}

/// 查找 Python 脚本路径
/// 开发模式:项目根目录 python/jig_generator.py(CARGO_MANIFEST_DIR 编译期常量)
/// 发布模式:resource_dir/resources/scripts/jig_generator.py
fn find_script(app: &AppHandle) -> PathBuf {
    // 开发模式:CARGO_MANIFEST_DIR 上溯一层 = 项目根目录
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("python")
        .join("jig_generator.py");
    if dev.exists() {
        return dev;
    }
    // 发布模式:resource_dir
    if let Ok(dir) = app.path().resource_dir() {
        for rel in ["resources/scripts", "scripts"] {
            let p = dir.join(rel).join("jig_generator.py");
            if p.exists() {
                return p;
            }
        }
    }
    // 兜底:exe 同级
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("scripts").join("jig_generator.py");
            if p.exists() {
                return p;
            }
        }
    }
    dev
}

/// 诊断日志路径:app 日志目录(权限/隔离优于临时目录),回落 temp
fn log_path_for(app: &AppHandle) -> PathBuf {
    app.path()
        .app_log_dir()
        .map(|d| d.join("mason-python.log"))
        .unwrap_or_else(|_| std::env::temp_dir().join("mason-python.log"))
}

/// 惰性拉起常驻 server(必要时);返回后 guard 内必有可用 server
async fn ensure_server(
    guard: &mut Option<Server>,
    python: &str,
    script_path: &std::path::Path,
    log_path: &std::path::Path,
) -> Result<(), AppError> {
    if guard.is_none() {
        let mut server = spawn_server(python, script_path, log_path).await?;
        // 启动 ping:快速暴露依赖缺失(import 失败 → 进程退出 → 响应通道关闭)
        if let Err(e) = server.request("ping", None, None, None, None, None, None).await {
            let _ = server.child.kill().await;
            return Err(e);
        }
        *guard = Some(server);
    }
    Ok(())
}

/// 解析 Python 可执行文件、脚本路径与诊断日志路径(生成类命令共用)
fn resolve_runtime(
    app: &AppHandle,
    configured_python: Option<&str>,
) -> Result<(String, PathBuf, PathBuf), AppError> {
    let python = resolve_python(Some(app), configured_python).ok_or_else(|| {
        AppError::PythonNotFound(
            "未找到 Python。请先安装 Python 3.10+ 并 `pip install build123d shapely numpy`".into(),
        )
    })?;

    let script_path = find_script(app);
    if !script_path.exists() {
        return Err(AppError::Other(format!(
            "Python 脚本不存在: {}。请确认在项目根目录运行",
            script_path.display()
        )));
    }

    let log_path = log_path_for(app);
    Ok((python, script_path, log_path))
}

/// Admit preview work by priority. Exports use an independent serialized worker.
async fn request_model(
    app: &AppHandle,
    configured_python: Option<&str>,
    params: &ScadParams,
    part: Part,
    cmd: &str,
    format: Option<&str>,
    output: Option<&str>,
    gap: Option<f64>,
    selected_ids: Option<&[String]>,
    request_id: Option<String>,
    priority: u8,
    export: bool,
) -> Result<ServerResponse, AppError> {
    let ticket = if export {
        None
    } else {
        Some(generation::preview().register(request_id, priority))
    };
    if let Some(ticket) = &ticket {
        ticket.acquire().await?;
    }
    let (python, script_path, log_path) = resolve_runtime(app, configured_python)?;
    let log_path = if export {
        log_path.with_file_name("mason-python-export.log")
    } else {
        log_path
    };
    let cell = if export {
        EXPORT_SERVER.get_or_init(|| Mutex::new(None))
    } else {
        server_cell()
    };
    let mut guard = cell.lock().await;
    run_server_request(
        &mut guard, &python, &script_path, &log_path, cmd,
        Some(part.to_str()), format, Some(params), output, gap, selected_ids, ticket.as_ref(),
    ).await
}

async fn run_server_request(
    guard: &mut Option<Server>,
    python: &str,
    script_path: &std::path::Path,
    log_path: &std::path::Path,
    cmd: &str,
    part: Option<&str>,
    format: Option<&str>,
    params: Option<&ScadParams>,
    output: Option<&str>,
    gap: Option<f64>,
    selected_ids: Option<&[String]>,
    ticket: Option<&generation::Ticket<'_>>,
) -> Result<ServerResponse, AppError> {
    let work = async {
        ensure_server(guard, python, script_path, log_path).await?;
        // Runtime settings may change while the application is open.
        if guard.as_ref().is_some_and(|s| s.python != python) {
            if let Some(mut server) = guard.take() {
                let _ = server.child.kill().await;
            }
            ensure_server(guard, python, script_path, log_path).await?;
        }
        if let Some(ticket) = ticket {
            ticket.check()?;
        }
        guard.as_mut().unwrap().request(cmd, part, format, params, output, gap, selected_ids).await
    };
    let result = if let Some(ticket) = ticket {
        tokio::select! {
            biased;
            _ = ticket.interrupted() => Err(AppError::Cancelled),
            result = work => result,
        }
    } else {
        work.await
    };
    match result {
        Ok(resp) => {
            if let Some(ticket) = ticket {
                ticket.check()?;
            }
            Ok(resp)
        }
        Err(e) => {
            // Reap before releasing admission; otherwise a cancelled OCC process
            // could continue consuming CPU beside its replacement.
            // A soft cancellation noticed after startup has no calculation to
            // stop. Preserve this freshly warmed process for the latest job.
            if !matches!(e, AppError::Cancelled) || ticket.as_ref().is_some_and(|t| t.is_interrupted()) {
                if let Some(mut s) = guard.take() {
                    let _ = s.child.kill().await;
                }
            }
            Err(e)
        }
    }
}

/// 计算单个部件体积(mm³)与表面积(mm²),供前端"打印信息卡"估算耗材
pub async fn part_metrics(
    app: &AppHandle,
    configured_python: Option<&str>,
    params: &ScadParams,
    part: Part,
    request_id: Option<String>,
) -> Result<(f64, f64), AppError> {
    match request_model(app, configured_python, params, part, "stats", None, None, None, None, request_id, 2, false).await {
        Ok(resp) if resp.ok => Ok((resp.volume.unwrap_or(0.0), resp.area.unwrap_or(0.0))),
        Ok(resp) => Err(AppError::RenderFailed(format!(
            "Python 计算体积失败: {}",
            resp.error.unwrap_or_default()
        ))),
        Err(e) => Err(e),
    }
}

/// Reuse the engine's 2D aperture pipeline without constructing a CAD solid.
pub async fn inspect_stencil(
    app: &AppHandle,
    configured_python: Option<&str>,
    params: &ScadParams,
    part: Part,
    request_id: Option<String>,
) -> Result<serde_json::Value, AppError> {
    let resp = request_model(app, configured_python, params, part, "inspect_stencil", None, None, None, None, request_id, 0, false).await?;
    if !resp.ok {
        return Err(AppError::RenderFailed(format!("开孔核对失败: {}", resp.error.unwrap_or_default())));
    }
    resp.inspection.ok_or_else(|| AppError::Other("响应缺少开孔核对数据".into()))
}

/// Validate exact PCB support geometry on the warm worker, without CAD modeling.
pub async fn validate_component_relief(
    app: &AppHandle,
    configured_python: Option<&str>,
    params: &ScadParams,
    request_id: Option<String>,
) -> Result<serde_json::Value, AppError> {
    let resp = request_model(app, configured_python, params, Part::PcbInsert,
        "validate_component_relief", None, None, None, None, request_id, 0, false).await?;
    if !resp.ok {
        return Err(AppError::RenderFailed(format!("元件避空校验失败: {}", resp.error.unwrap_or_default())));
    }
    resp.validation.ok_or_else(|| AppError::Other("响应缺少元件避空校验数据".into()))
}

/// Merge nearby equal-depth pockets in canonical coordinates, without CAD work.
pub async fn merge_component_relief(
    app: &AppHandle,
    configured_python: Option<&str>,
    params: &ScadParams,
    gap: f64,
    selected_ids: Option<&[String]>,
    request_id: Option<String>,
) -> Result<serde_json::Value, AppError> {
    let resp = request_model(app, configured_python, params, Part::PcbInsert,
        "merge_component_relief", None, None, Some(gap), selected_ids, request_id, 0, false).await?;
    if !resp.ok {
        return Err(AppError::RenderFailed(format!("元件避空合并失败: {}", resp.error.unwrap_or_default())));
    }
    resp.merge.ok_or_else(|| AppError::Other("响应缺少元件避空合并数据".into()))
}

/// 渲染单个部件为 STL 字节(供前端预览)
pub async fn render_to_stl(
    app: &AppHandle,
    configured_python: Option<&str>,
    params: &ScadParams,
    part: Part,
    request_id: Option<String>,
    background: bool,
) -> Result<Vec<u8>, AppError> {
    let artifact = TempArtifact::new("stl");
    let output = artifact.0.to_string_lossy();
    let resp = request_model(app, configured_python, params, part, "generate", Some("stl"), Some(&output), None, None, request_id, if background { 1 } else { 0 }, false).await?;
    if !resp.ok {
        return Err(AppError::RenderFailed(format!(
            "Python 生成失败: {}",
            resp.error.unwrap_or_default()
        )));
    }
    let path = resp
        .path
        .ok_or_else(|| AppError::Other("响应缺少 path".into()))?;

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::Io(format!("读取 STL 失败: {}", e)))?;
    let _ = tokio::fs::remove_file(&path).await; // 清理临时产物
    Ok(bytes)
}

/// 把单个部件渲染到指定路径(供导出)
pub async fn render_to_file(
    app: &AppHandle,
    configured_python: Option<&str>,
    params: &ScadParams,
    part: Part,
    output_path: &std::path::Path,
) -> Result<(), AppError> {
    let ext = output_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("stl");

    let artifact = TempArtifact::new(ext);
    let output = artifact.0.to_string_lossy();
    let resp = request_model(app, configured_python, params, part, "generate", Some(ext), Some(&output), None, None, None, 0, true).await?;
    if !resp.ok {
        return Err(AppError::RenderFailed(format!(
            "Python 生成失败: {}",
            resp.error.unwrap_or_default()
        )));
    }
    let src = resp
        .path
        .ok_or_else(|| AppError::Other("响应缺少 path".into()))?;

    tokio::fs::copy(&src, output_path)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?;
    let _ = tokio::fs::remove_file(&src).await;
    Ok(())
}

/// Known before computation starts, so cancellation can remove partial output.
struct TempArtifact(PathBuf);
impl TempArtifact {
    fn new(ext: &str) -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        Self(std::env::temp_dir().join(format!("mason-{}-{id}.{ext}", std::process::id())))
    }
}
impl Drop for TempArtifact {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

#[cfg(test)]
mod worker_tests {
    use super::*;

    #[test]
    fn merge_selection_serializes_all_empty_and_legacy_requests_distinctly() {
        let ids = vec!["left".to_string(), "right".to_string()];
        for selection in [None, Some(&[][..]), Some(ids.as_slice())] {
            let request = ServerRequest {
                id: 1, cmd: "merge_component_relief", part: None, format: None,
                params: None, output: None, gap: Some(1.0), selected_ids: selection,
            };
            let value = serde_json::to_value(request).unwrap();
            match selection {
                None => assert!(value.get("selected_ids").is_none()),
                Some(ids) => assert_eq!(value["selected_ids"], serde_json::json!(ids)),
            }
        }
    }

    #[tokio::test]
    async fn cancelling_a_running_preview_reaps_it_and_preserves_export_worker() {
        let Some(python) = bundled_python(None).or_else(python_detect::find_python_in_path) else { return; };
        let script = TempArtifact::new("py");
        std::fs::write(&script.0, r#"
import json, sys, time
from pathlib import Path
for line in sys.stdin:
    r = json.loads(line)
    if r['cmd'] == 'generate':
        Path(r['output']).write_text('started')
        time.sleep(1 if r.get('part') == 'export' else 30)
    print(json.dumps({'id': r['id'], 'ok': True}), flush=True)
"#).unwrap();
        let preview_log = TempArtifact::new("preview.log");
        let export_log = TempArtifact::new("export.log");
        let mut preview_server = Some(spawn_server(&python, &script.0, &preview_log.0).await.unwrap());
        let mut export_server = Some(spawn_server(&python, &script.0, &export_log.0).await.unwrap());
        preview_server.as_mut().unwrap().request("ping", None, None, None, None, None, None).await.unwrap();
        export_server.as_mut().unwrap().request("ping", None, None, None, None, None, None).await.unwrap();
        let export_pid = export_server.as_ref().unwrap().child.id();
        let scheduler = generation::Scheduler::default();
        let ticket = scheduler.register(Some("preview".into()), 0);
        ticket.acquire().await.unwrap();
        let partial = TempArtifact::new("partial.stl");
        let exported = TempArtifact::new("export.stl");
        let output = partial.0.to_string_lossy();
        let export_output = exported.0.to_string_lossy();
        let cancel = async {
            timeout(Duration::from_secs(5), async {
                while !partial.0.exists() { tokio::time::sleep(Duration::from_millis(5)).await; }
            }).await.unwrap();
            scheduler.cancel(&["preview".into()], true);
        };
        let (preview, export, _) = tokio::join!(
            run_server_request(&mut preview_server, &python, &script.0, &preview_log.0,
                "generate", Some("preview"), Some("stl"), None, Some(&output), None, None, Some(&ticket)),
            run_server_request(&mut export_server, &python, &script.0, &export_log.0,
                "generate", Some("export"), Some("stl"), None, Some(&export_output), None, None, None),
            cancel,
        );
        assert!(matches!(preview, Err(AppError::Cancelled)));
        assert!(preview_server.is_none());
        assert!(export.unwrap().ok);
        assert_eq!(export_server.as_ref().unwrap().child.id(), export_pid);
        assert!(exported.0.exists());
        drop(partial);
        drop(ticket);
        let next = scheduler.register(None, 0);
        next.acquire().await.unwrap();
        assert!(run_server_request(&mut preview_server, &python, &script.0, &preview_log.0,
            "ping", None, None, None, None, None, None, Some(&next)).await.unwrap().ok);
        for server in [&mut preview_server, &mut export_server] {
            if let Some(mut server) = server.take() { server.child.kill().await.unwrap(); }
        }
    }
}
