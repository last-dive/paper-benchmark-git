# 致谢与引用

Paperbench Research 感谢下列项目的作者、维护者与贡献者。它们为本机服务、PDF 处理、离线报告、桌面启动和构建验证提供基础能力。**本项目的本机 PDF → Markdown 流程使用 OpenDataLab / MinerU。**

本页按实际源码、构建脚本和已核验的宿主配置整理，核验日期为 **2026-09-13**。项目名称和链接用于说明来源；不表示这些组织或作者参与了本项目、认可其评分方法或为评分结果背书。

## 软件、工具与服务

| 项目与贡献者 | 本项目中的用途 | 来源与许可材料 |
| --- | --- | --- |
| Python Software Foundation 与 CPython 贡献者 | 本机 HTTP 服务、文件管理、模型请求代理、打包及测试 | [Python](https://www.python.org/)、[Python 3.10 许可说明](https://docs.python.org/3.10/license.html)；包内版本见[随包组件清单](third_party/BUNDLED_DEPENDENCIES.md) |
| Node.js 与其依赖项目的贡献者 | 执行离线报告导出器、命令行评审工具和 JavaScript 测试 | [Node.js](https://nodejs.org/)、[上游许可及内含第三方声明](https://github.com/nodejs/node/blob/main/LICENSE)；实际随包声明见[组件清单](third_party/BUNDLED_DEPENDENCIES.md) |
| Poppler 及所用底层库的贡献者 | `pdftotext` 提取引文核对文本，`pdfinfo` 核对 PDF 页数 | [Poppler](https://poppler.freedesktop.org/)、[随包组件与版权材料](third_party/BUNDLED_DEPENDENCIES.md) |
| AppImage 运行时与静态依赖的贡献者 | Linux 单文件应用运行时及 SquashFS 载荷读取 | [AppImage type2-runtime](https://github.com/AppImage/type2-runtime)、[本包运行时 LICENSE](third_party/appimage-runtime/LICENSE)、[静态依赖来源清单](third_party/runtime-components.json) |
| OpenDataLab / MinerU 团队及其依赖项目的贡献者 | 在独立宿主环境中把本机 API 模式的 PDF 转为 Markdown | [MinerU](https://github.com/opendatalab/MinerU)、[实际安装的 3.4.5 许可证](third_party/host-notices/mineru-3.4.5/LICENSE.md)、[宿主依赖说明](third_party/HOST_DEPENDENCIES.md) |
| PyTorch 与 Conda 贡献者 | PyTorch 核验 CUDA 可见设备并支持 MinerU 环境；Conda 激活独立环境 | [PyTorch](https://pytorch.org/)、[实际安装的 PyTorch 2.11.0 LICENSE](third_party/host-notices/torch-2.11.0/LICENSE)、[NOTICE](third_party/host-notices/torch-2.11.0/NOTICE)、[Conda](https://github.com/conda/conda) |
| OpenDataLab 模型作者 | 宿主配置中的 MinerU2.5-Pro-2605-1.2B VLM 与 PDF-Extract-Kit-1.0 模型目录 | [VLM 官方模型卡](https://huggingface.co/opendatalab/MinerU2.5-Pro-2605-1.2B)、[PDF-Extract-Kit 模型仓库](https://huggingface.co/opendatalab/PDF-Extract-Kit-1.0)；权重独立授权，详见[核验范围](third_party/HOST_DEPENDENCIES.md#模型权重与外部评审服务) |
| NVIDIA | MinerU 宿主路径使用 NVIDIA GPU、驱动、`nvidia-smi` 和 CUDA 环境 | [驱动许可](https://www.nvidia.com/en-us/drivers/nvidia-license/)、[CUDA 许可](https://docs.nvidia.com/cuda/eula/index.html)；这些组件不随本 AppImage 分发 |
| Linux、GNU、Ubuntu 与 Debian 社区 | 已验证的 Linux / Ubuntu 环境、宿主系统库、Shell、基础命令和系统软件包 | [Linux](https://www.kernel.org/)、[GNU](https://www.gnu.org/)、[Ubuntu](https://ubuntu.com/)、[Debian](https://www.debian.org/)；各软件包分别授权 |
| GNOME / Zenity 与 freedesktop.org / xdg-utils 贡献者 | 本机文件与目录选择、错误对话框和默认浏览器打开 | [Zenity](https://gitlab.gnome.org/GNOME/zenity)、[xdg-utils](https://wiki.freedesktop.org/www/Software/xdg-utils/)；由宿主安装提供 |
| SquashFS 工具贡献者 | 构建时通过 `mksquashfs` 生成压缩载荷 | [squashfs-tools](https://github.com/plougher/squashfs-tools)、[COPYING](https://github.com/plougher/squashfs-tools/blob/master/COPYING) |
| GitHub Actions 与 actions 维护者 | 在 Ubuntu runner 上检出代码、设置 Node.js 并运行测试 | [actions/checkout](https://github.com/actions/checkout)、[actions/setup-node](https://github.com/actions/setup-node)、[本项目 CI 配置](.github/workflows/ci.yml) |
| 智谱 / BigModel 的 GLM 服务团队 | 提供源码默认配置所指向的外部模型 API | [BigModel](https://open.bigmodel.cn/)、[官方接入文档](https://docs.bigmodel.cn/cn/coding-plan/quick-start)；具体调用权限及服务条件由供应商管理 |

随 AppImage 分发的底层库同样是本项目的重要基础。其逐项项目来源、软件包版本和版权文件集中列在[随包依赖说明](third_party/BUNDLED_DEPENDENCIES.md)、[随包机器可读清单](third_party/bundled-components.json)及[运行时静态依赖清单](third_party/runtime-components.json)，作为本页致谢的一部分。Node.js 与 PyTorch 原始 LICENSE 中记录的内含依赖及作者声明也予以完整保留。

界面和离线报告由本项目的 HTML、CSS、JavaScript 与浏览器标准 API 实现。源码没有外部脚本、样式、图表框架或字体 CDN；CSS 字体栈只引用用户系统已安装字体，未随仓库或 AppImage 分发字体文件。浏览器和系统字体由用户环境独立提供。

## 研究引用

以下条目由各自上游的 Citation 区或 `CITATION.cff` 确认。研究使用了对应转换流程或基础软件时，可连同实际版本、模型配置和运行记录一起引用；这些论文不验证 Paperbench 的评分方法。

1. Bin Wang et al. (2024). **MinerU: An Open-Source Solution for Precise Document Content Extraction**. arXiv:2409.18839. [论文](https://arxiv.org/abs/2409.18839) · [MinerU 上游引用指引](https://github.com/opendatalab/MinerU#citation)。适用于说明 MinerU 文档解析来源。
2. Bin Wang et al. (2026). **MinerU2.5-Pro: Pushing the Limits of Data-Centric Document Parsing at Scale**. arXiv:2604.04771. [论文](https://arxiv.org/abs/2604.04771) · [实际配置模型的官方引用指引](https://huggingface.co/opendatalab/MinerU2.5-Pro-2605-1.2B#4-acknowledgement--citation)。该模型用于宿主文档解析；与最终评审 API 的模型身份分别记录。
3. Jason Ansel et al. (2024). **PyTorch 2: Faster Machine Learning Through Dynamic Python Bytecode Transformation and Graph Compilation**. ASPLOS 2024. DOI: [10.1145/3620665.3640366](https://doi.org/10.1145/3620665.3640366). [PyTorch 官方推荐引用](https://github.com/pytorch/pytorch/blob/main/CITATION.cff)。这是上游推荐的软件引用，本文档没有声称桥接预检使用了论文中所有编译能力。

其他软件的引用入口为上表及随包清单中的官方项目、源码与许可证链接。模型供应商可能通过同一 API 名称部署不同权重；最终评审模型应以实际使用者能够确认的供应商资料、模型版本及归档记录另行引用。

## 引用本项目

引用本工作台时请注明 **Paperbench Research · 论文评审工作台**、实际版本和仓库地址，并记录使用的 Git 提交或 Release。例如：

> Paperbench Research · 论文评审工作台，v2.5.0（2026），[项目仓库](https://github.com/last-dive/paper-benchmark-git)，[v2.5.0 发布记录](https://github.com/last-dive/paper-benchmark-git/releases/tag/v2.5.0)。

研究结果还应注明输入材料模式、评审 API 与模型、轮数、冻结参数和引文协议，以便解释实际执行过程。论文引用和致谢不能代替许可证正文；项目自身授权见 [LICENSE-NOTICE.md](LICENSE-NOTICE.md)，第三方材料范围见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
