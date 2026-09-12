# v2.5.0 MinerU 本机接口补充

本文件补充原有 [WORKSPACE_API.md](../WORKSPACE_API.md)。所有接口通过工作台本机服务访问，均为 JSON POST，要求有效的 `X-Paperbench-Token` 和同源请求。模型 Key 不作为转换参数。

| 路径 | 用途 |
|---|---|
| `/local-mineru/start` | 对已经导入并缓存的原 PDF 创建串行转换任务 |
| `/local-mineru/status` | 查询任务进度、已转换正文和来源记录 |
| `/local-mineru/cancel` | 请求取消任务；后续轮询确认最终状态 |

启动请求示例（哈希须来自本机会话的实际导入结果）：

```json
{
  "requestId": "client-request-unique-id",
  "outputPath": "/absolute/output/path",
  "papers": [
    {"paperId": "paper-01", "sha256": "<64位PDF哈希>", "title": "示例论文"}
  ]
}
```

`requestId` 是8–100字符的字母、数字、下划线或连字符。同一个编号与相同材料/路径重复提交会返回原任务；同一编号搭配不同载荷会被拒绝。前端在启动响应丢失时复用编号，避免重复占用 GPU。单个本机服务同时只运行一个转换任务。

查询或取消使用 `{"jobId":"..."}`，也可使用 `{"requestId":"..."}`，两者不可同时传入。空查询对象返回最近任务；正常前端按明确任务编号查询。

任务状态为 `running`、`complete`、`failed`、`cancelled`。快照含 `total`、`completed`、`current`、`message`、`items`、`failures`、输出目录和起止时间。成功条目的 `items` 含 `paperId`、完整 `text` 及 `provenance`（PDF/MD哈希、转换目录、工具版本、GPU验证信息、页数、命令和附件清单）。

转换调用固定的主机 MinerU 入口，不接受网页提供任意命令、可执行文件或 GPU 编号。源 PDF 来自本机缓存；每篇转换后校验完整页数、非空主 Markdown 及哈希。全部材料通过后，前端才创建冻结的 Markdown 评分批次。转换期间不得将暂时失联当作后台已停止。

保留的转换图片供离线检查，评分请求发送 Markdown 文本及引文索引。现有批次使用冻结材料；转换任务不能修改已存在批次。
