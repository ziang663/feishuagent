import { describe, expect, it, vi } from "vitest";
import { ExplanationService } from "../src/service.js";

describe("ExplanationService", () => {
  it("caches repeated explanations", async () => {
    const collect = vi.fn().mockResolvedValue({
      kind: "issue",
      engine: "sglang",
      repository: "sgl-project/sglang",
      title: "Issue",
      url: "https://example.com/1",
      status: "open",
      metadata: {},
      sections: [],
      sources: [],
    });
    const explain = vi.fn().mockResolvedValue("answer");
    const service = new ExplanationService({ collect } as any, { explain } as any, 60_000);
    const query = { engine: "sglang", kind: "issue", value: "1", raw: "sglang issue 1" } as const;
    expect((await service.explain(query)).cacheHit).toBe(false);
    expect((await service.explain(query)).cacheHit).toBe(true);
    expect(collect).toHaveBeenCalledOnce();
    expect(explain).toHaveBeenCalledOnce();
  });
});
