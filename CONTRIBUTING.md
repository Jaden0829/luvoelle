# 为 Luvoelle 贡献

感谢参与 Luvoelle。公共仓库欢迎问题复现、平台兼容、OCR、截图性能、翻译 Provider、文档和测试方面的非商业交流与贡献。

## 开始前

1. 搜索现有 Issue，较大的功能先创建讨论；
2. 不提交真实 API Key、用户截图、客户数据或包含个人信息的诊断日志；
3. 新代码应附带与风险相称的测试；
4. 保持 Windows 与 Apple Silicon macOS 的既有行为；
5. 不引入许可证不兼容、禁止再分发或来源不明的模型与素材。

## 本地检查

```powershell
npm ci
npm run test:services
npm run test:license
npm run test:capture-variants
```

涉及平台能力时，还应运行对应的 Windows 或 macOS 测试。

## 许可与 CLA

公共源码采用 PolyForm Noncommercial License 1.0.0。提交贡献前必须阅读并接受 [CLA.md](CLA.md)。CLA 允许项目同时维护免费非商业源码版与独立商业授权版；贡献者仍保留其贡献版权。

提交 Pull Request 即表示其中勾选的 CLA 确认真实有效。未经 CLA 确认的贡献不会合并。

## 品牌

Fork 和修改版可以用于许可允许的非商业目的，但对外分发时必须遵守 [TRADEMARKS.md](TRADEMARKS.md)，更换名称、App ID、Logo、图标和萌宠，避免被误认为官方版本。
