# 第三方组件、引用与版权声明

Paperbench Research 感谢所有上游作者和维护者。**第三方组件继续适用各自原有的许可和版权声明；本项目的非商业许可不限制它们原先授予的权利。** 项目原创部分的范围见 [LICENSE-NOTICE.md](LICENSE-NOTICE.md)，软件与研究引用见 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)。

本清单针对保存的 **v2.5.0 AppImage** 与当前桥接代码，区分实际随包分发的组件、主机可选依赖、构建工具和外部模型服务。未将一份虚拟环境中所有已安装包都当作本应用的直接依赖。

## 完整组件索引

| 范围 | 索引与原始材料 | 核验方法 |
| --- | --- | --- |
| AppImage 中的 Python、Poppler、系统动态库、扩展模块与数据 | [BUNDLED_DEPENDENCIES.md](third_party/BUNDLED_DEPENDENCIES.md)、[bundled-components.json](third_party/bundled-components.json) | 对实际包文件与发行版包进行字节/哈希对应，记录包版本、上游和版权文件。 |
| Node.js 与其内嵌第三方组件 | 同一 [随包索引](third_party/BUNDLED_DEPENDENCIES.md) 和 [原始 Node LICENSE](third_party/bundled-notices/node.txt) | 核对官方相同版本发行物的 Node 二进制与 LICENSE；内嵌组件使用其独立条款。原 LICENSE 的构建/测试材料不一概视为运行时功能。 |
| AppImage runtime 与静态库 | [runtime-components.json](third_party/runtime-components.json)、[运行时 LICENSE](third_party/appimage-runtime/LICENSE)、[静态库许可正文](third_party/appimage-runtime/dependency-licenses/) | 运行时自身报告的固定提交、固定版本构建脚本、源码档哈希和上游版权文本。 |
| 当前主机的 MinerU、PyTorch、模型配置与工具 | [HOST_DEPENDENCIES.md](third_party/HOST_DEPENDENCIES.md)、[host-notices/](third_party/host-notices/) | 仅读取已安装版本元数据及许可证；模型、CUDA、驱动和宿主环境不在 AppImage 中。 |
| 构建、CI、浏览器能力及外部服务 | [致谢与引用](ACKNOWLEDGMENTS.md)、[主机依赖说明](third_party/HOST_DEPENDENCIES.md) | 按源码实际调用关系区分；外部 API、服务条款与模型许可独立管理。 |

## 保存的版权材料

原有 28 份包内版权文件位于 [bundled-notices/](third_party/bundled-notices/)，其来源与 SHA-256 记录在 [初始 INVENTORY.json](third_party/INVENTORY.json)。另有原版权文件引用的 13 份 [通用许可证正文](third_party/common-licenses/)，保留原文件名；这些别名不能代替每个组件实际指定的许可证版本。

本次补充缺失的系统包版权文件，并记录在 [SUPPLEMENTAL_INVENTORY.json](third_party/SUPPLEMENTAL_INVENTORY.json)；新增内容覆盖原说明遗漏的 Brotli、Kerberos、Poppler 字符映射数据及 Python 分包等。所有材料保留上游原文。不同文件的多个许可证、例外、作者清单应一并阅读，不能用一个概括标签覆盖它们。

运行时静态库另外保存 9 份许可/版权文件，覆盖 **musl、libfuse、squashfuse、zstd、zlib、mimalloc**。其中 mimalloc 在固定 Makefile 中以 `-lmimalloc` 链接，原运行时顶层 LICENSE 的依赖列表没有列出它，故在本次索引中补充。libfuse 的库和头文件使用 LGPL 条款，其他源码部分另有 GPL 条款；两份正文均保留。

## 固定安装包与运行时身份

现有 AppImage 的 SHA-256：

```text
3af2201381c87a18e46eba301a11e4ec3f5ec942877a7f8ca8746d9f3a2df94b
```

其前 944,632 字节与 `appimage/vendor/runtime-x86_64` 一致，运行时 SHA-256：

```text
1cc49bcf1e2ccd593c379adb17c9f85a36d619088296504de95b1d06215aebbf
```

运行时报告提交 `75849dc`，对应 [`75849dce7cc37e4319b633df1f116ca895c71a12`](https://github.com/AppImage/type2-runtime/tree/75849dce7cc37e4319b633df1f116ca895c71a12)。本次保留了该提交的 [构建证据](third_party/appimage-runtime/build-evidence/)，未执行这些上游构建脚本。其依赖脚本固定了 libfuse 3.15.0 与 squashfuse 0.5.2 的源码和校验值；Alpine 3.21 提供的其余静态依赖未全部固定包修订号，因此索引对“构建已固定版本”和“补充版权文本的来源版本”作了区分，不将后者冒充二进制版本证明。

## 对应源码与再分发边界

这些文件是依赖归属、版权文本和来源证据，**不等于所有 GPL/LGPL 组件的完整对应源码、构建环境或重链接材料**。随包索引提供了能核对的源包版本和上游来源；发布者仍需按相关 GPL/LGPL 条款提供其要求的材料，不能仅以“已致谢”替代相应义务。运行时的固定构建源码也包含 libfuse 补丁，应和相关源码一起核对。

本项目不把整个 AppImage 重新授权为 PolyForm Noncommercial。原创程序通过独立进程调用 PDF 工具；包内库、独立工具以及其修改的授权关系仍由各自条款决定。GNU 对独立组件集合的说明见 [GPL FAQ：Mere Aggregation](https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation)。

本次新增许可资料以独立的 `Paperbench-Licensing-and-Notices-2.5.0-20260913.tar.gz` 附在 [v2.5.0 发布页](https://github.com/last-dive/paper-benchmark-git/releases/tag/v2.5.0)，附带独立 SHA-256 校验文件。既有 AppImage 与原校验清单保持不变，旧包内部仍是原先的版权文件集合。转发已有安装包时，应同时提供这份补充资料并遵守每个第三方组件的适用条款；未来重建应把当时实际依赖的材料随新包收集和验证。
