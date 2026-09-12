# GitHub 发布说明

此目录为 Paperbench Research v2.5.0 的本地 GitHub 准备副本。应用源码与现有 AppImage 保持快照内容；新增仓库文档、忽略规则、CI、Issue/PR 模板和检查工具。准备工作不包含创建远程仓库、推送、打标签或发布 Release。

## 目录与发布内容

| 内容 | 保存位置 | Git 策略 |
| --- | --- | --- |
| 应用源码、测试与说明 | 仓库根目录、`tests/` | 跟踪 |
| AppImage 构建脚本与运行时 | `appimage/` | 跟踪 |
| 发布说明、哈希及构建清单 | `release/v2.5.0/` | 跟踪 |
| 当前 AppImage 与原交付附件 | `dist/` | 本地保留，忽略；需要分发时作为 Release 附件 |
| 原安装说明等本地快照 | `local-snapshot/` | 本地保留，忽略 |
| API Key、论文、报告、日志和旧版本 | 私密或工作目录 | 不作为仓库输入 |

当前 AppImage 为 59,935,224 字节，约 57.16 MiB。GitHub 对大于 50 MiB 的普通 Git 文件给出警告，阻止大于 100 MiB 的文件；大体积二进制可通过 Release 分发。因此这里将 `dist/` 从 Git 排除，不需要为当前发布方案配置 Git LFS。[GitHub 大文件说明](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)

## 检查本地副本

在本地保存目录进入仓库，检查当前分支、暂存内容、应用和交付文件：

```bash
cd /home/xx/chatgpt/paper-benchmark-git
git status --short --branch
git diff --cached --stat
python3 tools/check_repo.py
python3 tools/check_repo.py --verify-snapshot --check-release
python3 run_tests.py
```

`check_repo.py` 检查 Git 跟踪或候选文件中的已知敏感内容模式与仓库约束；`--verify-snapshot` 额外核对初始应用文件哈希，`--check-release` 额外核对本地 `dist/` 交付文件。它不能判断每段正文是否包含个人资料或未公开论文，提交前仍需阅读实际暂存内容。

本地初始分支为 `main`，还没有初始提交或远程地址。应用尚未指定开源许可证；发布前根据 [LICENSE-NOTICE.md](../LICENSE-NOTICE.md) 明确应用许可安排，并核对 [第三方组件说明](../THIRD_PARTY_NOTICES.md)。仓库配套文件不会自动授予应用的开源许可。

## 首次提交和推送

以下步骤由仓库所有者按实际账号执行。先在 GitHub 创建空仓库，不自动添加 README、许可证或 `.gitignore`，避免与本地已有文件形成两个初始历史。`OWNER/REPO` 是占位符，应替换为真实仓库归属及名称。

```bash
git add .
git diff --cached --stat
git diff --cached --check
git commit -m "Prepare Paperbench Research v2.5.0 source snapshot"
git remote add origin git@github.com:OWNER/REPO.git
git remote -v
git push -u origin main
```

使用已配置的 SSH 或 Git 凭据完成认证。不要将 token 拼进远程 URL、命令、文档或提交。如果已经存在 `origin`，先核对其地址，再决定是否需要修改；不要盲目重复添加。

`.github/workflows/ci.yml` 在推送和 Pull Request 时运行源码检查及模拟测试。它不创建 Release，不上传 AppImage，也不使用真实模型或 GPU。

## 创建 v2.5.0 草稿 Release

确认推送的提交对应本地验证内容后，创建并推送标签：

```bash
git tag -a v2.5.0 -m "Paperbench Research v2.5.0"
git push origin v2.5.0
python3 tools/check_repo.py --verify-snapshot --check-release
```

确认 GitHub CLI 已登录目标账号，然后创建带 AppImage 与校验文件的草稿：

```bash
gh auth status
gh release create v2.5.0 \
  --repo OWNER/REPO \
  --draft \
  --verify-tag \
  --title "Paperbench Research v2.5.0" \
  --notes-file release/v2.5.0/RELEASE_NOTES.md \
  dist/Paperbench-Research-2.5.0-x86_64.AppImage \
  dist/packaging-source.tar.gz \
  dist/Third-Party-Notices-2.5.0.tar.gz \
  release/v2.5.0/RELEASE_SHA256SUMS
```

`--draft` 保留为草稿，`--verify-tag` 要求远程标签已存在；发行说明从文件读取。操作含义见 [GitHub CLI `gh release create` 文档](https://cli.github.com/manual/gh_release_create)。

在 GitHub 草稿页面核对附件名称、大小、SHA-256、平台范围、MinerU 固定环境说明和许可证资料，再由所有者决定公开发布。当前 AppImage 内嵌的是原安装 README，仓库的新 README 尚未打入该包；两者的区别已记录在源码快照说明中。

如果从 GitHub 新克隆了源码，`dist/` 不存在是正常情况。应取回与校验清单一致的发布附件，或按 [构建说明](APPIMAGE_BUILD.md) 单独构建；重新构建的文件哈希不应冒充当前保存包的哈希。
