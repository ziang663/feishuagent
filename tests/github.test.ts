import { describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../src/github.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHubClient", () => {
  it("falls back between version tags and collects linked PR titles", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/releases/tags/0.5.6")) return jsonResponse({ message: "Not Found" }, 404);
      if (url.endsWith("/releases/tags/v0.5.6")) {
        return jsonResponse({
          tag_name: "v0.5.6",
          name: "v0.5.6",
          body: [
            "## Highlights",
            "* **Feature A**: Changes scheduler behavior for large batches (#12345).",
            "### Model Support",
            "* NewModel (#22222).",
            "### Bug Fixes",
            "* Fix a crash (#33333).",
          ].join("\n"),
          html_url: "https://github.com/sgl-project/sglang/releases/tag/v0.5.6",
          draft: false,
          prerelease: false,
          author: { login: "maintainer" },
        });
      }
      if (url.endsWith("/pulls/12345")) {
        return jsonResponse({
          title: "Add feature A",
          html_url: "https://github.com/sgl-project/sglang/pull/12345",
          state: "closed",
          merged_at: "2026-01-01T00:00:00Z",
          body: "This changes the scheduler behavior for large batches.",
          user: { login: "maintainer" },
          additions: 20,
          deletions: 5,
          changed_files: 2,
          labels: [],
        });
      }
      if (url.includes("/pulls/12345/files")) return jsonResponse([]);
      if (url.endsWith("/pull/12345.diff")) return new Response("diff --git a/a.py b/a.py\n+new scheduler path\n");
      if (url.includes("/pulls/22222") || url.includes("/pulls/33333")) {
        throw new Error(`low-priority PR should not be fetched: ${url}`);
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new GitHubClient({ maxLinkedPullRequests: 30, fetchImpl: fetchImpl as typeof fetch });
    const evidence = await client.collect({
      engine: "sglang",
      kind: "release",
      value: "0.5.6",
      raw: "sglang 0.5.6",
    });
    expect(evidence.kind).toBe("release");
    expect(evidence.metadata.selected_feature_evidence_objects).toBe(1);
    expect(evidence.sources).toHaveLength(4);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/pulls/22222"), expect.anything());
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/pulls/33333"), expect.anything());
    expect(evidence.sections[1]?.content).toContain("large batches");
  });

  it("resolves an ambiguous number as a PR first", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pulls/42")) {
        return jsonResponse({
          title: "Fix scheduler",
          html_url: "https://github.com/vllm-project/vllm/pull/42",
          state: "open",
          merged_at: null,
          labels: [],
          user: { login: "dev" },
          base: { ref: "main" },
          head: { ref: "fix" },
        });
      }
      if (url.includes("/pulls/42/files")) return jsonResponse([]);
      if (url.includes("/issues/42/comments")) return jsonResponse([]);
      if (url.includes("/pulls/42/reviews")) return jsonResponse([]);
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new GitHubClient({ maxLinkedPullRequests: 30, fetchImpl: fetchImpl as typeof fetch });
    const evidence = await client.collect({ engine: "vllm", kind: "number", value: "42", raw: "vllm #42" });
    expect(evidence.kind).toBe("pull_request");
    expect(evidence.status).toBe("open");
  });

  it("treats roadmap references as issues and follows implementation PRs", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/releases/tags/v0.5.7")) {
        return jsonResponse({
          tag_name: "v0.5.7",
          name: "v0.5.7",
          body: [
            "# Highlights",
            "- Scalable pipeline parallelism with dynamic chunking (PP Refactor Roadmap #11857)",
            "# What's Changed",
            "* unrelated feature in https://github.com/sgl-project/sglang/pull/99999",
          ].join("\n"),
          html_url: "https://github.com/sgl-project/sglang/releases/tag/v0.5.7",
          draft: false,
          prerelease: false,
          author: { login: "maintainer" },
        });
      }
      if (url.endsWith("/issues/11857")) {
        return jsonResponse({
          title: "[Roadmap] Pipeline parallelism roadmap",
          html_url: "https://github.com/sgl-project/sglang/issues/11857",
          state: "open",
          user: { login: "maintainer" },
          body: "- [x] Reduce bubbles with Dynamic Chunking https://github.com/sgl-project/sglang/pull/11852",
        });
      }
      if (url.endsWith("/pulls/11852")) {
        return jsonResponse({
          title: "Refactor PP to async mode",
          html_url: "https://github.com/sgl-project/sglang/pull/11852",
          state: "closed",
          merged_at: "2025-01-01T00:00:00Z",
          body: "Implement a new PP event loop and dynamic chunking.",
          labels: [],
        });
      }
      if (url.endsWith("/pull/11852.diff")) {
        return new Response("diff --git a/scheduler.py b/scheduler.py\n+dynamic_chunking = True\n");
      }
      if (url.endsWith("/pull/11857.diff")) {
        return new Response("<!DOCTYPE html><title>Page not found</title>");
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new GitHubClient({ maxLinkedPullRequests: 30, fetchImpl: fetchImpl as typeof fetch });
    const evidence = await client.collect({ engine: "sglang", kind: "release", value: "v0.5.7", raw: "" });
    const details = JSON.parse(evidence.sections[1]!.content) as Array<Record<string, any>>;
    expect(evidence.metadata.referenced_pull_requests).toBe(1);
    expect(details).toEqual(expect.arrayContaining([
      expect.objectContaining({ object_kind: "roadmap_issue", number: 11857 }),
      expect.objectContaining({
        object_kind: "implementation_pull_request",
        number: 11852,
        selected_code_diff: expect.stringContaining("diff --git"),
      }),
    ]));
    expect(evidence.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://github.com/sgl-project/sglang/issues/11857" }),
      expect.objectContaining({ url: "https://github.com/sgl-project/sglang/pull/11852" }),
    ]));
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("99999"), expect.anything());
  });
});
