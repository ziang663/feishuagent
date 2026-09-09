import * as lark from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "./config.js";
import { GitHubApiError } from "./github.js";
import { HELP_TEXT, parseQuery, QueryParseError } from "./query-parser.js";
import type { ExplanationService } from "./service.js";
import { TaskPool } from "./task-pool.js";

interface MessageEvent {
  sender?: { sender_id?: { open_id?: string }; sender_type?: string };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ key?: string; id?: { open_id?: string } }>;
  };
}

const processedMessages = new Map<string, number>();
const MESSAGE_DEDUP_TTL_MS = 30 * 60 * 1000;

function alreadyProcessed(messageId: string): boolean {
  const now = Date.now();
  for (const [key, expiresAt] of processedMessages) {
    if (expiresAt <= now) processedMessages.delete(key);
  }
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, now + MESSAGE_DEDUP_TTL_MS);
  return false;
}

export function stripMentions(text: string): string {
  return text.replace(/@_user_\d+|@_all/g, " ").replace(/\s+/g, " ").trim();
}

export function extractText(message: MessageEvent["message"]): string {
  if (!message || message.message_type !== "text") return "";
  try {
    const content = JSON.parse(message.content || "{}") as { text?: unknown };
    return stripMentions(typeof content.text === "string" ? content.text : "");
  } catch {
    return "";
  }
}

export function isBotMentioned(message: MessageEvent["message"], botOpenId?: string): boolean {
  const mentions = message?.mentions;
  if (!mentions?.length) return false;
  if (botOpenId) return mentions.some((mention) => mention.id?.open_id === botOpenId);
  return mentions.some((mention) => mention.key !== "@_all");
}

function plainHeading(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .trim();
}

function renderCardMarkdown(markdown: string): {
  title: string;
  elements: Array<Record<string, unknown>>;
} {
  const elements: Array<Record<string, unknown>> = [];
  const bodyLines: string[] = [];
  let title = "推理引擎解读";
  let extractedTitle = false;
  let fenceMarker: "```" | "~~~" | undefined;

  const flushBody = () => {
    const content = bodyLines.join("\n").trim();
    bodyLines.length = 0;
    if (content) elements.push({ tag: "markdown", content, text_size: "normal" });
  };

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const fence = line.match(/^\s*(```|~~~)/)?.[1] as "```" | "~~~" | undefined;
    if (fence) {
      bodyLines.push(line);
      if (!fenceMarker) fenceMarker = fence;
      else if (fenceMarker === fence) fenceMarker = undefined;
      continue;
    }

    const heading = fenceMarker ? undefined : line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!heading) {
      bodyLines.push(line);
      continue;
    }

    flushBody();
    const level = heading[1]!.length;
    const content = heading[2]!.trim();
    if (level === 1 && !extractedTitle) {
      title = plainHeading(content) || title;
      extractedTitle = true;
      continue;
    }

    if (level === 2) {
      if (elements.length && elements.at(-1)?.tag !== "hr") elements.push({ tag: "hr" });
      elements.push({ tag: "markdown", content: `**${content}**`, text_size: "heading" });
      continue;
    }

    elements.push({ tag: "markdown", content: `**${content}**`, text_size: "normal" });
  }

  flushBody();
  if (!elements.length) elements.push({ tag: "markdown", content: markdown || "(empty)", text_size: "normal" });
  return { title, elements };
}

export function card(markdown: string): Record<string, unknown> {
  const rendered = renderCardMarkdown(markdown);
  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: rendered.title },
      template: "blue",
    },
    body: { elements: rendered.elements },
  };
}

async function replyText(client: any, messageId: string, text: string): Promise<void> {
  const response = await client.im.message.reply({
    path: { message_id: messageId },
    data: { msg_type: "text", content: JSON.stringify({ text }) },
  });
  if (typeof response?.code === "number" && response.code !== 0) {
    throw new Error(`Feishu reply failed: code=${response.code} msg=${response.msg}`);
  }
}

async function replyCard(client: any, messageId: string, markdown: string): Promise<void> {
  const response = await client.im.message.reply({
    path: { message_id: messageId },
    data: { msg_type: "interactive", content: JSON.stringify(card(markdown)) },
  });
  if (typeof response?.code === "number" && response.code !== 0) {
    throw new Error(`Feishu card reply failed: code=${response.code} msg=${response.msg}`);
  }
}

async function safeReply(client: any, messageId: string, markdown: string): Promise<void> {
  try {
    await replyCard(client, messageId, markdown);
  } catch (error) {
    console.warn("[lark] card reply failed, falling back to text", error);
    await replyText(client, messageId, markdown);
  }
}

function userFacingError(error: unknown): string {
  if (error instanceof QueryParseError) return `${error.message}\n\n${HELP_TEXT}`;
  if (error instanceof GitHubApiError) {
    if (error.status === 404) return `GitHub 上没有找到对应对象。\n\n${error.url}`;
    if (error.status === 403 || error.status === 429) {
      return "GitHub 查询额度暂时用完了，请稍后重试；管理员可以配置 GITHUB_TOKEN 提高额度。";
    }
  }
  return "处理失败了，请稍后重试。管理员可查看服务日志中的 request_id。";
}

export interface LarkBot {
  start(): Promise<void>;
  stop(): void;
}

export async function createLarkBot(
  config: AppConfig,
  service: ExplanationService,
): Promise<LarkBot> {
  const domain = config.feishu.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
  const client = new lark.Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain,
  });
  let botOpenId: string | undefined;
  try {
    const response: any = await client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
    botOpenId = response?.bot?.open_id ?? response?.data?.bot?.open_id;
  } catch (error) {
    console.warn("[lark] unable to resolve bot open_id; using @all exclusion fallback", error);
  }

  const pool = new TaskPool(config.runtime.maxConcurrentRequests, config.runtime.maxPendingRequests);
  const dispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": (data: MessageEvent) => {
      // ACK immediately. Feishu redelivers events when long-running handlers block the ACK.
      setImmediate(() => {
        void handleMessage(data).catch((error) => console.error("[lark] detached handler failed", error));
      });
      return Promise.resolve();
    },
  });
  const ws = new lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain,
  });

  async function handleMessage(data: MessageEvent): Promise<void> {
    const message = data.message;
    const messageId = message?.message_id;
    if (!message || !messageId || !message.chat_id) return;
    if (alreadyProcessed(messageId)) return;
    if (data.sender?.sender_type === "app") return;
    if (message.message_type !== "text") return;
    const isGroup = message.chat_type === "group";
    if (isGroup && !isBotMentioned(message, botOpenId)) return;
    const text = extractText(message);
    if (!text) return;

    let query;
    try {
      query = parseQuery(text);
    } catch (error) {
      await safeReply(client, messageId, userFacingError(error));
      return;
    }

    let finished = false;
    const work = pool.submit(async () => {
      const requestId = messageId;
      console.log(`[bot] request_id=${requestId} query=${query.engine}:${query.kind}:${query.value}`);
      try {
        const result = await service.explain(query);
        await safeReply(client, messageId, result.markdown);
        console.log(`[bot] request_id=${requestId} complete cache_hit=${result.cacheHit}`);
      } catch (error) {
        console.error(`[bot] request_id=${requestId} failed`, error);
        await safeReply(client, messageId, userFacingError(error));
      } finally {
        finished = true;
      }
    });
    if (!work) {
      await safeReply(client, messageId, "当前查询较多，本次请求没有进入队列，请稍后重试。" );
      return;
    }
    await safeReply(
      client,
      messageId,
      `正在读取 **${query.engine} ${query.kind === "release" ? "版本" : query.kind.toUpperCase()} ${query.value}** 的原始资料并整理。${query.kind === "release" ? "\n\n大型版本首次分析通常需要约 30～60 秒。" : ""}`,
    );
    const progressTimer = setTimeout(() => {
      if (finished) return;
      void safeReply(
        client,
        messageId,
        "资料较多，仍在进行分块分析和最终汇总，请再稍等片刻。",
      ).catch((error) => console.error(`[bot] request_id=${messageId} progress reply failed`, error));
    }, 20_000);
    progressTimer.unref();
    void work.finally(() => clearTimeout(progressTimer)).catch(() => undefined);
    void work.catch((error) => {
      console.error(`[bot] request_id=${messageId} background task rejected`, error);
    });
  }

  return {
    async start() {
      await ws.start({ eventDispatcher: dispatcher });
      console.log(`[lark] connected domain=${config.feishu.domain} bot_open_id=${botOpenId ?? "unknown"}`);
    },
    stop() {
      ws.close({ force: true });
    },
  };
}
