# macOS installation / macOS 安装说明

[English README](../README.md) · [简体中文](../README.zh-CN.md)

## English

The current macOS download is for Apple Silicon (M-series chips), not Intel Macs. Download it from this project's [GitHub Releases](https://github.com/NingZiXi/mason/releases/latest), open the DMG, and drag Mason into Applications before starting it.

Mason does not currently have Apple Developer ID signing or Apple notarization. New builds use an ad-hoc app signature to preserve bundle integrity; the `.sig` files accompanying updates serve a separate purpose and do not establish an Apple-verified developer identity.

If macOS blocks a trusted download, try opening it once, then go to **System Settings → Privacy & Security → Open Anyway**, if offered. See [Apple's instructions](https://support.apple.com/en-us/102445). Ad-hoc signing does not remove this first-launch requirement.

If macOS says **“Mason is damaged and can't be opened”**, this message alone does not prove whether the download is corrupted or the app signature is missing or invalid. Re-download the latest build from the project's Releases. If it persists, report the release version, macOS version, chip type, downloaded filename, and the output of:

```sh
codesign --verify --deep --strict --verbose=2 "/Applications/Mason.app"
```

Do not modify files inside Mason.app or disable Gatekeeper system-wide. A build with a missing or invalid signature needs to be rebuilt; ad-hoc signing alone does not make it Apple-notarized.

## 简体中文

目前 macOS 安装包适用于 Apple Silicon（M 系列芯片），不适用于 Intel Mac。请从本项目 [GitHub Releases](https://github.com/NingZiXi/mason/releases/latest) 下载，打开 DMG 后先将 Mason 拖入「应用程序」，再启动。

Mason 目前没有 Apple Developer ID 签名，也未经过苹果公证。新构建使用临时（ad-hoc）应用签名来校验应用包完整性；更新附件中的 `.sig` 是另一套自动更新校验，不能替代苹果的开发者签名。

如果系统阻止打开，且你确认安装包来自本项目并可信，可先尝试启动一次，然后在 **系统设置 → 隐私与安全性 → 仍要打开** 中允许（如果系统提供此按钮）。步骤见 [苹果官方说明](https://support.apple.com/zh-cn/102445)。临时签名不会免除首次启动时的手动允许。

如果提示 **「Mason 已损坏，无法打开」**，仅凭这句话无法确定是下载损坏、缺失签名还是签名无效。请先从本项目 Releases 重新下载最新构建；若仍出现，请反馈软件版本、macOS 版本、芯片类型、下载文件名，以及终端中下面命令的输出：

```sh
codesign --verify --deep --strict --verbose=2 "/Applications/Mason.app"
```

请勿修改 Mason.app 内部文件或全局关闭 Gatekeeper。缺失或无效签名需要重新构建修复；临时签名也不等于通过苹果公证。
