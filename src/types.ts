export const ENGINE_REPOSITORIES = {
  sglang: "sgl-project/sglang",
  vllm: "vllm-project/vllm",
} as const;

export type Engine = keyof typeof ENGINE_REPOSITORIES;
export type QueryKind = "release" | "pr" | "issue" | "number";

export interface EngineQuery {
  engine: Engine;
  kind: QueryKind;
  value: string;
  raw: string;
}

export interface EvidenceSource {
  id: string;
  title: string;
  url: string;
}

export interface EvidenceDocument {
  kind: "release" | "pull_request" | "issue";
  engine: Engine;
  repository: string;
  title: string;
  url: string;
  status: string;
  metadata: Record<string, unknown>;
  sections: Array<{ heading: string; content: string }>;
  sources: EvidenceSource[];
}

export interface ExplanationResult {
  markdown: string;
  sources: EvidenceSource[];
  cacheHit: boolean;
}
