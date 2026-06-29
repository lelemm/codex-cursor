import { describe, expect, test } from "bun:test";

import { normalizeOpenAiCompatibleRequest } from "../src/server.ts";

describe("normalizeOpenAiCompatibleRequest", () => {
  test("converts Cursor Chat Completions bodies to Responses bodies", () => {
    const normalized = normalizeOpenAiCompatibleRequest({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "You are Codex." },
        { role: "user", content: "Edit the file." },
      ],
      stream: true,
      tools: [
        {
          type: "function",
          function: {
            name: "apply_patch",
            description: "Apply a patch",
            parameters: { type: "object" },
          },
        },
      ],
      user: "cursor-user",
      stream_options: { include_usage: true },
    });

    expect(normalized).toEqual({
      model: "gpt-5.5",
      stream: true,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Edit the file." }],
        },
      ],
      instructions: "You are Codex.",
      tools: [
        {
          type: "function",
          name: "apply_patch",
          description: "Apply a patch",
          parameters: { type: "object" },
        },
      ],
      tool_choice: "auto",
    });
  });

  test("converts chat tool-call history", () => {
    const normalized = normalizeOpenAiCompatibleRequest({
      model: "gpt-5.5",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_123", content: "contents" },
      ],
      stream: true,
    });

    expect(normalized?.["input"]).toEqual([
      {
        type: "function_call",
        call_id: "call_123",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_123",
        output: "contents",
      },
    ]);
  });

  test("passes Responses bodies through unchanged", () => {
    const body = {
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hi" }],
        },
      ],
    };

    expect(normalizeOpenAiCompatibleRequest(body)).toBe(body);
  });
});
