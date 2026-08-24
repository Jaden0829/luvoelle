# Luvoelle Apple 芯片 Mac 朋友测试

## 最省事的打包方式

项目已经提供 `.github/workflows/build-macos-arm64.yml`。把源码放进 GitHub 仓库后，在仓库的 **Actions → Build macOS Apple Silicon → Run workflow** 手动运行。任务完成后下载 `Luvoelle-0.25.0-mac-arm64`，其中包含：

- `Luvoelle-0.25.0-mac-arm64.dmg`：给朋友正常拖入“应用程序”安装；
- `Luvoelle-0.25.0-mac-arm64.zip`：备用压缩包。

该工作流使用原生 Apple Silicon 的 macOS 26 构建机，并重新安装 arm64 版本的 ONNX Runtime、Canvas 与 Koffi，不能把 Windows 电脑现有的 `node_modules` 直接复制过去。

## 在真实 Mac 本机打包

Mac 安装 Node.js 22 后，在项目目录执行：

```bash
npm ci --include=optional
npm run test:services
npm run test:mac-support
npm run dist:mac
```

成品位于 `outputs/release`。

## 第一次安装和授权

目前朋友测试包没有 Apple Developer 签名。第一次打开时：

1. 将 Luvoelle 拖入“应用程序”。
2. 如果系统阻止打开，在 Finder 中按住 Control 点击 Luvoelle，选择“打开”；或者前往“系统设置 → 隐私与安全性”选择仍要打开。
3. 第一次使用任一截图功能时，macOS 会询问屏幕录制权限，选择允许。
4. 如果应用提示需要重开，请彻底退出 Luvoelle 后重新打开。

Luvoelle 不会在后台启动时主动索要屏幕权限；只有用户第一次按截图快捷键时才会触发。

Mac 键盘上的 `Alt` 对应 `Option (⌥)`。功能键默认可能需要按 `Fn + F1`，也可以在 Luvoelle 设置里改成自己的快捷键。

## 必测项目

先在只用内置屏幕时测试：

- `Option + A` 截图、原地编辑、Enter 完成并复制；
- `Option + S / O / P` 翻译、取字与视觉拆解；
- Retina 小字清晰度和 OCR；
- 悬停窗口后整窗吸附；
- Esc 退出截图；
- 托盘（菜单栏）后台驻留、关闭工作台后快捷键仍然有效；
- 固定图片和固定视觉窗口。

再连接副屏测试：

- 鼠标分别位于内置屏幕和副屏时开始截图；
- 两块屏幕缩放比例不同时，框选位置与最终图片范围一致；
- 在副屏窗口上进行整窗吸附；
- 拔出和重新连接副屏后，快捷键仍能截图。

如果出现黑屏、空白截图或系统权限循环，请保留 `~/Library/Application Support/Luvoelle/diagnostics.log` 并记录 macOS 版本、Mac 型号和复现步骤。

## 正式公开前

朋友内测通过后，再使用 Apple Developer 的 Developer ID Application 证书签名并完成 Apple 公证。签名和公证不是本轮朋友测试的前置条件，但公开下载时必须补齐，否则普通用户会被 Gatekeeper 警告。
