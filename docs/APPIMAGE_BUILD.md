# AppImage 2.5.0 构建与现有安装包

本仓库保留了 2.5.0 的程序源码，以及从原 `dist/packaging-source.tar.gz` 原样展开到 `appimage/` 的 9 个文件。构建脚本是该版本的快照；本次 GitHub 整理没有修改程序或打包脚本。

## 现有安装包与重新构建

本地副本的 `dist/Paperbench-Research-2.5.0-x86_64.AppImage` 是原安装包，SHA256 为：

```text
3af2201381c87a18e46eba301a11e4ec3f5ec942877a7f8ca8746d9f3a2df94b
```

已有安装包的来源清单保存在 [release/v2.5.0/](../release/v2.5.0/)。本地 `dist/` 和 `local-snapshot/` 不纳入 Git 跟踪；新克隆只包含受跟踪的源码、构建输入和发布元数据，不会自动带上本地 AppImage。

重新构建会使用当前主机的 Python、Node.js、Poppler、动态库和文件时间。现有脚本没有固定全部系统包版本，也没有实现确定性的时间与文件所有者设置，因此不能保证新产物与原安装包逐字节相同。新构建的 SHA256 应以实际生成结果为准。

## 构建环境

使用 **Ubuntu 22.04 x86_64 / amd64**。脚本明确依赖 `/usr/bin/python3.10`、`/usr/lib/python3.10`、`/usr/bin/pdftotext`、`/usr/bin/pdfinfo`、`ldd` 和 `mksquashfs`，并从 `PATH` 找到 Node.js。测试使用 Node.js 20+；Node.js 自带的 `fetch` 必须可用。

在构建主机上准备 Python 3.10、Node.js 20+、Poppler 和 SquashFS 工具。Ubuntu 系统工具可通过以下命令安装；Node.js 20+ 应另行准备并确认已在 `PATH` 中，Ubuntu 22.04 默认的 `nodejs` 软件包版本可能不满足要求。

```bash
sudo apt-get update
sudo apt-get install python3.10 poppler-utils squashfs-tools
python3.10 --version
node --version
command -v pdftotext pdfinfo mksquashfs ldd
```

源码程序和附带测试使用 Python、Node.js 内置模块，不需要 `npm install` 或 `pip install`。运行打包后的桌面入口还使用主机 `/usr/bin/xdg-open` 打开浏览器；图形错误对话框使用 `/usr/bin/zenity`。无浏览器验收通过 `--no-browser` 运行。

## 从新克隆构建

在仓库根目录执行以下命令。`--source .` 指定当前仓库，脚本会把构建产物放入 `appimage/`：

```bash
python3.10 assemble.py
python3.10 run_tests.py
python3.10 appimage/packaging/build.py --source . --version 2.5.0
```

构建输出包括：

```text
appimage/Paperbench-Research-2.5.0-x86_64.AppImage
appimage/Paperbench.AppDir/
appimage/build-config.json
appimage/bundle-manifest.json
appimage/source-manifest.json
appimage/payload.squashfs
```

`appimage/vendor/runtime-x86_64` 是原包使用的固定运行时，来源与许可证见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。构建时不需要重新下载 `continuous` 运行时。

脚本会删除并重新生成它自己的 `appimage/Paperbench.AppDir/` 和 `appimage/payload.squashfs`。请把个人文件放在这些构建目录之外。版本参数虽然接受数字版本格式，但归档脚本中的工作目录版本、页面验收和元数据仍针对 2.5.0；修改版本号本身不会完成新版本发布。

## 使用合成 PDF 做包内验收

以下验收只使用合成 PDF 和本机模拟服务，不需要 API Key、私人论文、真实模型或 GPU 转换：

```bash
python3.10 tools/make_smoke_pdf.py /tmp/paperbench-smoke.pdf
python3.10 appimage/packaging/smoke.py --source . --pdf /tmp/paperbench-smoke.pdf
```

脚本检查实际 AppImage 中的代码、内置运行时、PDF 字节传输、模拟评分、离线导出、单实例行为、退出鉴权以及 MinerU 主机环境隔离。它需要本机临时端口，并生成 `appimage/smoke-results.json`。合成材料不是真实论文，模拟评分不用于评价论文质量。

通过验收后，可生成独立的交付目录：

```bash
python3.10 appimage/prepare_delivery.py --target-dist "$PWD/appimage/delivery"
```

输出位于 `appimage/delivery/`。这里显式传入 `--target-dist`，因为归档脚本的默认桌面快捷方式目标仍是原安装目录。这个参数决定生成的 `.desktop` 文件使用哪个安装位置；移动交付目录后，应更新该快捷方式中的路径。该步骤不会上传、发布或安装应用。

重新打包仍沿用原打包器的许可证收集逻辑，不会自动把本仓库新增的 `third_party/` 材料装入 AppImage。第三方材料及其核验边界见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。 当前发布页另提供许可与致谢补充附件，包含项目 `LICENSE`、`NOTICE` 和新增第三方材料；发布重建版本时，应按该次真实依赖更新并一同提供这些材料，不能把初始 28 份包内文件视为全部组件声明。

## 版本保护与源码清单

`appimage/immutable-source.json` 和 `appimage/source_guards.py` 会核对固定的 `style.css`，并验证 `core.js` 只有指定的 MinerU 元数据扩展块；去除该块后，核心必须与记录的 2.4.1 基线哈希一致。`index.html` 也必须嵌入相同的核心代码。需要扩展评分逻辑时，应设计并验证新的发布流程，而不能把删除保护检查当成普通构建步骤。

仓库首页 `README.md` 是为 GitHub 整理的新说明。原安装包内仍包含原版 README；其哈希由 `release/v2.5.0/source-manifest.json` 记录。原 README 的本地备份在 `local-snapshot/README.installed.md`，该目录不提交 Git。新克隆用仓库首页 README 构建时，包内 README 及新生成的 `appimage/source-manifest.json` 会相应变化；历史发布清单用于验证历史包，不能直接用于断言新 README 的哈希相同。

## 每台机器需要自行配置的部分

MinerU 桥接层保留固定入口 `/home/xx/DS/MinerU/env.sh`。其他机器要使用 PDF → Markdown 流程，需要准备该入口对应的环境，或在后续版本中明确修改桥接配置并重新测试、构建。AppImage 不包含 MinerU、Conda、CUDA、GPU 驱动或模型权重。

页面断开本机服务时显示的启动提示仍指向原路径 `/home/xx/chatgpt/paper_benchmark_codex/start_local.py`；从本仓库运行源码时，应在仓库根目录使用 `python3 start_local.py` 或 `./启动论文评审.sh`。此提示文本被保留以保持当前程序字节一致。

AppImage 启动器优先使用自己的应用数据目录，另保留原 `~/chatgpt/paper_benchmark_codex` 私密配置和输出目录作为兼容候选。显式传入 `--profile /path/to/model_config.json` 和 `--data-dir /path/to/app-data` 可选择配置及应用数据位置；网页中可选择报告输出目录。仓库不提供真实 API Key、论文、报告、浏览器状态或主机模型环境。
