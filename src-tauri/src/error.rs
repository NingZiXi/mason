//! 统一错误类型,实现 Serialize 以便通过 IPC 返回给前端
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("未找到 Python: {0}")]
    PythonNotFound(String),

    #[error("IO 错误: {0}")]
    Io(String),

    #[error("渲染失败: {0}")]
    RenderFailed(String),

    #[error("操作超时: {0}")]
    Timeout(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<tokio::time::error::Elapsed> for AppError {
    fn from(_: tokio::time::error::Elapsed) -> Self {
        AppError::Timeout("渲染超时(180s)".into())
    }
}