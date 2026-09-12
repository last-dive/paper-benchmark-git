# AppImage 2.5.0 实际内含组件与致谢

感谢下列项目的作者、贡献者及 Ubuntu/Debian 维护者。第三方组件继续按各自原始许可证授权；本项目自有代码的非商业条款不改变第三方权利。

核验对象 SHA256：`3af2201381c87a18e46eba301a11e4ec3f5ec942877a7f8ca8746d9f3a2df94b`。本表来自实际提取文件，逐一匹配原发布清单；完整逐文件记录、版本和版权来源见 [bundled-components.json](bundled-components.json)。

共核验 **1043** 个包内文件；其中 **98 个 ELF**（47 个独立动态库、47 个 Python 扩展、4 个程序）。97 个 ELF 与本机 dpkg 登记的包文件完全一致，另 1 个 Node.js 与官方发行包完全一致。

共 **48 个 Ubuntu 二进制包 / 38 个源码包系列**，覆盖 990 个包文件；另有 Node.js 与 5 个生成的目录 UUID 文件。保留原 28 份说明，补充 **23 份包版权说明**。

版本列是准确匹配包文件后的 Ubuntu 包版本，可能含发行版修订号。版权原文保留全部作者和按文件划分的条款；其中也可能讨论源码树的测试、文档或打包脚本，不能把原文中出现的每一项许可都套用于每个二进制。

| 项目 / 上游 | Ubuntu 二进制包 | 包版本 | 包内文件数 | 版权及许可原文 |
| --- | --- | --- | ---: | --- |
| [brotli](https://github.com/google/brotli) | `libbrotli1:amd64` | `1.0.9-2build6` | 2 | [原文](supplemental-notices/libbrotli1.txt) |
| [bzip2](https://sourceware.org/bzip2/) | `libbz2-1.0:amd64` | `1.0.8-5ubuntu0.1` | 1 | [原文](bundled-notices/libbz2-1.0.txt) |
| [e2fsprogs](http://e2fsprogs.sourceforge.net) | `libcom-err2:amd64` | `1.46.5-2ubuntu1.2` | 1 | [原文](supplemental-notices/libcom-err2.txt) |
| libxcrypt | `libcrypt1:amd64` | `1:4.4.27-1` | 1 | [原文](bundled-notices/libcrypt1.txt) |
| [db5.3](http://www.oracle.com/technetwork/database/database-technologies/berkeleydb/overview/index.html) | `libdb5.3:amd64` | `5.3.28+dfsg1-0.8ubuntu3` | 1 | [原文](supplemental-notices/libdb5.3.txt) |
| [libdeflate](https://github.com/ebiggers/libdeflate) | `libdeflate0:amd64` | `1.10-2` | 1 | [原文](supplemental-notices/libdeflate0.txt) |
| [Expat](https://libexpat.github.io/) | `libexpat1:amd64` | `2.4.7-1ubuntu0.7` | 1 | [原文](bundled-notices/libexpat1.txt) |
| [libffi](https://sourceware.org/libffi/) | `libffi8:amd64` | `3.4.2-4` | 1 | [原文](bundled-notices/libffi8.txt) |
| [fontconfig](https://www.freedesktop.org/wiki/Software/fontconfig/) | `libfontconfig1:amd64` | `2.13.1-4.2ubuntu5` | 1 | [原文](bundled-notices/libfontconfig1.txt) |
| [FreeType](https://www.freetype.org) | `libfreetype6:amd64` | `2.11.1+dfsg-1ubuntu0.3` | 1 | [原文](bundled-notices/libfreetype6.txt) |
| [gcc-12](http://gcc.gnu.org/) | `libgcc-s1:amd64` | `12.3.0-1ubuntu1~22.04.3` | 1 | [原文](bundled-notices/libgcc-s1.txt) |
| [gdbm](https://gnu.org/software/gdbm) | `libgdbm6:amd64` | `1.23-1` | 1 | [原文](bundled-notices/libgdbm6.txt) |
| [krb5](http://web.mit.edu/kerberos/) | `libgssapi-krb5-2:amd64` | `1.19.2-2ubuntu0.8` | 1 | [原文](supplemental-notices/libgssapi-krb5-2.txt) |
| [jbigkit](http://www.cl.cam.ac.uk/~mgk25/jbigkit/) | `libjbig0:amd64` | `2.1-3.1ubuntu0.22.04.1` | 1 | [原文](supplemental-notices/libjbig0.txt) |
| [libjpeg-turbo](http://libjpeg-turbo.virtualgl.org/) | `libjpeg-turbo8:amd64` | `2.1.2-0ubuntu1` | 1 | [原文](bundled-notices/libjpeg-turbo8.txt) |
| [krb5](http://web.mit.edu/kerberos/) | `libk5crypto3:amd64` | `1.19.2-2ubuntu0.8` | 1 | [原文](supplemental-notices/libk5crypto3.txt) |
| [keyutils](https://people.redhat.com/~dhowells/keyutils/) | `libkeyutils1:amd64` | `1.6.1-2ubuntu3` | 1 | [原文](supplemental-notices/libkeyutils1.txt) |
| [krb5](http://web.mit.edu/kerberos/) | `libkrb5-3:amd64` | `1.19.2-2ubuntu0.8` | 1 | [原文](supplemental-notices/libkrb5-3.txt) |
| [krb5](http://web.mit.edu/kerberos/) | `libkrb5support0:amd64` | `1.19.2-2ubuntu0.8` | 1 | [原文](supplemental-notices/libkrb5support0.txt) |
| [Little CMS](http://www.littlecms.com/) | `liblcms2-2:amd64` | `2.12~rc1-2ubuntu0.1` | 1 | [原文](bundled-notices/liblcms2-2.txt) |
| [XZ Utils](https://tukaani.org/xz/) | `liblzma5:amd64` | `5.2.5-2ubuntu1.1` | 1 | [原文](bundled-notices/liblzma5.txt) |
| [mpdecimal](https://www.bytereef.org/mpdecimal/index.html) | `libmpdec3:amd64` | `2.5.1-2build2` | 1 | [原文](supplemental-notices/libmpdec3.txt) |
| [ncurses](https://invisible-island.net/ncurses/) | `libncursesw6:amd64` | `6.3-2ubuntu0.3` | 2 | [原文](supplemental-notices/libncursesw6.txt) |
| [libnsl](https://github.com/thkukuk/libnsl) | `libnsl2:amd64` | `1.3.0-2build2` | 1 | [原文](supplemental-notices/libnsl2.txt) |
| [NSPR](http://www.mozilla.org/projects/nspr/) | `libnspr4:amd64` | `2:4.35-0ubuntu0.22.04.1` | 3 | [原文](bundled-notices/libnspr4.txt) |
| [NSS](http://www.mozilla.org/projects/security/pki/nss/) | `libnss3:amd64` | `2:3.98-0ubuntu0.22.04.4` | 3 | [原文](bundled-notices/libnss3.txt) |
| [OpenJPEG](https://www.openjpeg.org) | `libopenjp2-7:amd64` | `2.4.0-6ubuntu0.5` | 1 | [原文](bundled-notices/libopenjp2-7.txt) |
| [libpng](http://libpng.org/pub/png/libpng.html) | `libpng16-16:amd64` | `1.6.37-3ubuntu0.6` | 1 | [原文](bundled-notices/libpng16-16.txt) |
| [poppler](https://poppler.freedesktop.org/) | `libpoppler118:amd64` | `22.02.0-2ubuntu0.13` | 1 | [原文](bundled-notices/libpoppler118.txt) |
| python3.10 | `libpython3.10-minimal:amd64` | `3.10.12-1~22.04.18` | 268 | [原文](supplemental-notices/libpython3.10-minimal.txt) |
| python3.10 | `libpython3.10-stdlib:amd64` | `3.10.12-1~22.04.18` | 280 | [原文](supplemental-notices/libpython3.10-stdlib.txt) |
| readline | `libreadline8:amd64` | `8.1.2-1` | 1 | [原文](bundled-notices/libreadline8.txt) |
| [sqlite3](https://www.sqlite.org/) | `libsqlite3-0:amd64` | `3.37.2-2ubuntu0.7` | 1 | [原文](bundled-notices/libsqlite3-0.txt) |
| [OpenSSL](https://www.openssl.org/) | `libssl3:amd64` | `3.0.2-0ubuntu1.29` | 2 | [原文](bundled-notices/libssl3.txt) |
| [gcc-12](http://gcc.gnu.org/) | `libstdc++6:amd64` | `12.3.0-1ubuntu1~22.04.3` | 1 | [原文](bundled-notices/libstdc++6.txt) |
| [LibTIFF](https://libtiff.gitlab.io/libtiff/) | `libtiff5:amd64` | `4.3.0-6ubuntu0.13` | 1 | [原文](bundled-notices/libtiff5.txt) |
| [ncurses](https://invisible-island.net/ncurses/) | `libtinfo6:amd64` | `6.3-2ubuntu0.3` | 1 | [原文](bundled-notices/libtinfo6.txt) |
| [libtirpc](http://sourceforge.net/projects/libtirpc) | `libtirpc3:amd64` | `1.3.2-2ubuntu0.1` | 1 | [原文](supplemental-notices/libtirpc3.txt) |
| [util-linux](https://www.kernel.org/pub/linux/utils/util-linux/) | `libuuid1:amd64` | `2.37.2-4ubuntu3.6` | 1 | [原文](bundled-notices/libuuid1.txt) |
| [libwebp](https://developers.google.com/speed/webp/) | `libwebp7:amd64` | `1.2.2-2ubuntu0.22.04.2` | 1 | [原文](supplemental-notices/libwebp7.txt) |
| [Zstd](https://github.com/facebook/zstd) | `libzstd1:amd64` | `1.4.8+dfsg-3build1` | 1 | [原文](supplemental-notices/libzstd1.txt) |
| [poppler-data](https://poppler.freedesktop.org/) | `poppler-data` | `0.4.11-1` | 266 | [原文](supplemental-notices/poppler-data.txt) |
| [poppler](https://poppler.freedesktop.org/) | `poppler-utils` | `22.02.0-2ubuntu0.13` | 2 | [原文](bundled-notices/poppler-utils.txt) |
| python3-stdlib-extensions | `python3-distutils` | `3.10.8-1~22.04` | 50 | [原文](supplemental-notices/python3-distutils.txt) |
| python3-stdlib-extensions | `python3-gdbm:amd64` | `3.10.8-1~22.04` | 1 | [原文](supplemental-notices/python3-gdbm.txt) |
| python3-stdlib-extensions | `python3-lib2to3` | `3.10.8-1~22.04` | 75 | [原文](supplemental-notices/python3-lib2to3.txt) |
| python3.10 | `python3.10-minimal` | `3.10.12-1~22.04.18` | 1 | [原文](supplemental-notices/python3.10-minimal.txt) |
| [zlib](http://zlib.net/) | `zlib1g:amd64` | `1:1.2.11.dfsg-2ubuntu9.2` | 1 | [原文](bundled-notices/zlib1g.txt) |

每个包的准确源码版本及 Ubuntu 对应源码页面均列在 JSON 中。本仓库未收集完整的第三方对应源码包；复制版权文件和给出源码页面不等同于履行所有再分发条件。

## Node.js 及其内含组件

Node.js **24.14.0** 的程序字节及完整 [LICENSE](bundled-notices/node.txt) 均与 [官方 linux-x64 发行包](https://nodejs.org/dist/v24.14.0/node-v24.14.0-linux-x64.tar.xz) 一致；归档 SHA256 已对照官方 HTTPS 校验和清单核验。未单独验证签名。

实际 Node.js 运行时报告的组件版本如下（`modules`、`napi` 是 ABI 编号，未列为库；CLDR、时区和 Unicode 属 ICU 数据）。

| 组件 | 版本 |
| --- | --- |
| acorn | `8.15.0` |
| ada | `3.4.2` |
| amaro | `1.1.7` |
| ares | `1.34.6` |
| brotli | `1.2.0` |
| cldr | `48.0` |
| icu | `78.2` |
| llhttp | `9.3.0` |
| merve | `1.0.0` |
| nbytes | `0.1.1` |
| ncrypto | `0.0.1` |
| nghttp2 | `1.68.0` |
| openssl | `3.5.5` |
| simdjson | `4.2.4` |
| simdutf | `6.4.0` |
| sqlite | `3.51.2` |
| tz | `2025c` |
| undici | `7.21.0` |
| unicode | `17.0` |
| uv | `1.51.0` |
| uvwasi | `0.0.23` |
| v8 | `13.6.233.17-node.41` |
| zlib | `1.3.1-e00f703` |
| zstd | `1.5.7` |

补充 [nbytes MIT 许可证](node-dependency-licenses/deps-nbytes-LICENSE) 与 [SQLite 公有领域声明](node-dependency-licenses/sqlite-PUBLIC-DOMAIN.txt)。ncrypto 从 Node.js 核心提取，见[该固定版本说明](node-dependency-licenses/deps-ncrypto-README.md)及 Node.js 原始 LICENSE 的适用范围。

完整 Node.js LICENSE 含 **44 个组件条目**，以下逐项致谢；其中包含构建和测试依赖，条目本身不证明它们全部链接进此二进制。

| 上游组件 | 上游源码位置 | 版权原文起始行 |
| --- | --- | ---: |
| Acorn | `deps/acorn` | [第 54 行](bundled-notices/node.txt#L54) |
| c-ares | `deps/cares` | [第 79 行](bundled-notices/node.txt#L79) |
| merve | `deps/merve` | [第 107 行](bundled-notices/node.txt#L107) |
| ittapi | `deps/v8/third_party/ittapi` | [第 129 行](bundled-notices/node.txt#L129) |
| amaro | `deps/amaro` | [第 141 行](bundled-notices/node.txt#L141) |
| swc | `deps/amaro/dist` | [第 166 行](bundled-notices/node.txt#L166) |
| ICU | `deps/icu-small` | [第 371 行](bundled-notices/node.txt#L371) |
| libuv | `deps/uv` | [第 938 行](bundled-notices/node.txt#L938) |
| LIEF | `deps/LIEF` | [第 997 行](bundled-notices/node.txt#L997) |
| llhttp | `deps/llhttp` | [第 1203 行](bundled-notices/node.txt#L1203) |
| corepack | `deps/corepack` | [第 1229 行](bundled-notices/node.txt#L1229) |
| undici | `deps/undici` | [第 1240 行](bundled-notices/node.txt#L1240) |
| postject | `test/fixtures/postject-copy` | [第 1265 行](bundled-notices/node.txt#L1265) |
| OpenSSL | `deps/openssl` | [第 1505 行](bundled-notices/node.txt#L1505) |
| Punycode.js | `lib/punycode.js` | [第 1685 行](bundled-notices/node.txt#L1685) |
| V8 | `deps/v8` | [第 1709 行](bundled-notices/node.txt#L1709) |
| SipHash | `deps/v8/src/third_party/siphash` | [第 1774 行](bundled-notices/node.txt#L1774) |
| zlib | `deps/zlib` | [第 1785 行](bundled-notices/node.txt#L1785) |
| simdjson | `deps/simdjson` | [第 1812 行](bundled-notices/node.txt#L1812) |
| simdutf | `deps/v8/third_party/simdutf` | [第 2017 行](bundled-notices/node.txt#L2017) |
| ada | `deps/ada` | [第 2039 行](bundled-notices/node.txt#L2039) |
| minimatch | `deps/minimatch` | [第 2061 行](bundled-notices/node.txt#L2061) |
| npm | `deps/npm` | [第 2120 行](bundled-notices/node.txt#L2120) |
| GYP | `tools/gyp` | [第 2349 行](bundled-notices/node.txt#L2349) |
| inspector_protocol | `deps/inspector_protocol` | [第 2381 行](bundled-notices/node.txt#L2381) |
| jinja2 | `tools/inspector_protocol/jinja2` | [第 2412 行](bundled-notices/node.txt#L2412) |
| markupsafe | `tools/inspector_protocol/markupsafe` | [第 2447 行](bundled-notices/node.txt#L2447) |
| cpplint.py | `tools/cpplint.py` | [第 2484 行](bundled-notices/node.txt#L2484) |
| gypi_to_gn.py | `tools/gypi_to_gn.py` | [第 2515 行](bundled-notices/node.txt#L2515) |
| gtest | `deps/googletest` | [第 2544 行](bundled-notices/node.txt#L2544) |
| nghttp2 | `deps/nghttp2` | [第 2576 行](bundled-notices/node.txt#L2576) |
| large_pages | `src/large_pages` | [第 2603 行](bundled-notices/node.txt#L2603) |
| caja | `lib/internal/freeze_intrinsics.js` | [第 2626 行](bundled-notices/node.txt#L2626) |
| brotli | `deps/brotli` | [第 2644 行](bundled-notices/node.txt#L2644) |
| zstd | `deps/zstd` | [第 2667 行](bundled-notices/node.txt#L2667) |
| HdrHistogram | `deps/histogram` | [第 2701 行](bundled-notices/node.txt#L2701) |
| node-heapdump | `src/heap_utils.cc` | [第 2746 行](bundled-notices/node.txt#L2746) |
| rimraf | `lib/internal/fs/rimraf.js` | [第 2783 行](bundled-notices/node.txt#L2783) |
| uvwasi | `deps/uvwasi` | [第 2802 行](bundled-notices/node.txt#L2802) |
| ngtcp2 | `deps/ngtcp2/ngtcp2/` | [第 2827 行](bundled-notices/node.txt#L2827) |
| nghttp3 | `deps/ngtcp2/nghttp3/` | [第 2853 行](bundled-notices/node.txt#L2853) |
| node-fs-extra | `lib/internal/fs/cp` | [第 2879 行](bundled-notices/node.txt#L2879) |
| on-exit-leak-free | `lib/internal/process/finalization` | [第 2898 行](bundled-notices/node.txt#L2898) |
| sonic-boom | `lib/internal/streams/fast-utf8-stream.js` | [第 2923 行](bundled-notices/node.txt#L2923) |

## 其他范围说明

- AppImage 静态运行时及其依赖见 [runtime-components.json](runtime-components.json) 和 [appimage-runtime/LICENSE](appimage-runtime/LICENSE)。
- Python 标准库、其扩展模块、Poppler CMap / 字符映射数据都已纳入文件与版权核验。
- 5 个 `.uuid` 是复制进来的目录 UUID 元数据，无 dpkg 包归属；已记录其内容哈希及来源，不将它们作为额外软件库。
- 原 `libgdbm-compat4.txt` 与 `python3.10.txt` 作为历史打包材料继续保留；实际库/解释器文件按表内真实包名归属。
- 宿主系统提供的 glibc、动态加载器，以及外部 MinerU、Conda、CUDA、GPU 驱动、模型权重不在这个 AppImage 内。
- 原 [INVENTORY.json](INVENTORY.json) 保持不变；新增材料来源和哈希见 [SUPPLEMENTAL_INVENTORY.json](SUPPLEMENTAL_INVENTORY.json)。
