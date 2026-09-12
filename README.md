# Paperbench Research · 论文评审工作台

**v2.5.0** — 在本机组织论文、调用模型评审、按固定规则计分，并保存可离线阅读的完整报告。

模型审查贡献、严谨、证据、公平、一致五个维度，共二十个固定检查项；程序负责校验来源、计算分数和汇总多轮结果。报告保留冻结参数、原始请求与响应、完整理由、引用和失败记录，方便人工核查。

这是当前可运行程序及 AppImage 的源码快照。应用代码与测试共 38 个文件保持原字节，哈希见 [SOURCE_SNAPSHOT.json](SOURCE_SNAPSHOT.json)。仓库说明与 GitHub 配套文件另行整理；原 AppImage 没有因本次整理重新打包。

## 能做什么

- 导入 PDF、UTF-8 TXT/TEXT/Markdown；支持文件、目录和本机绝对路径。
- 使用默认 BigModel Coding 接口或自定义兼容 Chat Completions 接口。
- 云端 PDF 模式提交原 PDF 与冻结引文索引；自定义本机 API 的 PDF 先由 MinerU 转为 Markdown，再提交文本与索引。
- 逐项校验模型输出，保留合法的部分结果；内容错误按槽位隔离，支持本地恢复与补跑未完成槽位。
- 导出离线 HTML、JSON、CSV、原始材料和转换附件；每次保存生成独立目录。

评分用于辅助审阅。引用能够定位到材料，不等于模型判断已经得到证实；少量轮次也不能支持稳定排名。

## 从源码启动

当前完整桌面工作流面向 Linux，已在 Ubuntu 22.04 x86_64 验证。需要 Python 3.10+；Node.js 20+ 用于报告导出与测试；PDF 文字提取和页数检查需要 Poppler 的 `pdftotext`、`pdfinfo`。Python 程序使用标准库，无须安装 pip 包。MinerU 是另外的主机依赖，见下节。

在仓库根目录运行：

```bash
python3 start_local.py --no-browser --port 8787
```

打开 <http://127.0.0.1:8787/>，保持终端运行，按 Ctrl+C 结束。省略 `--no-browser` 可自动打开浏览器；端口占用时换用其他端口。

首次使用默认 BigModel 接口，先运行以下命令，按无回显提示输入 Key，再启动服务：

```bash
python3 configure_local.py
```

配置保存在 `.private/model_config.json`，该目录被 Git 忽略。配置格式见 [model_config.example.json](examples/model_config.example.json)，其中是占位值。自定义 API 可直接在网页填写地址、模型及其 Key；自定义 Key 仅用于当前会话，不借用默认凭据。

直接双击根目录 `index.html` 可查看界面和归档，但完整文件导入、模型代理与指定目录保存需要本机服务。导出的离线报告 `index.html` 可以独立阅读。

## 使用 AppImage

本地交付副本位于 `dist/Paperbench-Research-2.5.0-x86_64.AppImage`。`dist/` 保留在本机并被 Git 忽略；通过 Git 克隆不会获得此文件，公开分发应使用 GitHub Release 附件。

在仓库根目录运行：

```bash
chmod +x dist/Paperbench-Research-2.5.0-x86_64.AppImage
./dist/Paperbench-Research-2.5.0-x86_64.AppImage --appimage-extract-and-run
```

启动器自动打开浏览器，默认使用端口 8788，占用时选择可用端口；以启动器打开的地址为准。升级前先退出旧应用。AppImage 的依赖、构建及已有机器路径说明见 [AppImage 构建说明](docs/APPIMAGE_BUILD.md)。

当前文件为 59,935,224 字节，SHA-256：

```text
3af2201381c87a18e46eba301a11e4ec3f5ec942877a7f8ca8746d9f3a2df94b
```

可运行 `python3 tools/check_repo.py --check-release` 验证本地交付文件；公开校验清单见 [APPIMAGE_SHA256SUMS](release/v2.5.0/APPIMAGE_SHA256SUMS)。

## MinerU 的当前机器限制

**v2.5.0 的 MinerU 接入是当前机器的固定配置，尚未提供通用安装向导或环境设置。** 当自定义 API 主机为 `127.0.0.1`、`localhost` 或 `::1` 时，导入的 PDF 在新批次开始前自动进入 MinerU 流程。

[mineru_bridge.py](mineru_bridge.py) 固定调用 `/home/xx/DS/MinerU/env.sh`，要求检测到唯一的 RTX 5060 Ti，并核验 CUDA 环境中只可见该卡。转换使用本地主机的 MinerU 环境、离线模型和 `hybrid-engine` / `high`。AppImage 不包含 Conda、CUDA、GPU 驱动、MinerU 权重或模型服务。换一台机器时，单纯复制 AppImage 无法满足这些条件；现有界面帮助中也保留了原机器路径。

每篇 PDF 依次转换。只有进程正常退出、主 Markdown 唯一且非空、页数匹配及文件哈希等检查全部通过，批次才进入评分。转换失败会停止该批评分并保留日志。补跑已冻结的 MinerU 批次复用原 Markdown；修改论文、参数或材料模式需要新建批次。

模型实际接收 Markdown 文本，Markdown 中的图片链接不会自动变成模型图像输入。转换图片随报告保存供人工核查。公式、表格、OCR 和图像说明仍需对照原 PDF；Markdown 引文页号也不代表原 PDF 物理页号。

## 基本操作与默认参数

首页按顺序设置 API 与评审参数、导入论文、检查报告输出目录、开始新批次。进行转换或评分时保持页面打开；刷新页面可能中断当前浏览器中的评分队列。先保存当前报告，再退出应用。

| 参数 | 源码默认值 |
| --- | --- |
| 默认接口 | `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions` |
| 模型 | `glm-5.3-flash` |
| 每篇轮数 / 并发 | 5 / 1 |
| 超时 / 额外重试 | 900 秒 / 0 次 |
| 温度 / top_p | 0.2 / 0.95 |
| 输出额度 / JSON mode | 32,768 tokens / 开启 |
| 思考 | `thinking: disabled`，省略 `reasoning_effort` |
| 采样 / seed | 发送 `do_sample: true` / 不发送 seed |
| 全文上限 | 每篇 2,000,000 字符 |

表中是程序预设，不代表供应商当前可用模型或额度承诺；自定义 API 应按实际支持项配置。浏览器可能保留用户之前修改过的设置。

轮数可设 1–30；少于三轮不提供排名或稳定性结论。单文件上限 32 MiB，一次导入总量上限 128 MiB，论文库上限 30 篇。目录导入跳过隐藏项和符号链接。

五维每维四项，模型为每项给出 0–4 的整数等级、理由和来源编号。程序计算 `1 + 9 × 四项等级和 / 16`，再应用固定瓶颈上限。一维只有四项均可计分才进入统计；材料缺失、格式错误和低分分别展示。计分与来源协议见 [CONTRACT_V2.md](CONTRACT_V2.md)，本机服务接口见 [WORKSPACE_API.md](WORKSPACE_API.md) 和 [MinerU 接口补充](docs/MINERU_API.md)。

## 数据与报告

每次保存生成独立的结构化目录，主要包含：

| 文件 | 内容 |
| --- | --- |
| `index.html` | 不依赖 CDN 的离线交互报告 |
| `archive.json` | 冻结协议、论文、尝试、原始请求/响应、结果与告警 |
| `source_catalog.json` | 引文原文、字符范围、页码与文本哈希 |
| `summary.csv`、`run_scores.csv`、`usage.csv` | 汇总、逐轮评分、接口实际返回的用量 |
| `execution_events.json` | 调度、暂停和恢复记录 |
| `source_metadata.json`、`assets/` | 材料来源、原 PDF 与文本附件 |

MinerU 转换另存于所选输出目录的 `mineru_md/`；离线报告复制转换附件并保存实际评分的 `score.md`。分享报告时应复制整个报告目录。

本机服务只监听回环地址，通过会话凭证管理文件与代理请求。程序会清理已知 API Key，但归档本身包含论文、路径、请求和模型回复，分享前仍应检查其内容。`.private/`、论文、报告、日志及旧版本不属于仓库源码。

## 开发与验证

编辑 `core.js`、`transport.js`、`app.js`、`template.html` 或 `style.css` 后，重新生成单文件页面并验证：

```bash
python3 assemble.py
python3 run_tests.py
python3 tools/check_repo.py
```

测试从最终 `index.html` 提取代码，并检查模板与生成页面一致。覆盖计分、来源校验、归档、队列、PDF 传输、本机服务、MinerU 桥接与离线导出。测试使用模拟模型和模拟主机命令，不需要 API Key 或 GPU；部分依赖本机样本的用例可能跳过。CI 运行同类本地检查，不执行真实模型评分或真实 GPU 转换。

[AppImage 冒烟记录](release/v2.5.0/smoke-results.json) 包含包内启动、组件、PDF 传输、模拟五维评分和退出验证，其中明确记录真实模型与真实 MinerU 调用均为零。真实运行验收和适用边界见 [验证摘要](release/v2.5.0/VALIDATION_SUMMARY.md)。测试通过不代表已经验证跨论文评分质量或稳定性。

后续开发见 [CONTRIBUTING.md](CONTRIBUTING.md)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。保留的初始快照可用 `python3 tools/check_repo.py --verify-snapshot` 校验；以后有意修改应用时，不应把初始快照清单静默改成新代码的哈希。

## 仓库与发布

Git 跟踪应用源码、测试、AppImage 构建源码、发布校验清单和文档。`dist/` 与 `local-snapshot/` 仅保存在本地；前者包含现有交付包，后者保留原安装说明等快照资料。

首次提交、连接远程仓库和创建草稿 Release 的步骤见 [GitHub 发布说明](docs/GITHUB_PUBLISH.md)。应用代码尚未指定开源许可证，见 [LICENSE-NOTICE.md](LICENSE-NOTICE.md)；随包组件另见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
