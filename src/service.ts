import type { EngineQuery, ExplanationResult } from "./types.js";
import { TtlCache } from "./cache.js";
import type { GitHubClient } from "./github.js";
import type { EvidenceExplainer } from "./explainer.js";

export class ExplanationService {
  private readonly cache: TtlCache<string>;

  constructor(
    private readonly github: Pick<GitHubClient, "collect">,
    private readonly explainer: Pick<EvidenceExplainer, "explain">,
    cacheTtlMs: number,
  ) {
    this.cache = new TtlCache<string>(cacheTtlMs);
  }

  async explain(query: EngineQuery): Promise<ExplanationResult> {
    const startedAt = Date.now();
    const key = `${query.engine}:${query.kind}:${query.value.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached) {
      console.error(`[service] key=${key} cache_hit=true elapsed_ms=${Date.now() - startedAt}`);
      return { markdown: cached, sources: [], cacheHit: true };
    }
    const collectStartedAt = Date.now();
    const evidence = await this.github.collect(query);
    console.error(`[service] key=${key} collect_ms=${Date.now() - collectStartedAt}`);
    const markdown = await this.explainer.explain(evidence);
    this.cache.set(key, markdown);
    console.error(`[service] key=${key} total_elapsed_ms=${Date.now() - startedAt}`);
    return { markdown, sources: evidence.sources, cacheHit: false };
  }
}
