# 论文评审工作台 · Ubuntu AppImage 2.5.0

在 Ubuntu 应用菜单搜索 **论文评审工作台** 即可启动本机服务并打开浏览器，无需手动执行 Python 命令。升级前先在旧页面点击 **退出应用**；启动器会阻止新版复用旧版本实例。

**2.5.0 增加主机 MinerU 转换流程：PDF → Markdown → 模型评分。**转换与评分是两个明确步骤；模型实际收到的是转换后的 Markdown 及其引文定位索引。程序不会将本地模型读取 Markdown 描述为原生读取 PDF。自定义 API 地址为 localhost 等本机地址时，导入的 PDF 会先进入 MinerU 流程，即使页面沿用旧版 PDF 模式也不会绕过转换。云端 API 的原始 PDF 流程保持原样。转换失败不会自动改用其他输入方式。

`core.js` 仅增加 MinerU 归档元数据保存与校验块，评分算法、量表和 `PB-PARSER-2.4` 解析器未修改，`style.css` 与 2.4.1 保持逐字节一致。输入处理、页面交互和传输代码有更新。逐项校验、部分结果保留、调度审计和离线查看规则继续适用；转换质量仍须结合原 PDF 检查，尤其是公式、表格和图片。

也可运行 `Paperbench-Research-2.5.0-x86_64.AppImage`。若机器没有 FUSE：

```bash
./Paperbench-Research-2.5.0-x86_64.AppImage --appimage-extract-and-run
```

应用菜单入口已包含上述兼容参数。移动 AppImage 后需更新菜单路径；复制到其他电脑后，在文件属性中允许作为程序执行。

## MinerU 主机环境

AppImage 只包含桥接代码 `mineru_bridge.py`，**不包含 Conda 环境、CUDA、GPU 驱动、MinerU 模型权重或主机 API Key**。转换时调用当前机器的固定入口：

```text
/home/xx/DS/MinerU/env.sh
```

因此，其他电脑仅复制 AppImage 不足以使用 MinerU；需要另外准备此入口及其依赖。具体硬件、模型和转换验收记录见程序 README 与 `validation/v2.5.0`。

桥接层用独立的主机环境启动命令，移除 AppImage 的 Python、动态库和 Poppler 设置，并使用主机系统 PATH；GPU 选择和离线模型读取由桥接层与主机环境处理。网页不能自定义 shell 命令或替换脚本路径。关闭应用时会关闭应用管理的转换任务。

## 配置、数据和报告

- AppImage 不含 API Key、用户论文或历史报告。当前机器保留并读取原程序目录的 `.private/model_config.json`；已有配置不复制、不修改。
- 私密配置读取顺序：应用数据目录、AppImage 同级及上级目录的 `.private/model_config.json`，最后是 `~/chatgpt/paper_benchmark_codex/.private/model_config.json`。`--profile /path/model_config.json` 可明确指定；指定不存在的文件时不读取其他位置。
- 新版可写工作文件位于 `${XDG_DATA_HOME:-~/.local/share}/paperbench-research/app-2.5.0`，旧版本工作文件保留。
- 默认报告目录是 `~/chatgpt/paper_benchmark_codex/output`；不存在时使用应用数据目录下的 `output`。网页可指定其他目录，已有报告不覆盖。
- 保留转换目录结构，尤其是 Markdown 引用的图片与转换清单。离线报告应整目录复制；`index.html` 可直接双击查看，Markdown、图片、原 PDF 与来源元数据的实际保存范围以报告中的材料清单为准。
- 默认端口 8788，占用时选择空闲端口。使用启动器打开的地址；端口改变后可以导入已保存归档。
- 评分或转换运行时不要刷新或关闭页面。关闭浏览器不会自动关闭本机服务；需要退出时使用 **退出应用**，退出前先保存报告。
- 离线阅读不需要 API Key、AppImage 或 MinerU。重新转换需要主机 MinerU，重新评分需要可用的模型服务。

## 验证范围

`smoke-results.json` 记录实际 AppImage 解包启动、包内 SHA256、内置 Python/Node/Poppler、重复启动复用、模拟模型完整五维评分、原 PDF 传输回归、离线导出及退出鉴权。另用包内桥接代码和模拟主机命令核验环境隔离，不启动真实 GPU 转换，也不调用真实模型。

真实 MinerU 与本机模型验收单独记入程序目录 `validation/v2.5.0`，只以记录中的实际成功结果为准。模拟验收不用于判断论文质量；少量真实验收不足以证明跨论文评分稳定性。

适用架构为 x86_64 / amd64，在 Ubuntu 22.04 验证。菜单入口为 `~/.local/share/applications/paperbench-research.desktop`，图标为 `~/.local/share/icons/hicolor/scalable/apps/paperbench-research.svg`。删除菜单入口和 AppImage 可移除启动程序，报告与应用数据可保留。

## 构建与来源

`packaging-source.tar.gz` 含构建脚本、启动器、验收脚本和 AppImage 官方运行时。在 Ubuntu 22.04 x86_64 安装 `mksquashfs`、Python 3.10、Node 和 Poppler 后：

```bash
python3 packaging/build.py --source /path/to/paper_benchmark --version 2.5.0
python3 packaging/smoke.py --source /path/to/paper_benchmark --pdf /path/to/paper.pdf
```

构建器只复制明确列出的程序文件，不收集 `.private`、Conda、模型缓存、浏览器数据、论文或报告。包内文件哈希见 `bundle-manifest.json`，源程序哈希见 `source-manifest.json`，交付文件哈希见 `SHA256SUMS`。`immutable-source.json` 冻结样式并记录基线核心哈希；构建与部署要求新增元数据块恰好出现一次，移除两行标记及整块（含行末换行）后，核心文件必须与 2.4.1 基线逐字节一致；内嵌 HTML 也必须使用同一核心文件。

运行时来自 [AppImage 官方仓库](https://github.com/AppImage/type2-runtime)，使用说明见 [AppImage 官方文档](https://docs.appimage.org/user-guide/run-appimages.html)。内置组件版权文件位于包内 `usr/share/licenses`；源码见 [Python](https://www.python.org/downloads/source/)、[Node.js](https://github.com/nodejs/node)、[Poppler](https://poppler.freedesktop.org/)。主机 MinerU 的安装与许可证独立管理。
