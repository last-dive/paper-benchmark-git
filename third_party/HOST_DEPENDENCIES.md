# 宿主、构建依赖与外部服务

本文对应 Paperbench Research **v2.5.0**，核验日期 **2026-09-13**。范围为项目直接调用的运行时、系统命令、构建/CI 工具，以及已有 MinerU 入口的只读安装元数据。随 AppImage 复制的库另见 [BUNDLED_DEPENDENCIES.md](BUNDLED_DEPENDENCIES.md)；两类材料共同组成[第三方说明](../THIRD_PARTY_NOTICES.md)。

## 来源和分发范围

| 范围 | 实际组件 | 证据与分发情况 |
| --- | --- | --- |
| 应用源码 | Python 标准库、Node.js 内置模块、项目内部模块、浏览器标准 API | 检查根目录与测试中的 Python imports、CommonJS `require`、`template.html`、`style.css`、生成页面；没有第一方应用所需的 pip/npm 外部包，也没有 CDN、外部图表库或下载字体 |
| AppImage 内置运行时 | CPython 3.10、Node.js、Poppler 工具与数据、相应动态库、AppImage type2-runtime 及其静态依赖 | [构建脚本](../appimage/packaging/build.py)、[已有包清单](../release/v2.5.0/bundle-manifest.json)；准确版本与许可见[随包索引](BUNDLED_DEPENDENCIES.md)、[静态运行时索引](runtime-components.json) |
| 宿主通用能力 | Linux、系统 C 库/动态加载器、Shell、基础命令、图形桌面、浏览器和系统字体 | 构建脚本明确排除 glibc 核心库与动态加载器；这些能力仍由运行机器提供 |
| 构建与 CI | Ubuntu 22.04 x86_64、Python、Node.js、Poppler、`ldd`、`mksquashfs`、GitHub Actions | [构建说明](../docs/APPIMAGE_BUILD.md)、[CI 配置](../.github/workflows/ci.yml)；CI 配置 Node.js 24，源码运行要求 Node.js 20+；CI 不进行真实模型或 GPU 转换 |
| 可选宿主 PDF 转换 | MinerU、独立 Conda 环境、PyTorch、GPU 驱动/CUDA 环境、本地模型 | [mineru_bridge.py](../mineru_bridge.py) 固定主机入口，仅本机自定义 API 的 PDF 流程需要；均未放入 AppImage |
| 外部评审服务 | BigModel 默认端点或用户配置的兼容 API | [start_local.py](../start_local.py)、[transport.js](../transport.js)；通过 HTTP 请求使用，没有随包分发评审模型权重或供应商 SDK |

Python 标准库的使用涉及网络、JSON/CSV、文件与进程管理等；Node.js 导出器和命令行工具使用 `node:fs`、`node:path`、`node:vm`、`node:crypto`、`node:readline`，测试还使用内置测试模块。MinerU 子进程环境中的第三方 Python 包不属于这里所说的“应用只用标准库”。

## 通用宿主与构建工具

| 组件 | 用途与必要条件 | 官方来源及许可说明 |
| --- | --- | --- |
| Python / CPython | 源码启动和测试要求 Python 3.10+；构建脚本指定系统 Python 3.10 | [Python 3.10 许可](https://docs.python.org/3.10/license.html)包含 PSF 及历史/内含组件的条款；随包原始声明优先于概括标签 |
| Node.js | 离线报告导出、命令行任务与 JavaScript 测试 | [Node.js LICENSE](https://github.com/nodejs/node/blob/main/LICENSE)：Node.js 本体 MIT，并保留内含组件的独立许可 |
| Poppler `pdftotext` / `pdfinfo` | 源码运行时提供文字提取和页数检查；MinerU 桥接固定执行宿主 `/usr/bin/pdfinfo`，即使 AppImage 另有内置副本 | [Poppler](https://poppler.freedesktop.org/)；本包对应的 GPL 等具体材料见[随包清单](BUNDLED_DEPENDENCIES.md) |
| Linux / Ubuntu | 完整桌面流程已在 Ubuntu 22.04 x86_64 验证，宿主提供内核、用户空间和图形桌面 | [内核许可规则](https://www.kernel.org/doc/html/latest/process/license-rules.html)、[Canonical 知识产权政策](https://canonical.com/legal/intellectual-property-policy)；Ubuntu 的软件包各有许可证 |
| GNU Bash、Coreutils、glibc 工具和宿主 POSIX Shell | 启动脚本使用 `/bin/bash`；AppImage 的 `/bin/sh` 包装器调用 `dirname`、`env`；构建脚本用 `ldd` 枚举共享库 | [Bash](https://www.gnu.org/software/bash/)、[Coreutils](https://www.gnu.org/software/coreutils/)、[glibc](https://www.gnu.org/software/libc/)；按宿主实际包的 copyright / COPYING 读取，不能从一个 Shell 路径推定所有基础程序的许可证 |
| Zenity | 可选文件/目录选择；AppImage 错误对话框使用 `/usr/bin/zenity` | [GNOME 官方仓库](https://gitlab.gnome.org/GNOME/zenity)、[官方只读镜像](https://github.com/GNOME/zenity)。当前上游说明 LGPL-2.1-or-later；本机 Ubuntu 包 copyright 的表述为 LGPL version 2 or later，按实际安装文件核对 |
| xdg-utils / `xdg-open` | AppImage 启动器通过 `/usr/bin/xdg-open` 打开系统默认浏览器 | [官方项目](https://wiki.freedesktop.org/www/Software/xdg-utils/)、[官方源码](https://gitlab.freedesktop.org/xdg/xdg-utils)；本机包 copyright 标为 Expat/MIT |
| squashfs-tools / `mksquashfs` | 构建阶段生成 Zstandard 压缩载荷；不是应用内置的独立命令 | [官方项目](https://github.com/plougher/squashfs-tools)、[COPYING](https://github.com/plougher/squashfs-tools/blob/master/COPYING)；本机软件包标为 GPL-2.0-or-later |
| GitHub Actions：`actions/checkout@v7`、`actions/setup-node@v7` | CI 检出仓库并提供 Node.js；`apt-get` 安装 Poppler 和 Zenity | [checkout 许可](https://github.com/actions/checkout/blob/v7/LICENSE)、[setup-node 许可](https://github.com/actions/setup-node/blob/main/LICENSE)：MIT；实际引用见[工作流](../.github/workflows/ci.yml)。Action 本身的依赖由其上游声明管理，不随 AppImage 复制 |

构建器直接连接已保存的 AppImage runtime 与 `mksquashfs` 输出；源码没有调用 `appimagetool`，也没有 npm/pip 安装步骤。浏览器和系统字体不在本包交付范围，CSS 的候选字体名称不表示已经分发对应字体。

## MinerU 独立环境

本项目的本机 PDF → Markdown 转换由 **OpenDataLab / MinerU** 提供。[桥接源码](../mineru_bridge.py)固定调用 `/home/xx/DS/MinerU/env.sh`；只读检查该脚本确认它加载 `/home/xx/anaconda3/etc/profile.d/conda.sh`、激活 `mineru34` 并设置 `MINERU_MODEL_SOURCE=local`。转换参数为 `hybrid-engine` / `high`。桥接通过 `nvidia-smi` 和宿主 `torch.cuda` 预检，只接受隔离后可见的唯一 RTX 5060 Ti。

本次没有执行环境脚本、导入 PyTorch、运行 `nvidia-smi`、加载权重或进行 PDF 转换；版本来自安装元数据，不是本次运行验收。没有读取 API 凭据。

| 组件 | 已核验安装元数据 | 来源、许可与保留材料 |
| --- | --- | --- |
| MinerU | `mineru==3.4.5`，位于 `mineru34` 的 Python 3.12 site-packages；`License-Expression: LicenseRef-MinerU-Open-Source-License` | [官方项目](https://github.com/opendatalab/MinerU)、[上游 LICENSE](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md)、[安装版原始 LICENSE.md](host-notices/mineru-3.4.5/LICENSE.md) |
| PyTorch | `torch==2.11.0`，同一环境；元数据 `License: BSD-3-Clause` | [官方项目](https://github.com/pytorch/pytorch)、[安装版原始 LICENSE](host-notices/torch-2.11.0/LICENSE)、[NOTICE](host-notices/torch-2.11.0/NOTICE)。原 LICENSE 含多个依赖项目的完整条款，不能仅以 BSD 标签代替 |
| Conda | 激活脚本所处安装的包记录为 `conda==25.11.0`，元数据标 BSD-3-Clause | [Conda 官方 LICENSE](https://github.com/conda/conda/blob/main/LICENSE)。Conda 软件许可与 Anaconda 发行版/包源的服务条件分别管理；本项目不分发该环境 |
| NVIDIA 驱动、`nvidia-smi` 与 CUDA 环境 | 根据桥接命令和 CUDA 环境变量确认用途；本次不查询设备或断言 CUDA/驱动的具体版本 | [驱动许可](https://www.nvidia.com/en-us/drivers/nvidia-license/)、[CUDA EULA](https://docs.nvidia.com/cuda/eula/index.html)；以实际安装组件附带条款为准，不随 AppImage 分发 |

**MinerU 3.4.5 的安装许可证是 Apache 2.0 加附加条款。** 附加条件包括：使用者及关联方合并月活超过 1 亿或月总收入超过 2,000 万美元时，需要另获商业许可；基于 MinerU 向第三方提供在线服务时，须在界面或公开文档清楚标明使用 MinerU；未满足相应条款会触发许可终止。准确措辞见[保存的原文](host-notices/mineru-3.4.5/LICENSE.md)和[上游原文](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md)，其引用的 Apache 2.0 正文另见[官方许可证](https://www.apache.org/licenses/LICENSE-2.0)。不能把这一版本标成无附加条件的 Apache-2.0，也不能直接套用旧版 MinerU 的 AGPL 标签。

三个原始许可文件逐字节复制自对应 `.dist-info/licenses/`。版本、原始绝对路径、文件大小、SHA-256、元数据摘要和官方 URL 记录于 [host-notices/PROVENANCE.json](host-notices/PROVENANCE.json)。没有复制程序、权重、整份 Conda 环境或私有配置。这里保留的是本机准确安装文件，未声称移动分支上的最新 LICENSE 对应同一构建，也未完成整个 MinerU 环境所有传递依赖的许可审计。

## 模型权重与外部评审服务

只按白名单检查 `/home/xx/mineru.json` 的 `models-dir.pipeline` 与 `models-dir.vlm` 字段，并确认两个目录存在：

| 配置对象 | 已核验事实 | 官方来源与许可边界 |
| --- | --- | --- |
| MinerU VLM | 配置目录名为 `MinerU2.5-Pro-2605-1.2B`；本地模型卡与官方模型卡标记 `apache-2.0` | [官方模型卡与研究引用](https://huggingface.co/opendatalab/MinerU2.5-Pro-2605-1.2B)。模型权重许可与 MinerU 3.4.5 软件的附加条款分别读取 |
| MinerU pipeline 模型目录 | 配置目录名为 `PDF-Extract-Kit-1.0`，目录存在 | [官方模型仓库](https://huggingface.co/opendatalab/PDF-Extract-Kit-1.0)的顶层说明标记 `agpl-3.0`；不能据目录名推定每个文件的许可或实际使用情况 |

这里只核对配置、目录与可见模型卡，未对权重文件逐一计算哈希，也未证明一次 `hybrid-engine` 转换会加载目录中的每个模型。集合中各模型的实际版本、来源、授权和引用仍应结合其模型卡及运行记录核对；本项目与 AppImage **不分发这些模型权重**。

评审 API 与上述解析模型是两个阶段。源码默认端点为 `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`，默认请求模型名为 `glm-5.3-flash`；这是源码配置事实，不是对供应商当前模型可用性、权重版本或授权范围的认证。参见 [BigModel 官方接入文档](https://docs.bigmodel.cn/cn/coding-plan/quick-start)与使用者账户所适用的服务条件。

自定义兼容 API 由用户提供地址与模型名。API 返回名称、测试用名称或历史日志中的名称不能单独证明底层权重身份，因此本文不为未核验的最终评审模型补写许可证或论文。服务、权重和 SDK 各有自己的条款；本程序通过标准 HTTP 接口调用，没有安装供应商 SDK，也没有分发 GLM 或其他评审模型权重。

项目与论文引用见 [ACKNOWLEDGMENTS.md](../ACKNOWLEDGMENTS.md)。所有上游名称用于归属说明，不代表上游对本项目评分规则或输出提供认可。
