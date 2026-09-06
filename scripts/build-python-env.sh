#!/usr/bin/env bash
# 构建内置 Python CAD 引擎环境 (macOS / Linux)
#
# 用法: bash scripts/build-python-env.sh
# 产物: src-tauri/resources/python-env/ (gitignored, 打包时由 Tauri resources 收进安装包)
#
# 流程: python-build-standalone (indygreg) → pip 安装 build123d shapely numpy →
#       清理 __pycache__ → 验证 import + server 冒烟
set -euo pipefail

PYTHON_VERSION="3.12.8"
PBS_RELEASE="20241205"
PYPI_MIRROR="${PYPI_MIRROR:-https://pypi.org/simple}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/src-tauri/resources/python-env"

echo "==> 清理旧环境..."
rm -rf "$DEST"
mkdir -p "$DEST"

# ---- 检测平台 ----
ARCH="$(uname -m)"
OS="$(uname -s)"

case "$OS" in
  Darwin*)
    if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
      PBS_TARGET="aarch64-apple-darwin"
    else
      PBS_TARGET="x86_64-apple-darwin"
    fi
    ;;
  Linux*)
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
      PBS_TARGET="aarch64-unknown-linux-gnu"
    else
      PBS_TARGET="x86_64-unknown-linux-gnu"
    fi
    ;;
  *)
    echo "不支持的操作系统: $OS" >&2
    exit 1
    ;;
esac

PBS_FILENAME="cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${PBS_TARGET}-install_only.tar.gz"
PBS_URL="https://github.com/indygreg/python-build-standalone/releases/download/${PBS_RELEASE}/${PBS_FILENAME}"

echo "==> 下载 python-build-standalone: $PBS_FILENAME"
curl -fL "$PBS_URL" -o /tmp/mason-python-standalone.tar.gz

echo "==> 解压..."
tar -xzf /tmp/mason-python-standalone.tar.gz -C "$DEST" --strip-components=1
rm -f /tmp/mason-python-standalone.tar.gz

PY="$DEST/bin/python3"

echo "==> 安装 CAD 依赖 build123d / shapely / numpy..."
"$PY" -m pip install --no-warn-script-location --no-cache-dir -i "$PYPI_MIRROR" build123d shapely numpy

echo "==> 清理缓存与字节码..."
find "$DEST" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$DEST" -type f -name "*.pyc" -delete 2>/dev/null || true

echo "==> 验证 import..."
"$PY" -c "import build123d, shapely, numpy; print('deps OK')"

echo "==> 验证 server 模式..."
echo '{"id": 1, "cmd": "ping"}' | "$PY" "$ROOT/python/jig_generator.py" --server

SIZE=$(du -sh "$DEST" | cut -f1)
echo ""
echo "==> 完成: $DEST"
echo "    体积: $SIZE"
