# Mason 开发文档

[返回首页](../README.md) · [English](./DEVELOPMENT.en.md)

## 本地运行

准备 Node.js 20+、Rust stable 和 Python 3.12（与当前 CI 一致），并安装 [Tauri 对应平台的构建依赖](https://v2.tauri.app/start/prerequisites/)。以下命令均在仓库根目录执行。

```sh
npm ci
python -m pip install -r python/requirements.txt
npm run tauri:dev
```

`tauri:dev` 启动带热更新的桌面程序；`npm run dev` 仅启动网页开发服务器。开发版会探测系统 Python，也可在「Python 环境」中手动指定已安装依赖的解释器。

## 打包

先构建内置 Python 运行时，再打包桌面程序。

Windows：

```sh
npm run build:python-env
npm run tauri:build
```

macOS / Linux：

```sh
bash scripts/build-python-env.sh
npm run tauri:build
```

安装包输出到 `src-tauri/target/release/bundle/`。运行时构建脚本从 `python/requirements.txt` 安装依赖；修改依赖后应重新构建运行时。

CAD 引擎只维护 `python/jig_generator.py`，Rust 构建会自动同步到打包资源。`tauri.conf.json` 中 Python 运行时资源保持目录数组形式，避免改变 `site-packages` 的目录结构。

## 检查与测试

```sh
# 前端单元测试、类型检查与生产构建
npm test -- --run
npm run build

# Rust 后端回归
cargo test --manifest-path src-tauri/Cargo.toml --lib

# Python 几何验证与回归
python -m pip install pytest
python python/tests/run_all.py
python -m pytest python/test_jig_generator.py -q

# 发布清单与引擎资源同步
npm run test:release
python -m unittest discover -s scripts -p test_build_sync.py
```

[CI 配置](../.github/workflows/ci.yml) 是持续集成检查项的依据。

## 代码结构

前端负责 Gerber 解析、参数和预览，通过 Tauri IPC 调用 Rust；Rust 调度常驻 Python 进程生成模型。STL 预览按参数缓存，STEP 由建模引擎导出。

| 位置 | 职责 |
| --- | --- |
| `src/lib/gerber/` | 板框、焊盘与拼版解析 |
| `src/stores/` | 参数、预设、界面和工作状态 |
| `src/components/` | 参数面板、二维核对、三维预览 |
| `src/i18n/` | 软件界面的中、英、日、韩文案及系统语言匹配 |
| `src-tauri/src/` | IPC、Python 探测及任务调度 |
| `python/` | CAD 建模与几何测试 |
| `docs/` | 官网静态文件；网页讲解维护见 [说明](./src/README.md) |

## 发布

发布流程见 [Release 工作流](../.github/workflows/release.yml)。推送 `v*` 标签会触发构建和发布；正式更新包需要配置工作流使用的签名密钥。

发布前同步 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 与 `src-tauri/tauri.conf.json` 中的应用版本，并在 `release-notes/v<版本>.md` 编写更新说明。工作流生成签名安装包和 `latest.json`，供软件检查更新。
