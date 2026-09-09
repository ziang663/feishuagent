export interface AppConfig {
  feishu: {
    appId: string;
    appSecret: string;
    domain: "feishu" | "lark";
  };
  openai: {
    apiKey: string;
    model: string;
    baseURL?: string;
    requestTimeoutMs: number;
    summarizationConcurrency: number;
  };
  github: {
    token?: string;
    maxLinkedPullRequests: number;
  };
  runtime: {
    port: number;
    maxConcurrentRequests: number;
    maxPendingRequests: number;
    cacheTtlMs: number;
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function requiredAny(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const domain = process.env.FEISHU_DOMAIN?.trim() || "feishu";
  if (domain !== "feishu" && domain !== "lark") {
    throw new Error("FEISHU_DOMAIN must be feishu or lark");
  }
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  const token = process.env.GITHUB_TOKEN?.trim();
  return {
    feishu: {
      appId: required("FEISHU_APP_ID"),
      appSecret: required("FEISHU_APP_SECRET"),
      domain,
    },
    openai: {
      apiKey: requiredAny(["OPENAI_API_KEY", "SIONIC_API_KEY"]),
      model: process.env.OPENAI_MODEL?.trim() || "gpt-5-mini",
      ...(baseURL ? { baseURL } : {}),
      requestTimeoutMs: positiveInt("OPENAI_REQUEST_TIMEOUT_SECONDS", 120) * 1000,
      summarizationConcurrency: positiveInt("OPENAI_SUMMARIZATION_CONCURRENCY", 4),
    },
    github: {
      ...(token ? { token } : {}),
      maxLinkedPullRequests: positiveInt("GITHUB_MAX_LINKED_PRS", 30),
    },
    runtime: {
      port: positiveInt("PORT", 8080),
      maxConcurrentRequests: positiveInt("MAX_CONCURRENT_REQUESTS", 4),
      maxPendingRequests: positiveInt("MAX_PENDING_REQUESTS", 50),
      cacheTtlMs: positiveInt("CACHE_TTL_SECONDS", 600) * 1000,
    },
  };
}
