# 飞书机器人部署指南

本服务通过飞书长连接接收消息，因此运行机器只需能够主动访问飞书、GitHub 和模型 API；不需要为飞书暴露公网 webhook。

## 1. 创建飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，创建“企业自建应用”。
2. 在“添加应用能力”中启用“机器人”。
3. 在“凭证与基础信息”中保存 App ID 和 App Secret。
4. 在“权限管理”中申请：
   - `im:message`
   - `im:message.group_at_msg:readonly`
   - `application:bot.basic_info:read`
   - 如需私聊，再申请 `im:message.p2p_msg:readonly`
5. 在“事件与回调”中选择“使用长连接接收事件”，订阅 `im.message.receive_v1`。
6. 创建并发布应用版本；如果企业启用了审批，需要管理员批准权限和版本。
7. 把机器人添加到目标群聊。

生产环境建议保留 `application:bot.basic_info:read`。服务会用机器人自己的 `open_id` 判断群消息是否真的 @ 了当前机器人，避免把 `@所有人` 或其他成员的 mention 误判成调用。

## 2. 准备密钥

```bash
cd /mnt/workspace/inference-engine-bot
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

```dotenv
FEISHU_DOMAIN=feishu
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx

OPENAI_API_KEY=sk-xxx
OPENAI_MODEL=gpt-5-mini
# 使用兼容 Responses API 的内部网关时配置：
# OPENAI_BASE_URL=https://gateway.example.com/v1

# 强烈建议配置，避免 GitHub 匿名 API 每小时 60 次的限制
GITHUB_TOKEN=github_pat_xxx

MAX_CONCURRENT_REQUESTS=4
MAX_PENDING_REQUESTS=50
CACHE_TTL_SECONDS=600
GITHUB_MAX_LINKED_PRS=30
PORT=8080
```

密钥不要提交到 Git；`.env` 已加入 `.gitignore` 和 `.dockerignore`。

## 3. 启动

### Docker Compose（推荐）

```bash
docker compose up -d --build
docker compose logs -f bot
```

检查状态：

```bash
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/readyz
```

`/readyz` 返回 HTTP 200 且日志出现 `[lark] connected`，说明飞书长连接已建立。

### 直接运行

要求 Node.js 22.19 或更高版本：

```bash
npm ci
npm run check
npm run build
npm start
```

开发模式可运行：

```bash
npm run dev
```

## 4. 分层验收

先验证 GitHub 与模型，不连接飞书消息链路：

```bash
npm run ask -- "sglang v0.5.5"
npm run ask -- "vllm PR #19000"
```

随后在群里发送：

```text
@推理引擎机器人 sglang v0.5.5
@推理引擎机器人 vllm PR #19000
@推理引擎机器人 https://github.com/sgl-project/sglang/issues/12345
```

正常情况下会先收到“正在读取原始资料”的确认卡片，随后收到完整解读。

## 5. 常见问题

- 没有任何响应：确认机器人已经加入群、应用版本已经发布、事件使用长连接，并检查 `im.message.receive_v1` 和消息权限。
- 私聊无响应：补充 `im:message.p2p_msg:readonly` 权限并重新发布应用版本。
- GitHub 额度耗尽：配置 `GITHUB_TOKEN`；公开仓库只需要只读权限。
- 模型调用失败：确认模型名可用，并确认 `OPENAI_BASE_URL` 对应的网关实现了 `POST /responses`。
- `/healthz` 正常但 `/readyz` 为 503：进程已启动，但飞书长连接尚未就绪。
