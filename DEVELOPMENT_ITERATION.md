# 推理引擎解读机器人：开发迭代文档

本文记录这个飞书 Agent 从需求定义、MVP 实现到当前线上版本的演进过程，重点说明每一轮迭代解决了什么问题、为什么采用当前设计，以及后续继续开发时应遵守的边界。

## 1. 项目目标

### 1.1 背景

SGLang 和 vLLM 发布版本时，release note 往往同时包含调度、执行器、KV Cache、并行策略、Kernel、模型适配和 Bug Fix。只看标题很难判断真实影响，而逐个阅读 PR、Issue 和代码 diff 又需要较高时间成本。

本项目希望提供一个群聊里的“推理引擎同事”：用户只需 @机器人并给出版本号、PR、Issue 或 GitHub URL，机器人就能读取一手资料，用工程师容易理解的中文解释：

- 这次到底改了什么；
- 旧执行路径和新执行路径有什么差别；
- 为什么可能更快、更稳或支持新的场景；
- 有哪些限制、回退条件和升级风险；
- 哪些是代码已经实现的事实，哪些仍是 Roadmap 或作者主张。

### 1.2 当前范围

当前支持：

- 引擎：SGLang、vLLM；
- 对象：Release、Pull Request、Issue；
- 交互：飞书群聊 @机器人、私聊、命令行直连测试；
- 资料源：GitHub Release/API、PR body、Issue、评论、review、changed files 和有限长度的代码 diff；
- 模型后端：实现 OpenAI Responses API 的官方或兼容服务。

当前不负责自动修改代码，也不能替代升级前的人工验证和性能测试。

## 2. 当前架构

```text
飞书 im.message.receive_v1（长连接）
        │
        ├─ @当前机器人校验 / 消息去重 / 快速 ACK
        │
        ▼
查询解析：engine + release / PR / issue + identifier
        │
        ▼
GitHub 证据采集
        ├─ Release note 与 feature 选择
        ├─ 重点 Feature 对应 PR / Roadmap / implementation PR
        ├─ PR body、状态、文件变化、代码 diff
        └─ Issue 正文与讨论
        │
        ▼
EvidenceDocument（结构化且带 verified source）
        │
        ├─ 长资料并行分块抽取
        └─ 最终中文综合解释
        │
        ▼
Card 2.0 分层渲染 → 飞书回复
```

主要模块：

| 模块 | 职责 |
|---|---|
| `src/query-parser.ts` | 识别引擎、版本、PR、Issue 和 GitHub URL。 |
| `src/github.ts` | 收集并筛选 GitHub 证据，识别 Roadmap 与实现 PR。 |
| `src/explainer.ts` | 对长证据分块抽取并生成最终工程化解读。 |
| `src/service.ts` | 串联采集和解释，并提供 TTL 缓存。 |
| `src/lark.ts` | 飞书事件处理、快速 ACK、并发控制、消息回复和 Card 2.0 渲染。 |
| `src/health.ts` | 暴露 `/healthz` 和 `/readyz`。 |
| `src/cli.ts` | 不经过飞书，直接验证 GitHub 与模型链路。 |

飞书部分参考了 [SiClaw](https://github.com/scitix/siclaw) 的长连接、快速 ACK、@门控和错误回退经验，但 GitHub 证据分析、版本解读和 Card 2.0 排版是本项目独立实现。

## 3. 迭代历程

### 3.1 第一阶段：可用的飞书机器人 MVP

第一版目标是打通最短闭环：

```text
群里 @机器人 → 识别问题 → 读取 GitHub → 调用模型 → 回复中文解读
```

实现内容：

- 使用飞书长连接接收 `im.message.receive_v1`，本地部署无需公网 webhook；
- 支持 `sglang v0.5.6`、`vllm PR #12345`、Issue 和完整 GitHub URL；
- 使用 GitHub REST API 获取 release、PR、Issue 和讨论资料；
- 使用 OpenAI Responses API 生成中文解释；
- 增加命令行入口，在不连接飞书时单独验证 GitHub 和模型链路。

这一阶段证明了产品形态可行，但输出仍偏“通用摘要”，对代码路径、约束和真实工程影响解释不足。

### 3.2 第二阶段：让输出更像懂代码的工程师

根据人工编写的 vLLM v0.15 和 SGLang v0.5.9 解读样例，输出策略从“总结 changelog”调整为“精读重点 Feature”。

核心变化：

- Release 输出固定为 `重点 Feature / Backend & Kernel / Model Support / Breaking Changes / Bug Fix`；
- 重点 Feature 要说明“旧路径 → 新路径 → 收益和代价”；
- 有代码证据时明确写类名、函数名、stream、event、状态和调度条件；
- PR 链接紧跟对应 Feature，不再统一堆在文末；
- Model Support 只完整列清单，不为每个模型生成泛泛介绍；
- Bug Fix 只根据 release note 简写，不消耗请求深挖每个修复 PR；
- 禁止虚构性能数据、启动参数和兼容范围。

这一轮的关键不是“让回答更长”，而是让有限篇幅集中在真正改变执行路径的功能上。

### 3.3 第三阶段：降低 GitHub 请求量并提高证据质量

匿名 GitHub REST API 通常只有 60 次/小时。Release 中模型支持和 Bug Fix 可能引用大量 PR，如果逐条读取，既慢又容易耗尽额度。

本轮采用分层采集策略：

- 完整保留 release note；
- 对 Model Support、Bug Fix、依赖更新、文档和贡献者列表只保留 release 级信息；
- 仅对被选为重点 Feature、Backend 或 Kernel 的项目读取 PR/Issue 详情；
- 限制重点引用数量和并行度；
- 配置 GitHub Token 后使用认证请求，将常见核心额度提升至 5,000 次/小时；
- API 受限时，Release 可回退到 GitHub 公共页面解析。

这使请求预算与内容价值匹配：详细分析真正需要读代码的 Feature，清单型内容不做无效深挖。

### 3.4 第四阶段：解决“看不到代码”的问题

早期版本有时会输出“现有材料只有 release 结论，没有 PR body 或 patch”。排查发现主要有两类问题：

1. Release 引用的编号可能是 Roadmap Issue，而不是 PR；
2. `.diff` 请求失败后返回的 HTML 404 页面可能被误当作代码文本。

修复内容：

- 结合 release 上下文、URL 和 GitHub 对象类型区分 PR 与 Issue；
- Roadmap Issue 不再显示成“相关 PR”；
- 从 Roadmap 正文中提取关联的 implementation PR；
- 对候选实现 PR 读取 body 和代码 diff；
- 只有内容以 `diff --git` 开头时才接受为有效 diff；
- Roadmap 用来解释目标、完成项和未完成项，实现 PR 用来解释真实代码路径。

修复后，类似 Pipeline Parallelism Roadmap 的功能可以继续追踪到具体实现，而不会停留在 release 宣传语。

### 3.5 第五阶段：长资料分块与响应体验

一个大型 Release 的证据可能远超单次稳定处理的长度。直接把所有资料交给模型，会导致响应慢、重点丢失或输出不稳定。

当前流程为：

1. 将结构化证据按字符边界切分；
2. 以受控并发做“证据抽取”，保留 Feature 名、PR、代码路径、限制和性能来源；
3. 汇总各块结果后生成最终版本速报；
4. Release 首次查询时告知用户通常需要等待；
5. 超过 20 秒仍未完成时发送进度提示；
6. 结果进入 TTL Cache，同一查询短期内直接复用。

飞书事件处理器会立即 ACK，再在后台执行耗时任务，避免飞书因为 handler 阻塞而重投事件。

### 3.6 第六阶段：消息可靠性和并发保护

为了避免线上群聊产生重复回复或过载，增加了：

- 通过 bot `open_id` 判断群消息是否真的 @当前机器人；
- 排除 `@所有人`；
- 基于 `message_id` 的 30 分钟去重；
- 忽略机器人自己发送的消息；
- `TaskPool` 限制运行中和排队中的请求数；
- 队列满时快速返回可理解的提示；
- 检查飞书 API 的业务错误码；
- 卡片回复失败时回退到纯文本。

这部分直接决定机器人在真实群聊里是否“安静且可靠”，而不只是本地单次调用能否成功。

### 3.7 第七阶段：本地生产部署与可观测性

当前本地部署基线：

- Node.js 22.19；
- `.env` 权限为 `0600`，并被 Git 与 Docker context 忽略；
- 构建前运行测试、TypeScript 检查和 production build；
- 使用 tmux 保持进程常驻；
- 当默认端口冲突时切换到可用端口；
- `/healthz` 表示 HTTP 进程存活；
- `/readyz` 只有飞书长连接建立后才返回 200；
- 日志出现 `[lark] connected` 后再做群聊端到端验收。

验收被拆成四层：本地进程、GitHub、模型、飞书。这样某一层失败时不会把所有问题笼统归因于“机器人坏了”。

### 3.8 第八阶段：Card 2.0 标题层级

旧版卡片把整篇回复放进单个 Markdown 元素，飞书不会稳定地把 `# / ## / ###` 渲染为不同字号，长文看起来像一整块正文。

当前渲染规则：

- `# SGLang v0.5.9 新 Feature 解读` → 卡片顶部最大标题；
- `## 重点 Feature` → 独立二级标题，使用 heading 字号、加粗和分隔线；
- `### 1. LoRA 权重加载与模型计算并行` → 独立三级标题并加粗；
- 正文继续使用正常字号；
- fenced code block 内的 `#` 不作为标题解析。

因此排版层级由卡片元素本身表达，不再依赖飞书对一整段 Markdown 标题语法的兼容程度。

## 4. 关键设计决策

### 4.1 为什么使用长连接

长连接适合本地或内网部署：服务只需主动访问飞书，不需要公网域名、TLS 证书或 webhook 回调地址。代价是进程必须常驻，并监控连接是否 ready。

### 4.2 为什么先采证据再让模型解释

模型不直接自由浏览 GitHub，而是消费程序构造的 `EvidenceDocument`。这样可以：

- 明确对象状态与可信 URL；
- 控制请求数量和上下文体积；
- 把事实、作者主张和推断分开；
- 防止 PR/Issue 正文中的提示注入改变机器人任务；
- 对采集器和解释器分别测试。

### 4.3 为什么只精读 New Feature

Feature 的价值通常依赖执行路径变化，仅看标题容易误解；模型支持和 Bug Fix 更适合清单式呈现。把 GitHub 请求预算和模型上下文留给 Feature，可同时改善速度、额度和内容深度。

### 4.4 为什么保留真实限制而不强行给结论

如果 PR 没有性能数字，机器人不会声称吞吐提升；如果只拿到 Roadmap 而没有实现 diff，会明确标注证据边界。输出可能因此不够“肯定”，但比编造一个听起来合理的实现更可信。

## 5. 测试与发布基线

每次代码变更至少运行：

```bash
npm ci
npm run check
```

`npm run check` 当前覆盖：

- Vitest 单元测试；
- TypeScript 类型检查；
- production build。

重点回归场景：

- 各种版本号、PR、Issue 和 URL 的解析；
- GitHub Release tag 有无 `v` 前缀；
- PR/Issue 模糊编号自动识别；
- Roadmap Issue 到 implementation PR 的追踪；
- HTML 404 不得进入代码 diff；
- Release 只深挖重点 Feature；
- 飞书 @门控、`@所有人` 排除和消息去重；
- Card 2.0 的一级、二级和三级标题结构；
- `/healthz` 与 `/readyz` 的语义不同。

发布步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)。生产重启必须先停止旧进程、确认端口释放，再启动单个新实例，避免同一飞书应用出现重复回复。

## 6. 已知限制

- Feature 选择仍基于 release 章节和启发式评分，可能需要为不同项目继续校准；
- GitHub Patch API 会截断大型 diff，目前只提供有限代码窗口；
- GitHub 公共页面回退主要保障 Release，本身不等价于完整 API 证据；
- 缓存位于单进程内存，多副本之间不共享；
- 当前没有持久化请求审计、延迟指标和 token 成本统计；
- 最终质量受 release note 完整度、PR 描述质量和模型能力共同影响；
- 飞书回复仍是一次性最终卡片，不是 token 级流式更新；
- 目前只支持 SGLang 和 vLLM，不包含 TensorRT-LLM、LMDeploy 等其他引擎。

## 7. 后续 Roadmap

### P0：质量可回归

- 建立一组人工金标：至少覆盖典型 Release、Feature PR、Roadmap Issue 和 Bug Issue；
- 对“是否读到实现代码、是否绑定正确 PR、是否虚构性能”建立自动评分；
- Prompt、模型或采集策略变更前后运行同一套 eval。

### P1：更完整的工程证据

- 对大型 PR 按文件重要度选择 diff，而不是简单按返回顺序截断；
- 关联设计文档、benchmark comment、后续修复 PR 和 revert；
- 支持比较两个版本，回答“从 A 升级到 B 的行为差异”；
- 明确标注 release、merged PR 和未合并 Roadmap 的时间关系。

### P1：性能和可观测性

- 记录 GitHub 采集、分块总结、最终生成和飞书发送的分段延迟；
- 增加请求成功率、缓存命中率、GitHub 剩余额度和模型错误分类；
- 引入持久化缓存，支持重启复用和多副本；
- 评估飞书 CardKit 流式更新，减少大型版本首次查询的等待感。

### P2：主动发布和团队协作

- 监听 GitHub Release/Webhook，自动生成版本解读并推送指定群；
- 提供管理员命令配置关注的仓库、群和版本渠道；
- 支持用户对答案标记“有用 / PR 对错 / 需要重写”，形成改进数据；
- 扩展更多推理引擎时，将 repository policy、章节分类和 feature 评分配置化。

## 8. 维护原则

后续迭代应保持以下原则：

1. **证据优先**：重要结论必须能回到 release、PR、Issue 或代码 diff。
2. **Feature 深挖，清单简写**：把时间和请求预算用在需要解释执行路径的地方。
3. **不伪造实测**：作者 benchmark、机器人推断和团队实测必须明确区分。
4. **分层诊断**：飞书、GitHub、模型和本地进程分别验证。
5. **密钥不进仓库**：只提交 `.env.example`，真实凭据始终留在受保护环境中。
6. **先回归再重启**：测试和 build 通过后才替换在线进程。
7. **一次只运行一个消费者**：同一飞书 App 不应由多个未协调的本地实例同时消费事件。

这份文档描述的是当前实现基线。新增重大能力时，应同步更新“迭代历程、已知限制、测试基线和 Roadmap”，避免代码已经变化而项目认知仍停留在旧版本。
