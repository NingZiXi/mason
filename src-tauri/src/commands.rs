//! Tauri IPC 命令入口
use crate::error::AppError;
use crate::python_detect;
use crate::scad;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// 与前端 TS 类型保持一致的参数结构(v2 结构:参考商用钢网夹)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScadParams {
    pub pcb_size_x: f64,
    pub pcb_size_y: f64,
    pub pcb_thickness: f64,
    pub pcb_pocket_clearance: f64,
    /// PCB 板框多边形点 [[x, y], ...],已居中(以 bbox 中心为原点)
    /// 空数组 = 用矩形代替(向后兼容)
    #[serde(default)]
    pub pcb_outline_points: Vec<[f64; 2]>,
    /// PCB 板框内孔轮廓 [[[x, y], ...], ...],同 pcb_outline_points 坐标系
    /// 空数组 = 无内孔
    #[serde(default)]
    pub pcb_outline_holes: Vec<Vec<[f64; 2]>>,
    pub stencil_size: f64,
    /// 周圈螺丝间距(B 面配置;0 = 关闭周圈孔)
    pub screw_spacing: f64,
    pub base_height: f64,
    pub top_cover_height: f64,
    pub jig_size: f64,
    #[serde(default = "default_insert_height")]
    pub insert_height: f64,
    // --- v2 新参数(旧项目文件缺省时用默认值) ---
    /// 凸台高度(其余为底板)
    #[serde(default = "default_platter_height")]
    pub platter_height: f64,
    /// 凸台阶宽(槽到凸台外缘)
    #[serde(default = "default_platter_margin")]
    pub platter_margin: f64,
    /// 凸台宽度(mm) —— 与 stencil_lip 总和 = stencil_size(双向滑动条)
    /// Python 端 plater_radius 用它做反向钳制,前端 lip 滑动条即时联动
    #[serde(default = "default_platter_width")]
    pub platter_width: f64,
    /// 钢网外缘压在凸台上的唇宽(mm) —— 与 platter_width 联动
    #[serde(default = "default_stencil_lip")]
    pub stencil_lip: f64,
    /// 矩形板凸台圆角半径
    #[serde(default = "default_platter_corner_radius")]
    pub platter_corner_radius: f64,
    /// 顶出槽宽(0 = 关闭):端墙撬口宽;底部圆形顶出孔直径随板尺寸自适应
    #[serde(default = "default_eject_slot_width")]
    pub eject_slot_width: f64,
    /// 取放缺口位置:up / down / left / right 任意组合(空 = 关闭)
    #[serde(default = "default_pry_notch_sides")]
    pub pry_notch_sides: Vec<String>,
    /// 取放缺口大小比例(0.5~1.5,默认 1.0)
    #[serde(default = "default_pry_notch_scale")]
    pub pry_notch_scale: f64,
    /// 4 角压钢网螺丝直径(M5)
    #[serde(default = "default_corner_screw_d")]
    pub corner_screw_d: f64,
    /// 周圈螺丝直径(M3.5)
    #[serde(default = "default_peri_screw_d")]
    pub peri_screw_d: f64,
    /// 外缘圆角半径
    #[serde(default = "default_outer_corner_radius")]
    pub outer_corner_radius: f64,
    // --- PCB 钢网(一体式)参数 ---
    /// 槽底钢网层厚度(mm,默认 0.3 / FDM)
    #[serde(default = "default_stencil_thickness")]
    pub stencil_thickness: f64,
    /// 焊盘开孔缩小百分比(0~50,默认 10)
    #[serde(default = "default_pad_shrink")]
    pub pad_shrink: f64,
    /// 钢网边框宽(PCB 到外框边缘,mm,默认 8)
    #[serde(default = "default_stencil_frame_width")]
    pub stencil_frame_width: f64,
    /// 钢网外框圆角半径(mm,默认 3)
    #[serde(default = "default_stencil_corner_radius")]
    pub stencil_corner_radius: f64,
    /// 钢网外框形状:outline=跟随板形(默认)/ rect=矩形
    #[serde(default = "default_stencil_frame_shape")]
    pub stencil_frame_shape: String,
    /// PCB 卡槽间隙(PCB 到卡槽壁单边,mm,默认 0.2)
    #[serde(default = "default_pocket_clearance")]
    pub pocket_clearance: f64,
    /// 喇叭孔:刮刀面开孔放大百分比(100=关闭,默认 105)
    #[serde(default = "default_stencil_taper")]
    pub stencil_taper: f64,
    /// 密脚错排开关(默认开)
    #[serde(default = "default_stencil_stagger")]
    pub stencil_stagger: bool,
    /// 密脚判定阈值:焊盘中心间距小于该值(mm)
    #[serde(default = "default_stencil_stagger_gap")]
    pub stencil_stagger_gap: f64,
    /// 密脚错排偏移量(mm)
    #[serde(default = "default_stencil_stagger_offset")]
    pub stencil_stagger_offset: f64,
    /// 测试点过滤开关(默认开)
    #[serde(default = "default_stencil_filter_test_points")]
    pub stencil_filter_test_points: bool,
    /// 测试点最大直径(mm)
    #[serde(default = "default_stencil_test_point_max_dia")]
    pub stencil_test_point_max_dia: f64,
    /// 测试点孤立距离(mm)
    #[serde(default = "default_stencil_test_point_isolation")]
    pub stencil_test_point_isolation: f64,
    /// 大孔开网格开关(默认关)
    #[serde(default = "default_stencil_grid")]
    pub stencil_grid: bool,
    /// 网格阈值:单边大于该值(mm)的开孔加网格
    #[serde(default = "default_stencil_grid_size")]
    pub stencil_grid_size: f64,
    /// 网格条宽(mm)
    #[serde(default = "default_stencil_grid_bar")]
    pub stencil_grid_bar: f64,
    /// 焊盘列表(旧格式:顶点数组;新格式:多部件 {parts:[{polarity,points,holes}],polarity})
    #[serde(default)]
    pub stencil_pads: serde_json::Value,
    /// 顶层(Top Paste)焊盘列表(与板框同居中坐标系)
    #[serde(default)]
    pub stencil_pads_top: serde_json::Value,
    /// 底层(Bottom Paste)焊盘列表(Python 侧生成时做 Y 镜像)
    #[serde(default)]
    pub stencil_pads_bottom: serde_json::Value,
}

fn default_insert_height() -> f64 { 8.0 }
fn default_platter_height() -> f64 { 4.0 }
fn default_platter_margin() -> f64 { 5.0 }
fn default_platter_width() -> f64 { 70.0 }
fn default_stencil_lip() -> f64 { 15.0 }
fn default_platter_corner_radius() -> f64 { 4.5 }
fn default_eject_slot_width() -> f64 { 22.0 }
fn default_pry_notch_sides() -> Vec<String> { vec!["down".to_string()] }
fn default_pry_notch_scale() -> f64 { 1.0 }
fn default_corner_screw_d() -> f64 { 5.0 }
fn default_peri_screw_d() -> f64 { 3.5 }
fn default_outer_corner_radius() -> f64 { 5.0 }
fn default_stencil_thickness() -> f64 { 0.3 }
fn default_pad_shrink() -> f64 { 0.0 }
fn default_stencil_frame_width() -> f64 { 12.0 }
fn default_stencil_corner_radius() -> f64 { 3.0 }
fn default_stencil_frame_shape() -> String { "outline".to_string() }
fn default_pocket_clearance() -> f64 { 0.1 }
fn default_stencil_taper() -> f64 { 105.0 }
fn default_stencil_stagger() -> bool { false }
fn default_stencil_stagger_gap() -> f64 { 0.55 }
fn default_stencil_stagger_offset() -> f64 { 0.15 }
fn default_stencil_filter_test_points() -> bool { true }
fn default_stencil_test_point_max_dia() -> f64 { 1.9 }
fn default_stencil_test_point_isolation() -> f64 { 1.5 }
fn default_stencil_grid() -> bool { false }
fn default_stencil_grid_size() -> f64 { 2.0 }
fn default_stencil_grid_bar() -> f64 { 0.5 }

/// 部件标识
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Part {
    Base,
    PcbInsert,
    TopCover,
    StencilTop,
    StencilBottom,
}

impl Part {
    pub fn to_str(&self) -> &'static str {
        match self {
            Part::Base => "base",
            Part::PcbInsert => "insert",
            Part::TopCover => "cover",
            Part::StencilTop => "stencil_top",
            Part::StencilBottom => "stencil_bottom",
        }
    }
}

const STORE_FILE: &str = "settings.json";
const KEY_PYTHON_PATH: &str = "python_path";

// ---------------------------------------------------------------------------
// 引擎状态与一键配置
// ---------------------------------------------------------------------------

/// 引擎(Python + CAD 依赖)状态
#[derive(Debug, Clone, Serialize)]
pub struct EngineStatus {
    /// 找到的 python.exe 路径(None = 未找到)
    pub python_path: Option<String>,
    /// CAD 依赖(build123d/shapely/numpy)是否齐全
    pub deps_ok: bool,
    /// 缺失的依赖名列表
    pub missing: Vec<String>,
    /// 是否使用随应用打包的内置引擎
    pub bundled: bool,
}

/// 用 find_spec 检查依赖(只查不导入,秒回;真 import build123d 要 ~5s)
fn check_deps_blocking(python: &str) -> Vec<String> {
    const REQUIRED: &[&str] = &["build123d", "shapely", "numpy"];
    let script = format!(
        "import importlib.util,sys;\
         missing=[m for m in {REQUIRED:?} if importlib.util.find_spec(m) is None];\
         print(','.join(missing))"
    );
    let mut check_cmd = std::process::Command::new(python);
    check_cmd.arg("-c").arg(&script);

    // Windows: 隐藏控制台黑窗口
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        check_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match check_cmd.output()
    {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if text.is_empty() {
                Vec::new()
            } else {
                text.split(',').map(|s| s.to_string()).collect()
            }
        }
        // python 本身跑不起来(损坏/版本过老):全部视为缺失
        _ => REQUIRED.iter().map(|s| s.to_string()).collect(),
    }
}

/// 查询引擎状态:用户配置 > 内置引擎 > 系统搜索;找到 python 后检查依赖
#[tauri::command]
pub async fn get_engine_status(app: AppHandle) -> Result<EngineStatus, AppError> {
    let configured = app
        .store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(KEY_PYTHON_PATH))
        .and_then(|v| v.as_str().map(String::from))
        .filter(|s| !s.is_empty() && std::path::Path::new(s).exists());

    let bundled = scad::bundled_python(Some(&app));

    // 优先级与生成路径一致:用户配置 > 内置 > 系统
    let python = configured
        .clone()
        .or_else(|| bundled.clone())
        .or_else(python_detect::detect_python);
    let using_bundled = configured.is_none() && python == bundled && bundled.is_some();

    match python {
        Some(p) => {
            let py = p.clone();
            let missing = tokio::task::spawn_blocking(move || check_deps_blocking(&py))
                .await
                .map_err(|e| AppError::Other(format!("依赖检查失败: {}", e)))?;
            Ok(EngineStatus {
                python_path: Some(p),
                deps_ok: missing.is_empty(),
                missing,
                bundled: using_bundled,
            })
        }
        None => Ok(EngineStatus {
            python_path: None,
            deps_ok: false,
            missing: Vec::new(),
            bundled: false,
        }),
    }
}

/// 逐行读取子进程输出并 emit 到前端;返回是否退出成功
async fn run_with_log(app: &AppHandle, mut cmd: std::process::Command) -> Result<(), AppError> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use tauri::Emitter;

    // Windows: 隐藏控制台黑窗口
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Io(format!("启动安装进程失败: {}", e)))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let h_stdout = app.clone();
    let t_out = tokio::task::spawn_blocking(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = h_stdout.emit("install-log", line);
        }
    });
    let h_err = app.clone();
    let t_err = tokio::task::spawn_blocking(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = h_err.emit("install-log", line);
        }
    });

    let _ = t_out.await;
    let _ = t_err.await;

    let status = tokio::time::timeout(
        std::time::Duration::from_secs(600),
        tokio::task::spawn_blocking(move || child.wait()),
    )
    .await
    .map_err(|_| {
        let _ = app.emit("install-log", "[timeout] 安装超时(10 分钟),请检查网络后重试");
        AppError::Timeout("安装超时(10 分钟)".into())
    })?
    .map_err(|e| AppError::Io(format!("等待安装进程失败: {}", e)))?
    .map_err(|e| AppError::Io(format!("安装进程异常: {}", e)))?;

    if status.success() {
        Ok(())
    } else {
        Err(AppError::RenderFailed(format!(
            "安装进程退出码 {:?},详见日志输出",
            status.code()
        )))
    }
}

/// 一键安装 CAD 依赖(pip,走清华镜像;--progress-bar off 输出干净的行流)
#[tauri::command]
pub async fn install_deps(
    app: AppHandle,
    python_path: String,
) -> Result<(), AppError> {
    use tauri::Emitter;
    if !std::path::Path::new(&python_path).exists() {
        return Err(AppError::Other(format!("路径不存在: {}", python_path)));
    }
    let _ = app.emit("install-log", format!("> pip install build123d shapely numpy(清华镜像)"));

    let mut cmd = std::process::Command::new(&python_path);
    cmd.arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--no-input")
        .arg("--progress-bar")
        .arg("off")
        .arg("-i")
        .arg("https://pypi.tuna.tsinghua.edu.cn/simple")
        .arg("build123d")
        .arg("shapely")
        .arg("numpy");

    run_with_log(&app, cmd).await
}

/// 一键安装 Python(winget 静默安装 3.12);成功后返回新装的 python 路径
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn install_python(app: AppHandle) -> Result<String, AppError> {
    use tauri::Emitter;
    let _ = app.emit("install-log", "> winget install Python.Python.3.12(静默安装)");

    let mut cmd = std::process::Command::new("winget");
    cmd.arg("install")
        .arg("--id").arg("Python.Python.3.12")
        .arg("-e")
        .arg("--silent")
        .arg("--disable-interactivity")
        .arg("--accept-source-agreements")
        .arg("--accept-package-agreements");

    run_with_log(&app, cmd).await?;

    // winget 装完 PATH 不一定对当前进程刷新:直接扫安装目录
    tokio::time::sleep(std::time::Duration::from_secs(2)).await; // 等文件落盘
    let found = python_detect::find_python_in_localappdata()
        .or_else(python_detect::find_python_in_path)
        .ok_or_else(|| {
            AppError::Other(
                "winget 安装完成但未找到 python.exe,请手动选择安装位置".into(),
            )
        })?;
    Ok(found)
}

/// 非 Windows 平台不支持一键安装 Python(发布版自带内置引擎)
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn install_python(_app: AppHandle) -> Result<String, AppError> {
    Err(AppError::Other(
        "一键安装 Python 仅支持 Windows;非 Windows 平台请使用内置引擎或手动安装".into(),
    ))
}

/// 用户手动设置 Python 路径,持久化到 store
/// 自动把 Git Bash 风格路径(/c/...)转成 Windows 原生路径
#[tauri::command]
pub async fn set_python_path(app: AppHandle, path: String) -> Result<String, AppError> {
    use crate::python_detect;

    // 路径归化(Git Bash → Windows)
    let normalized = python_detect::normalize_path(&path);

    // 验证文件存在(尝试多个变体)
    let candidates = [
        normalized.clone(),
        path.clone(),
        // 也试试加 .exe 后缀
        format!("{}.exe", normalized.trim_end_matches(".exe")),
    ];
    let actual = candidates
        .iter()
        .find(|p| !p.is_empty() && std::path::Path::new(p).exists())
        .ok_or_else(|| AppError::Other(format!("路径不存在: {}", path)))?
        .clone();

    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::Other(format!("打开设置文件失败: {}", e)))?;

    store.set(KEY_PYTHON_PATH, serde_json::Value::String(actual.clone()));
    store
        .save()
        .map_err(|e| AppError::Other(format!("保存设置失败: {}", e)))?;

    Ok(actual)
}

/// 渲染单个部件为 STL,返回字节数组(供前端预览)
#[tauri::command]
pub async fn generate_stl(
    app: AppHandle,
    params: ScadParams,
    part: Part,
) -> Result<tauri::ipc::Response, AppError> {
    let configured = app
        .store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(KEY_PYTHON_PATH))
        .and_then(|v| v.as_str().map(String::from))
        .filter(|s| !s.is_empty());

    // 返回原始字节(Response 走二进制通道):Vec<u8> 走 JSON 数字数组会把
    // 数 MB 的 STL 膨胀成几十 MB 文本,序列化/传输/解析全部变慢
    let bytes = scad::render_to_stl(&app, configured.as_deref(), &params, part).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 单个部件体积(mm³)/表面积(mm²),供前端"打印信息卡"估算耗材克重
#[derive(Debug, Clone, Serialize)]
pub struct PartMetrics {
    pub volume_mm3: f64,
    pub area_mm2: f64,
}

#[tauri::command]
pub async fn part_metrics(
    app: AppHandle,
    params: ScadParams,
    part: Part,
) -> Result<PartMetrics, AppError> {
    let configured = app
        .store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(KEY_PYTHON_PATH))
        .and_then(|v| v.as_str().map(String::from))
        .filter(|s| !s.is_empty());

    let (volume_mm3, area_mm2) =
        scad::part_metrics(&app, configured.as_deref(), &params, part).await?;
    Ok(PartMetrics { volume_mm3, area_mm2 })
}

/// 把单个部件渲染到指定路径(供前端导出 STL 文件)
#[tauri::command]
pub async fn export_stl(
    app: AppHandle,
    params: ScadParams,
    part: Part,
    output_path: String,
) -> Result<String, AppError> {
    let configured = app
        .store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(KEY_PYTHON_PATH))
        .and_then(|v| v.as_str().map(String::from))
        .filter(|s| !s.is_empty());

    let path = PathBuf::from(&output_path);
    scad::render_to_file(&app, configured.as_deref(), &params, part, &path).await?;
    Ok(output_path)
}

/// 把字节写入指定路径(供前端把缓存的 STL bytes 直接落盘,避免重复生成)
#[tauri::command]
pub async fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), AppError> {
    std::fs::write(&path, bytes)
        .map_err(|e| AppError::Io(format!("写入文件失败 {}: {}", path, e)))
}

/// 确保目录存在,若不存在则递归创建(供前端导出 STL/STEP 时自动建 Mason_<时间戳>/)
#[tauri::command]
pub async fn ensure_dir(path: String) -> Result<(), AppError> {
    let p = PathBuf::from(&path);
    if p.exists() {
        if !p.is_dir() {
            return Err(AppError::Io(format!("路径已存在但不是目录: {}", path)));
        }
        return Ok(());
    }
    std::fs::create_dir_all(&p)
        .map_err(|e| AppError::Io(format!("创建目录失败 {}: {}", path, e)))
}

/// 项目文件 schema
#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectFile {
    #[serde(default = "default_version")]
    pub version: u32,
    pub config: ScadParams,
    #[serde(default)]
    pub gerber_filename: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn default_version() -> u32 {
    1
}

/// 保存项目配置到 JSON 文件
#[tauri::command]
pub async fn save_project(
    path: String,
    config: ScadParams,
    gerber_filename: Option<String>,
) -> Result<String, AppError> {
    let now = chrono_like_now();
    let project = ProjectFile {
        version: 1,
        config,
        gerber_filename,
        created_at: now.clone(),
        updated_at: now,
    };

    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| AppError::Other(format!("序列化失败: {}", e)))?;
    std::fs::write(&path, json).map_err(|e| AppError::Io(e.to_string()))?;
    Ok(path)
}

/// 加载项目配置文件
#[tauri::command]
pub async fn load_project(path: String) -> Result<ProjectFile, AppError> {
    let text = std::fs::read_to_string(&path).map_err(|e| AppError::Io(e.to_string()))?;
    let project: ProjectFile = serde_json::from_str(&text)
        .map_err(|e| AppError::Other(format!("JSON 解析失败: {}", e)))?;
    Ok(project)
}

/// 读取拖入的文件,供 drag-drop 后使用
#[tauri::command]
pub async fn read_dropped_file(path: String) -> Result<Vec<u8>, AppError> {
    let bytes = std::fs::read(&path).map_err(|e| AppError::Io(format!("读取文件失败 {}: {}", path, e)))?;
    Ok(bytes)
}

/// 简易 ISO 8601 时间戳(避免引入 chrono 依赖)
fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("epoch:{}", now.as_secs())
}