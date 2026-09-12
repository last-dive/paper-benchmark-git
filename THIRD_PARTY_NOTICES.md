# 第三方组件与许可证来源

本目录整理现有 **Paperbench Research 2.5.0 AppImage** 的第三方版权文件，并补充其中引用的通用许可证正文。它不为项目自身选择许可证；项目自身的授权状态见 [LICENSE-NOTICE.md](LICENSE-NOTICE.md)。

## 已保存的材料

| 材料 | 位置 | 来源与核验 |
| --- | --- | --- |
| 包内现有的 28 份版权文件 | [third_party/bundled-notices/](third_party/bundled-notices/) | 从已有构建目录复制；逐一核对原 AppImage 内的实际文件，以及 `release/v2.5.0/bundle-manifest.json` 中的 SHA256。 |
| 被上述版权文件引用的 13 份通用许可证正文 | [third_party/common-licenses/](third_party/common-licenses/) | 复制自主机 `/usr/share/common-licenses`；保留被引用的文件名，清单记录原始路径、符号链接解析后的文件名和 SHA256。 |
| 与现有 AppImage 运行时版本对应的上游 LICENSE | [third_party/appimage-runtime/LICENSE](third_party/appimage-runtime/LICENSE) | 从 AppImage 官方仓库的固定提交下载；来源与版本说明见下文。 |
| 每个文件的来源、字节数和 SHA256 | [third_party/INVENTORY.json](third_party/INVENTORY.json) | 可独立复核的材料清单。 |

28 份包内文件包括 Python 3.10、Node.js、Poppler 工具及若干动态库的版权说明。原打包脚本只复制了它明确列出的系统包版权文件和检测到的 Node.js `LICENSE`。本次补充文件保存在仓库中，**没有改写已有 AppImage，也没有修改原打包脚本**。

部分版权文件引用 `GPL`、`LGPL`、`GFDL` 等通用文件名。这里保留了原始名称，并在清单中记录主机实际解析的版本；不能据此把单个组件的授权条件简化成这些别名对应的最新版本，应结合该组件的版权说明阅读。

## AppImage 运行时

保留的 AppImage SHA256：

```text
3af2201381c87a18e46eba301a11e4ec3f5ec942877a7f8ca8746d9f3a2df94b
```

其前 944,632 字节与 `appimage/vendor/runtime-x86_64` 完全一致，运行时 SHA256 为：

```text
1cc49bcf1e2ccd593c379adb17c9f85a36d619088296504de95b1d06215aebbf
```

该二进制的 `--appimage-version` 输出提交 `75849dc`。官方仓库将它解析为完整提交 [`75849dce7cc37e4319b633df1f116ca895c71a12`](https://github.com/AppImage/type2-runtime/tree/75849dce7cc37e4319b633df1f116ca895c71a12)。本仓库复制了该提交的[上游 LICENSE](https://github.com/AppImage/type2-runtime/blob/75849dce7cc37e4319b633df1f116ca895c71a12/LICENSE)，没有使用持续变化的 `continuous` 发布链接来推断许可证版本。

该文件包含运行时代码的 MIT 许可条款，并列出静态链接的 musl、libfuse、squashfuse、libzstd、zlib 的独立许可来源。复制这份上游文件不代表这些静态依赖的全部源码、构建材料和许可证明已收集完毕。

## 本清单的边界

本次工作核验的是版权材料的来源与文件完整性，未完成所有二进制组件的版本与源代码逐一对应，也未提供完整的第三方对应源码包。原打包器通过 `ldd` 收集动态库，其复制的库集合比显式版权文件清单更广；例如包内存在 Brotli、Kerberos 等库，而原来的 28 份文件中没有以这些系统包名命名的独立说明。

因此，本文件不声称整个 AppImage 的再分发义务已全部核验。未来分发新构建时，应针对实际使用的运行时、库版本及其许可条款核对所需材料。主机 MinerU、Conda、CUDA、GPU 驱动和模型权重没有包含在这个 AppImage 中，其来源与授权由各自安装单独管理。
