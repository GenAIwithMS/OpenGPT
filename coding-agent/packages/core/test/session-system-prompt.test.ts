import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("${OPENGPT_TOOL_GUIDANCE}")
  expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
})
