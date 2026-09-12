# 参与开发

先阅读 [README](README.md) 中的材料流程、计分约束和当前 MinerU 主机限制。应用许可尚未确定，见 [LICENSE-NOTICE.md](LICENSE-NOTICE.md)；提交者应确保有权提供所提交的内容。

## 本地工作流

使用 Linux、Python 3.10+、Node.js 20+ 和 Poppler。程序 Python 部分只用标准库，测试不需要 API Key 或 GPU。

修改前运行 `python3 run_tests.py` 获取本机基线。修改 JavaScript、模板或样式后，更新生成页面并验证：

```bash
python3 assemble.py
python3 run_tests.py
python3 tools/check_repo.py
git diff --check
```

`index.html` 是生成的单文件应用，须与源模块一起提交。测试会检查它与 `template.html`、`style.css` 及三份 JavaScript 模块完全一致。

`SOURCE_SNAPSHOT.json` 记录初始交付应用的哈希。修改应用后，`--verify-snapshot` 与初始快照不一致是需要解释的变化；不要仅为使检查通过而重写历史快照。新增版本应保存新的发布清单和相应验收资料。

## 修改时保留的行为

- 模型返回等级和证据，程序计算分数；不得静默补造等级、猜测引用或将缺失材料当作低分。
- 原始请求、响应和冻结参数应保留。格式恢复需要可审计理由，补跑不能覆盖既有成功结果。
- 区分原 PDF、转换 Markdown、文本索引与实际发送给模型的材料。
- 文件路径、会话校验、密钥清理、转换取消及进程清理等边界，应随有关修改一起验证。

为行为变更增加能证明结果的针对性测试。报告测试命令、通过或失败情况，以及条件不足导致的跳过。模拟 API 或 GPU 测试不应表述为真实模型或真实 MinerU 验收；真实调用需使用自己的服务并单独记录模型、输入方式与实际覆盖范围。

## 提交 Issue 或 Pull Request

描述触发条件、期望结果、实际结果和最小复现。PR 应说明行为变化与验证结果；界面修改可附经脱敏的截图，涉及评分或来源协议时说明归档兼容性。

提交前查看 `git status` 与实际 diff。不要提交 `.private/`、有效 API Key、论文原件、个人报告、机器日志、模型权重或 `dist/` 构建产物。仓库检查只覆盖已知模式，脱敏样例也需人工阅读。

安全问题按 [SECURITY.md](SECURITY.md) 的方式处理。AppImage 构建和发布流程分别见 [构建说明](docs/APPIMAGE_BUILD.md) 与 [发布说明](docs/GITHUB_PUBLISH.md)。
