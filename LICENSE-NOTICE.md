# 项目许可与适用范围

Paperbench Research 的原创代码、测试、文档与图标，自本次许可发布起采用 **PolyForm Noncommercial License 1.0.0**。完整、未经修改的官方英文条款见 [LICENSE](LICENSE)，应保留的项目声明见 [NOTICE](NOTICE)。许可方为项目维护者 [last-dive](https://github.com/last-dive)，授权限于其有权许可的内容。

## 可以怎样使用

依据该许可证，可为其允许的非商业目的使用、研究、修改和分发本项目；分发时须保留许可条款或其 URL，以及 `Required Notice:` 声明。个人研究、学习和试验等用途，以及许可证明确列出的教育、公共研究、公益等机构用途，按许可证原文中的定义判断。**不能把“免费提供”直接等同于“非商业目的”。** 不属于许可允许范围的商业使用，应先联系维护者取得单独授权；本仓库不自动授予商业许可。

本页是中文说明，不增删标准许可证的权利或条件；如有歧义，以 [LICENSE](LICENSE) 原文为准。PolyForm 的机构用途条款有明确范围，不应以本页的简写替代它。

## 许可覆盖哪些内容

- 项目自有的 Python、JavaScript、HTML、CSS、测试、构建辅助脚本和原创文档/图标，适用项目许可；文件中另有合法独立许可或归属声明的部分除外。
- AppImage 中属于本项目的程序文件同样适用上述许可，包括发布页中已提供的 v2.5.0 程序副本。本次不重新生成既有二进制，配套许可材料在仓库和发布附件中提供。
- **第三方组件不改用本项目许可。** Python、Node.js、Poppler、AppImage 运行时及其静态/动态依赖，各自保留原许可证和版权。`appimage/vendor/runtime-x86_64`、`third_party/` 内上游版权与许可文本、外部模型及其内容均不受本项目新增非商业限制约束。原许可证允许的商业使用权也不因同包分发而被本项目剥夺。
- 用户论文、原文引文、输入数据、第三方图像、模型权重和模型服务，不因经过本程序处理或展示而取得本项目的授权；模型输出的权利取决于其来源与适用条款。
- 贡献者仍保有各自权利。只有其有权提供并按本项目许可提交的贡献，才在相应范围内适用本项目许可。

AppImage 是多组件分发物，不能笼统称为“整个安装包仅限非商业使用”。项目通过独立进程/命令行使用 PDF 工具；该实现关系记录在依赖资料中，并不代替对每个组件的再分发、对应源码及适用条款的核查。第三方来源、许可正文和核验边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## “非商业源码可用”与“开源”的区别

这里提供公开源码和非商业许可，准确称为 **source-available / 非商业源码可用**。它不是符合 OSI 定义的开源许可，因为 OSI 的定义不允许排除商业领域用途。参见 [OSI 开源定义第 6 条](https://opensource.org/osd) 和 [PolyForm Noncommercial 官方条款](https://polyformproject.org/licenses/noncommercial/1.0.0)。

引用本软件可使用 [CITATION.cff](CITATION.cff)；上游项目、论文和社区致谢见 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)。引用建议不增加许可证原文以外的使用限制。
