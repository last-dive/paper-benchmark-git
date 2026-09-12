# Paperbench Research v2.5.0

本地论文评审工作台，支持五维评审、二十个检查项、多轮统计和可离线查看的报告。

本版增加本机自定义 API 的自动输入准备：原 PDF → RTX 5060 Ti / MinerU → Markdown → 模型评分。同一批的重复评审复用冻结 Markdown。转换失败保留日志并停止评分，支持取消及断线后的任务跟踪。云端 GLM 保持原 PDF 输入。

当前 MinerU 入口固定为 `/home/xx/DS/MinerU/env.sh`，需要该主机的独立环境与模型权重。AppImage 不包含 MinerU、CUDA 权重或 API Key。Markdown 图片保留供离线核查，不自动作为视觉输入发送。

附带 Ubuntu x86_64 AppImage，适用于 Ubuntu22.04 验证环境。首次运行允许文件执行；无FUSE时可使用 `--appimage-extract-and-run`。升级时先退出旧应用，再启动新版。

248项自动化测试曾通过。真实单样本验证：7页PDF转换约64秒，随后本地模型约280秒返回五维完整评分。详见 `VALIDATION_SUMMARY.md`；这不代表跨论文质量或稳定性保证。

项目许可证以仓库的许可证说明为准；第三方组件许可文件另附。发布本地文件前核对 `dist/SHA256SUMS` 和项目许可证状态。
