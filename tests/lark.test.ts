import { describe, expect, it } from "vitest";
import { card, extractText, isBotMentioned, stripMentions } from "../src/lark.js";

describe("Lark helpers", () => {
  it("strips Feishu mention placeholders", () => {
    expect(stripMentions("@_user_1 解释 sglang PR #123")).toBe("解释 sglang PR #123");
  });

  it("parses text content", () => {
    expect(extractText({
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 vllm 0.10.2" }),
    })).toBe("vllm 0.10.2");
  });

  it("does not treat @all as a bot mention", () => {
    expect(isBotMentioned({ mentions: [{ key: "@_all" }] })).toBe(false);
    expect(isBotMentioned({ mentions: [{ key: "@_user_1", id: { open_id: "bot" } }] }, "bot")).toBe(true);
  });

  it("builds a card 2.0 payload for plain messages", () => {
    expect(card("hello")).toMatchObject({
      schema: "2.0",
      header: { title: { content: "推理引擎解读" } },
      body: { elements: [{ tag: "markdown", content: "hello", text_size: "normal" }] },
    });
  });

  it("renders release headings with visible hierarchy", () => {
    const payload = card([
      "# SGLang v0.5.9 新 Feature 解读",
      "https://github.com/sgl-project/sglang/releases/tag/v0.5.9",
      "",
      "## 重点 Feature",
      "",
      "### 1. LoRA 权重加载与模型计算并行",
      "正文内容。",
    ].join("\n"));

    expect(payload).toMatchObject({
      schema: "2.0",
      header: { title: { content: "SGLang v0.5.9 新 Feature 解读" } },
      body: {
        elements: [
          { tag: "markdown", content: "https://github.com/sgl-project/sglang/releases/tag/v0.5.9" },
          { tag: "hr" },
          { tag: "markdown", content: "**重点 Feature**", text_size: "heading" },
          { tag: "markdown", content: "**1. LoRA 权重加载与模型计算并行**", text_size: "normal" },
          { tag: "markdown", content: "正文内容。", text_size: "normal" },
        ],
      },
    });
  });
});
