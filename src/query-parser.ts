import type { Engine, EngineQuery, QueryKind } from "./types.js";

const ENGINE_ALIASES: Array<[RegExp, Engine]> = [
  [/\bsglang\b|\bsgl\b/i, "sglang"],
  [/\bvllm\b/i, "vllm"],
];

const GITHUB_URL = /github\.com\/(sgl-project\/sglang|vllm-project\/vllm)\/(pull|issues)\/(\d+)/i;

export class QueryParseError extends Error {
  constructor(message: string, readonly help = false) {
    super(message);
    this.name = "QueryParseError";
  }
}

function engineFromText(text: string): Engine | null {
  for (const [pattern, engine] of ENGINE_ALIASES) {
    if (pattern.test(text)) return engine;
  }
  return null;
}

function normalizeVersion(raw: string): string {
  return raw.trim().replace(/[，,。；;：:]+$/g, "");
}

export function parseQuery(input: string): EngineQuery {
  const raw = input.trim();
  if (!raw || /^(help|帮助|用法|\/help)$/i.test(raw)) {
    throw new QueryParseError("需要提供引擎和版本号、PR 或 Issue。", true);
  }

  const url = raw.match(GITHUB_URL);
  if (url) {
    const repository = url[1]?.toLowerCase();
    const engine: Engine = repository === "sgl-project/sglang" ? "sglang" : "vllm";
    const kind: QueryKind = url[2]?.toLowerCase() === "pull" ? "pr" : "issue";
    return { engine, kind, value: url[3]!, raw };
  }

  const engine = engineFromText(raw);
  if (!engine) {
    throw new QueryParseError("没有识别出引擎，请明确写 `sglang` 或 `vllm`。", true);
  }

  const explicitNumber = raw.match(/\b(pr|pull\s*request|issue)\s*[#：:]?\s*(\d+)\b/i);
  if (explicitNumber) {
    const kind: QueryKind = explicitNumber[1]!.toLowerCase().startsWith("issue") ? "issue" : "pr";
    return { engine, kind, value: explicitNumber[2]!, raw };
  }

  const hashNumber = raw.match(/#\s*(\d+)\b/);
  if (hashNumber) return { engine, kind: "number", value: hashNumber[1]!, raw };

  const versionPatterns = [
    /(?:版本|version|release|tag)\s*[：:]?\s*(v?\d+(?:\.\d+){1,3}(?:[-+._a-z0-9]*)?)/i,
    /\b(v?\d+(?:\.\d+){1,3}(?:[-+._a-z0-9]*)?)\b/i,
  ];
  for (const pattern of versionPatterns) {
    const match = raw.match(pattern);
    if (match) return { engine, kind: "release", value: normalizeVersion(match[1]!), raw };
  }

  const bareNumber = raw.match(/(?:编号|id)\s*[：:]?\s*(\d+)\b/i);
  if (bareNumber) return { engine, kind: "number", value: bareNumber[1]!, raw };

  throw new QueryParseError("识别到引擎，但没有找到版本号、PR 编号或 Issue 编号。", true);
}

export const HELP_TEXT = [
  "我可以解释 SGLang / vLLM 的版本、PR 和 Issue。示例：",
  "- `sglang v0.5.6`",
  "- `vllm 0.10.2 release`",
  "- `sglang PR #12345`",
  "- `vllm issue 9876`",
  "- 直接粘贴对应 GitHub PR/Issue URL",
].join("\n");
