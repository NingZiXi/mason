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
use crate::openscad_detect;
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
}

#[derive(Deserialize, Debug)]
struct ServerResponse {
    id: u32,
    ok: bool,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    error: Option<String>,
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
}

/// 全局唯一的常驻 server;互斥锁同时把请求串行化(单进程 Python 顺序执行)
static SERVER: OnceLock<Mutex<Option<Server>>> = OnceLock::new();

fn server_cell() -> &'static Mutex<Option<Server>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

async fn spawn_server(python_path: &str, script_path: &std::path::Path) -> Result<Server, AppError> {
    let mut child = Command::new(python_path)
        .arg("-u") // 关键:禁用 stdout 缓冲,行协议才实时
        .arg(script_path)
        .arg("--server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null()) // stderr 只写日志;null 防止管道缓冲塞满阻塞 Python
        .spawn()
        .map_err(|e| AppError::Io(format!("启动 Python 服务失败: {}", e)))?;

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
    })
}

impl Server {
    async fn request(
        &mut self,
        cmd: &str,
        part: Option<&str>,
        format: Option<&str>,
        params: Option<&ScadParams>,
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
            Ok(Err(_)) => Err(AppError::ScadFailed(
                "Python CAD 引擎已退出(进程崩溃或依赖缺失,请确认已 pip install build123d shapely numpy)".into(),
            )),
            Err(_) => Err(AppError::Timeout("Python 生成超时(120s)".into())),
        }
    }
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
    bundled_python(app).or_else(openscad_detect::detect_python)
}

/// 项目根目录(tauri dev 时 cwd 在 src-tauri,用 CARGO_MANIFEST_DIR 上溯一层)
fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 发送 generate 请求(必要时拉起 server);传输失败时杀掉 server,下次请求重新拉起
async fn request_generate(
    app: &AppHandle,
    configured_python: Option<&str>,
    params: &ScadParams,
    part: Part,
    format: &str,
) -> Result<ServerResponse, AppError> {
    let python = resolve_python(Some(app), configured_python).ok_or_else(|| {
        AppError::OpenScadNotFound(
            "未找到 Python。请先安装 Python 3.10+ 并 `pip install build123d shapely numpy`".into(),
        )
    })?;

    let script_path = project_root().join("python").join("jig_generator.py");
    if !script_path.exists() {
        return Err(AppError::Other(format!(
            "Python 脚本不存在: {}。请确认在项目根目录运行",
            script_path.display()
        )));
    }

    let cell = server_cell();
    let mut guard = cell.lock().await;

    // 惰性拉起 + 健壮性:server 掉线后自动重启
    if guard.is_none() {
        let mut server = spawn_server(&python, &script_path).await?;
        // 启动 ping:快速暴露依赖缺失(import 失败 → 进程退出 → 响应通道关闭)
        if let Err(e) = server.request("ping", None, None, None).await {
            let _ = server.child.start_kill();
            return Err(e);
        }
        *guard = Some(server);
    }

    let server = guard.as_mut().unwrap();
    match server
        .request("generate", Some(part.to_str()), Some(format), Some(params))
        .await
    {
        Ok(resp) => Ok(resp),
        Err(e) => {
            // 传输层失败(超时/进程死亡):kill + 清空,下次请求重新拉起
            if let Some(mut s) = guard.take() {
                let _ = s.child.start_kill();
            }
            Err(e)
        }
    }
}

/// 渲染单个部件为 STL 字节(供前端预览)
pub async fn render_to_stl(
    app: &AppHandle,
    configured_python: Option<&str>,
    params: &ScadParams,
    part: Part,
) -> Result<Vec<u8>, AppError> {
    let resp = request_generate(app, configured_python, params, part, "stl").await?;
    if !resp.ok {
        return Err(AppError::ScadFailed(format!(
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

    let resp = request_generate(app, configured_python, params, part, ext).await?;
    if !resp.ok {
        return Err(AppError::ScadFailed(format!(
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
