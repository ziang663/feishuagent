import { loadConfig } from "./config.js";
import { EvidenceExplainer } from "./explainer.js";
import { GitHubClient } from "./github.js";
import { startHealthServer } from "./health.js";
import { createLarkBot, type LarkBot } from "./lark.js";
import { ExplanationService } from "./service.js";
import type { Server } from "node:http";

let healthServer: Server | undefined;
let bot: LarkBot | undefined;

async function main(): Promise<void> {
  const config = loadConfig();
  const healthState = { ready: false, startedAt: new Date().toISOString() };
  const server = startHealthServer(config.runtime.port, healthState);
  healthServer = server;
  const github = new GitHubClient({
    ...(config.github.token ? { token: config.github.token } : {}),
    maxLinkedPullRequests: config.github.maxLinkedPullRequests,
  });
  const explainer = new EvidenceExplainer({
    apiKey: config.openai.apiKey,
    model: config.openai.model,
    ...(config.openai.baseURL ? { baseURL: config.openai.baseURL } : {}),
    requestTimeoutMs: config.openai.requestTimeoutMs,
    summarizationConcurrency: config.openai.summarizationConcurrency,
  });
  const service = new ExplanationService(github, explainer, config.runtime.cacheTtlMs);
  const larkBot = await createLarkBot(config, service);
  bot = larkBot;

  const shutdown = (signal: string) => {
    console.log(`[app] received ${signal}; closing Feishu connection`);
    healthState.ready = false;
    larkBot.stop();
    server.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  await larkBot.start();
  healthState.ready = true;
}

main().catch((error) => {
  console.error("[app] fatal", error);
  bot?.stop();
  healthServer?.close();
  process.exitCode = 1;
});
