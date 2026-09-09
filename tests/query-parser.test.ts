import { describe, expect, it } from "vitest";
import { parseQuery, QueryParseError } from "../src/query-parser.js";

describe("parseQuery", () => {
  it.each([
    ["sglang v0.5.6", { engine: "sglang", kind: "release", value: "v0.5.6" }],
    ["帮我解释 vllm 0.10.2 release", { engine: "vllm", kind: "release", value: "0.10.2" }],
    ["sglang PR #12345", { engine: "sglang", kind: "pr", value: "12345" }],
    ["vllm issue 9876", { engine: "vllm", kind: "issue", value: "9876" }],
    ["sglang #45678", { engine: "sglang", kind: "number", value: "45678" }],
    [
      "https://github.com/vllm-project/vllm/pull/7777",
      { engine: "vllm", kind: "pr", value: "7777" },
    ],
    [
      "看看 https://github.com/sgl-project/sglang/issues/2222",
      { engine: "sglang", kind: "issue", value: "2222" },
    ],
  ])("parses %s", (input, expected) => {
    expect(parseQuery(input)).toMatchObject(expected);
  });

  it("requires an engine for non-URL queries", () => {
    expect(() => parseQuery("PR #123")).toThrow(QueryParseError);
  });
});
