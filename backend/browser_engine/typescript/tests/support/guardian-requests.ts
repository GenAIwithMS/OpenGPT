import type { AgentInputItem, ModelRequest } from "@openai/agents";

/** A developer message's text, as `instructionsAsMessages` sends it, or undefined. */
const developerText = (item: AgentInputItem): string | undefined => {
  if (item.type !== "unknown") return undefined;
  const data: unknown = item.providerData;
  if (typeof data !== "object" || data === null || Reflect.get(data, "role") !== "developer")
    return undefined;
  const content: unknown = Reflect.get(data, "content");
  return Array.isArray(content)
    ? content
        .map((part: unknown) =>
          typeof part === "object" && part !== null ? String(Reflect.get(part, "text")) : "",
        )
        .join("")
    : undefined;
};

/**
 * The instructions a request sends the model: its leading developer messages, joined as the
 * agent's instructions are, or its top-level instructions.
 */
export const instructionsOf = (request: ModelRequest | undefined): string => {
  const input = request?.input;
  const texts: string[] = [];
  for (const item of Array.isArray(input) ? input : []) {
    const text = developerText(item);
    if (text === undefined) break;
    texts.push(text);
  }
  return [request?.systemInstructions, ...texts].filter((text) => text !== undefined).join("\n\n");
};

/** The request's input after its leading developer messages: the conversation itself. */
export const conversationOf = (request: ModelRequest | undefined): AgentInputItem[] => {
  const input = request?.input;
  const items = typeof input === "string" ? [] : [...(input ?? [])];
  while (items[0] !== undefined && developerText(items[0]) !== undefined) items.shift();
  return items;
};
