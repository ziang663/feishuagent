import { EvidenceExplainer } from "./explainer.js";
import { GitHubClient } from "./github.js";
import { parseQuery } from "./query-parser.js";
import { ExplanationService } from "./service.js";

async function main(): Promise<void> {
  const text = process.argv.slice(2).join(" ").trim();
  if (!text) throw new Error("Usage: npm run ask -- 'sglang v0.5.6'");
  const apiKey = process.env.OPENAI_API_KEY?.trim() || process.env.SIONIC_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL?.trim();
  if (!apiKey || !model) throw new Error("OPENAI_API_KEY (or SIONIC_API_KEY) and OPENAI_MODEL are required");
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  const service = new ExplanationService(
    new GitHubClient({
      ...(githubToken ? { token: githubToken } : {}),
      maxLinkedPullRequests: Number(process.env.GITHUB_MAX_LINKED_PRS || "30"),
    }),
    new EvidenceExplainer({
      apiKey,
      model,
      ...(baseURL ? { baseURL } : {}),
      requestTimeoutMs: Number(process.env.OPENAI_REQUEST_TIMEOUT_SECONDS || "120") * 1000,
      summarizationConcurrency: Number(process.env.OPENAI_SUMMARIZATION_CONCURRENCY || "4"),
    }),
    Number(process.env.CACHE_TTL_SECONDS || "600") * 1000,
  );
  const result = await service.explain(parseQuery(text));
  process.stdout.write(`${result.markdown}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
