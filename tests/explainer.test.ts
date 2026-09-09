import { describe, expect, it, vi } from "vitest";
import { EvidenceExplainer } from "../src/explainer.js";
import type { EvidenceDocument } from "../src/types.js";

const document: EvidenceDocument = {
  kind: "issue",
  engine: "sglang",
  repository: "sgl-project/sglang",
  title: "Issue #1: scheduler problem",
  url: "https://github.com/sgl-project/sglang/issues/1",
  status: "open",
  metadata: { number: 1 },
  sections: [{ heading: "Problem statement", content: "The scheduler stalls." }],
  sources: [{ id: "primary", title: "Issue #1", url: "https://github.com/sgl-project/sglang/issues/1" }],
};

describe("EvidenceExplainer", () => {
  it("uses Responses API and appends only verified sources", async () => {
    const create = vi.fn().mockResolvedValue({ output_text: "这是一个尚未修复的问题报告。" });
    const client = { responses: { create } } as any;
    const explainer = new EvidenceExplainer({ apiKey: "test", model: "test-model", client });
    const result = await explainer.explain(document);
    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0];
    expect(call).toBeDefined();
    expect(call![0]).toMatchObject({ model: "test-model" });
    expect(result).toContain("尚未修复");
    expect(result).toContain("https://github.com/sgl-project/sglang/issues/1");
  });

  it("uses the engineering release brief format for releases", async () => {
    const create = vi.fn().mockResolvedValue({ output_text: "## 重点 Feature\n\n### 1. 调度优化" });
    const client = { responses: { create } } as any;
    const explainer = new EvidenceExplainer({ apiKey: "test", model: "test-model", client });
    const result = await explainer.explain({
      ...document,
      kind: "release",
      title: "v0.15.0",
      url: "https://github.com/vllm-project/vllm/releases/tag/v0.15.0",
      metadata: { tag: "v0.15.0" },
    });
    const call = create.mock.calls[0];
    expect(call?.[0]?.instructions).toContain("旧逻辑");
    expect(call?.[0]?.instructions).toContain("## Model Support");
    expect(result).toContain("# SGLang v0.15.0 新 Feature 解读");
    expect(result).not.toContain("### 原始资料");
  });
});
