# 推理引擎版本解读机器人

一个专门解释 SGLang 和 vLLM 版本、PR、Issue 的飞书机器人。

项目的需求演进、关键设计决策、问题修复记录和后续 Roadmap 见 [开发迭代文档](./DEVELOPMENT_ITERATION.md)。

在群里 @机器人并发送：

```text
sglang v0.5.6
vllm 0.10.2 release
sglang PR #12345
vllm issue 9876
https://github.com/sgl-project/sglang/pull/12345
```

机器人会读取 GitHub 原始资料，用中文回答：它解决了什么、具体改了什么、举例说明、谁会受益、有哪些兼容性风险，以及当前是讨论中、已合并还是已发布。

## 设计

```text
飞书长连接
  → @机器人门控、事件快速 ACK、消息去重、并发限流
  → 查询解析
  → GitHub Release / PR / Issue 证据采集
  → OpenAI Responses API 分块归纳和中文解释
  → 飞书 Markdown 卡片和原始资料链接
```

项目参考了 [SiClaw](https://github.com/scitix/siclaw) 的飞书实现，保留了几个重要经验：

- 使用飞书长连接，不要求暴露公网 webhook。
- 收到事件后立即 ACK，耗时任务异步执行，避免飞书重投造成重复回复。
- 群聊只响应对当前机器人的明确 @，不会把 `@所有人` 当作机器人调用。
- 检查飞书 API 的非零业务码；卡片发送失败时回退到文本。
- 对 `message_id` 去重，并限制同时执行和排队的请求数量。

## 当前能力

- 支持 `sgl-project/sglang` 与 `vllm-project/vllm`。
- Release：获取 release note，并补充其中引用的 PR 标题、状态、labels、作者说明和变更规模。
- PR：获取描述、merge 状态、labels、统计、最多 100 个变更文件的 patch，以及最近评论/review。
- Issue：获取问题描述、状态、labels、assignees 和讨论；如果编号实际是 PR，会自动按 PR 解释。
- 对长证据自动分块归纳，再生成最终回答。
- 回复始终附带经过程序确认的 GitHub 原始链接。
- 查询结果带 TTL 缓存，减少重复 GitHub 和模型请求。
- 提供 `/healthz` 与 `/readyz`。

## 飞书应用配置

完整的生产部署步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

1. 在飞书开放平台创建企业自建应用并启用机器人。
2. 事件订阅选择“使用长连接接收事件”。
3. 订阅事件：`im.message.receive_v1`。
4. 至少申请以下应用身份权限：

   - `im:message`
   - `im:message.group_at_msg:readonly`
   - `im:message.p2p_msg:readonly`（需要私聊时）
   - `application:bot.basic_info:read`（推荐，用于严格识别当前机器人，而不是 `@所有人`）

5. 发布应用版本，并把机器人加入测试群。

这个 MVP 不读取未 @ 机器人的普通群消息，因此不需要敏感的 `im:message.group_msg` 权限。

## 配置

要求 Node.js 22.19 或更高版本。

```bash
cp .env.example .env
```

配置环境变量：

```bash
export FEISHU_DOMAIN=feishu
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx

export OPENAI_API_KEY=sk-xxx
export OPENAI_MODEL=gpt-5-mini

# 推荐配置，否则 GitHub 匿名请求只有 60 次/小时
export GITHUB_TOKEN=github_pat_xxx
```

`OPENAI_BASE_URL` 可指向实现了 `POST /responses` 的兼容网关。机器人使用 OpenAI Responses API；官方 JavaScript 用法参见 [Text generation](https://developers.openai.com/api/docs/guides/text)。

## 运行

```bash
npm install
npm run check
npm run dev
```

生产运行：

```bash
npm run build
npm start
```

不连接飞书，先从命令行验证 GitHub 与模型链路：

```bash
npm run ask -- "sglang v0.5.6"
npm run ask -- "vllm PR #12345"
```

健康检查：

```bash
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/readyz
```

## Docker

```bash
docker build -t inference-engine-release-bot .
docker run --rm --env-file .env -p 8080:8080 inference-engine-release-bot
```

## 输出可信度

GitHub 的 PR、Issue 和评论均被当作不可信资料，而非模型指令。提示词要求模型：

- 只依据已采集证据；
- 区分事实、作者目标、讨论和推断；
- 不捏造性能数据、兼容版本或启动参数；
- Issue 不得被描述成已修复，除非证据明确支持；
- PR 必须说明 open/closed/merged；
- Release 优先解释用户可见变化，而不是逐条翻译 changelog。

仍应把机器人看作“资料解读助手”，而不是发布决策的唯一依据。关键生产变更需要打开回复末尾的原始链接确认。

## 后续建议

- 接入 GitHub webhook，发布新版本时主动生成解读并推送指定群。
- 建立已验证问答集，对每次提示词或模型升级做回归评测。
- 为 release 建立跨版本 diff，回答“从 A 升到 B 有哪些行为变化”。
- 持久化缓存和审计记录，支持多副本部署。
