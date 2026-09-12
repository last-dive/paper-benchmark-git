# Paperbench Research v2.5.0

本地论文评审工作台，支持五维评审、二十个检查项、多轮统计和可离线查看的报告。

本版增加本机自定义 API 的自动输入准备：原 PDF → RTX 5060 Ti / MinerU → Markdown → 模型评分。同一批的重复评审复用冻结 Markdown。转换失败保留日志并停止评分，支持取消及断线后的任务跟踪。云端 GLM 保持原 PDF 输入。

当前 MinerU 入口固定为 `/home/xx/DS/MinerU/env.sh`，需要该主机的独立环境与模型权重。AppImage 不包含 MinerU、CUDA 权重或 API Key。Markdown 图片保留供离线核查，不自动作为视觉输入发送。

附带 Ubuntu x86_64 AppImage，适用于 Ubuntu22.04 验证环境。首次运行允许文件执行；无FUSE时可使用 `--appimage-extract-and-run`。升级时先退出旧应用，再启动新版。

248项自动化测试曾通过。真实单样本验证：7页PDF转换约64秒，随后本地模型约280秒返回五维完整评分。详见 `VALIDATION_SUMMARY.md`；这不代表跨论文质量或稳定性保证。

## 许可与致谢补充（2026-09-13）

项目原创代码、文档和图标现采用 [PolyForm Noncommercial 1.0.0](https://github.com/last-dive/paper-benchmark-git/blob/main/LICENSE)，允许按条款为非商业目的使用、修改与分发。它是非商业源码可用许可，不是 OSI 开源许可；[适用范围与中文说明](https://github.com/last-dive/paper-benchmark-git/blob/main/LICENSE-NOTICE.md)明确排除第三方组件，第三方继续适用各自原有条款。

请同时下载 **Paperbench-Licensing-and-Notices-2.5.0-20260913.tar.gz** 及 **Paperbench-Licensing-and-Notices-2.5.0-20260913.sha256**。该补充附件包含项目许可、NOTICE、软件引用、致谢、系统包/Node.js/运行时/宿主组件索引和保存的原始版权材料。初始 `Third-Party-Notices-2.5.0.tar.gz` 为历史材料；新增附件补充其缺失项。

AppImage 文件与原 SHA-256 校验清单均保持不变；本次仅增加许可/引用材料，不重新打包应用。第三方对应源码、静态库精确版本和重链接材料的核验范围见 [THIRD_PARTY_NOTICES.md](https://github.com/last-dive/paper-benchmark-git/blob/main/THIRD_PARTY_NOTICES.md)，致谢不能替代各许可证要求的材料。
