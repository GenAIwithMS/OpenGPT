import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentInputItem,
  Model,
  ModelRequest,
  ModelResponse,
  ModelSettings,
  StreamEvent,
} from "@openai/agents";

/**
 * A model on an API other than OpenAI's Responses API: an OpenAI-compatible Chat Completions
 * endpoint or an Anthropic-compatible one. The engine's requests use Responses-only features,
 * which this class turns into what any tool-calling chat API accepts:
 *
 * - `store`, reasoning summaries and context, `include`, prompt cache options and keys, and the
 *   provider's automatic compaction (`context_management`) are left out.
 * - `tool_choice: allowed_tools` becomes the request's tool list cut to the allowed tools.
 * - A cached developer message (raw provider data) becomes a system message with its text.
 * - A reasoning-effort update item is left out; reasoning items of earlier turns too.
 * - Compaction: a request that ends in the compaction trigger is answered by asking the model to
 *   summarise the conversation; the summary comes back as a compaction item, and on later
 *   requests a compaction item becomes a user message holding that summary.
 * - Function tools keep `strict` unless `strictTools` is false (for servers that reject it).
 * - Tool-call arguments with obvious type slips are corrected before the engine checks them: a
 *   number or boolean sent as text, and "" where the schema allows null.
 *
 * The class name contains "ChatCompletions" on purpose: the SDK reads it to send function tools
 * instead of hosted shell and apply_patch tools, and no server-side compaction.
 */
export class ChatCompletionsCompatModel implements Model {
  constructor(
    private readonly inner: Model,
    private readonly options: { readonly reasoningEffort?: boolean; readonly strictTools?: boolean } = {},
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    try {
      if (endsWithCompactionTrigger(request)) return await this.compact(request);
      const started = Date.now();
      const response = withCoercedArguments(await this.inner.getResponse(toChatRequest(request, this.options)), request);
      logModelCall(request, response, Date.now() - started);
      return response;
    } catch (error) {
      logModelError(error, toChatRequest(request, this.options));
      throw error;
    }
  }

  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    return this.inner.getStreamedResponse(toChatRequest(request, this.options));
  }

  private async compact(request: ModelRequest): Promise<ModelResponse> {
    const input = Array.isArray(request.input) ? request.input.slice(0, -1) : [];
    const asked: ModelRequest = {
      ...toChatRequest({ ...request, input }, this.options),
      tools: [],
      handoffs: [],
      input: [
        ...toChatItems(input),
        { role: "user", content: summaryRequest, type: "message" } as AgentInputItem,
      ],
    };
    const response = await this.inner.getResponse(asked);
    const summary = responseText(response).trim();
    return {
      ...response,
      output: summary
        ? [{ type: "compaction", id: `summary_${Date.now()}`, encrypted_content: summaryPrefix + summary }]
        : [],
    };
  }
}

/**
 * With BROWSER_ENGINE_LOG_MODEL_ERRORS=1, a failed model call writes its status and message to
 * stderr (never the request), so the backend's log shows why a provider refused it.
 */
const logModelError = (error: unknown, sent?: ModelRequest) => {
  const folder = process.env["BROWSER_ENGINE_DEBUG_DIR"];
  if (folder && sent !== undefined) {
    // Debugging only: the request a provider refused, to see what it objects to.
    try {
      writeFileSync(join(folder, `rejected-${Date.now()}.json`), JSON.stringify({ error: String(error), request: sent }, null, 1));
    } catch {
      // the folder may not exist; the error is still logged below
    }
  }
  if (process.env["BROWSER_ENGINE_LOG_MODEL_ERRORS"] !== "1") return;
  const status: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "status") : undefined;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Model call failed${status === undefined ? "" : ` (${String(status)})`}: ${message.slice(0, 500)}\n`);
};

type JsonSchema = Record<string, unknown>;

/** A schema with a local reference ("#/$defs/X") replaced by what it points to. */
const resolve = (schema: JsonSchema | undefined, root: JsonSchema | undefined): JsonSchema | undefined => {
  let current = schema;
  for (let depth = 0; depth < 10 && current && typeof current["$ref"] === "string"; depth++) {
    const path = String(current["$ref"]).replace(/^#\//, "").split("/");
    let found: unknown = root;
    for (const key of path) found = typeof found === "object" && found !== null ? Reflect.get(found, key) : undefined;
    current = typeof found === "object" && found !== null ? (found as JsonSchema) : undefined;
  }
  return current;
};

const types = (given: JsonSchema, root?: JsonSchema): string[] => {
  const schema = resolve(given, root) ?? given;
  const t = schema["type"];
  const listed = Array.isArray(t) ? t.map(String) : typeof t === "string" ? [t] : [];
  for (const key of ["anyOf", "oneOf"]) {
    const options = schema[key];
    if (Array.isArray(options))
      for (const option of options) if (typeof option === "object" && option !== null) listed.push(...types(option as JsonSchema, root));
  }
  return listed;
};

/** The smallest length the schema's text form allows (0 when none is set). */
const minLength = (given: JsonSchema, root?: JsonSchema): number => {
  const schema = resolve(given, root) ?? given;
  const own = typeof schema["minLength"] === "number" ? schema["minLength"] : 0;
  const options = [schema["anyOf"], schema["oneOf"]].flat()
    .filter((o): o is JsonSchema => typeof o === "object" && o !== null);
  return Math.max(own, ...options.map((o) => minLength(o, root)));
};

/** Text some models send for "no value". */
const NULL_WORDS = new Set(["", "None", "none", "null", "NULL", "Null", "nil", "undefined"]);

/** A value with obvious type slips corrected against its JSON schema. Exported for tests. */
export const coerce = (value: unknown, given: JsonSchema | undefined, root: JsonSchema | undefined = given): unknown => {
  const schema = resolve(given, root);
  if (schema === undefined || typeof schema !== "object") return value;
  const allowed = types(schema, root);
  // null for a list that must be there: an empty list.
  if (value === null && allowed.includes("array") && !allowed.includes("null")) return [];
  // An object or list where the schema wants text (JSON text fields): the JSON text of it.
  if (typeof value === "object" && value !== null && allowed.includes("string")
      && !allowed.includes("object") && !allowed.includes("array"))
    return JSON.stringify(value);
  if (typeof value === "string") {
    if (allowed.includes("null") && (NULL_WORDS.has(value.trim()) && (value.trim() !== "" || !allowed.includes("string"))))
      return null;
    // "" where null is allowed and the text must have a minimum length: null.
    if (value === "" && allowed.includes("null") && minLength(schema, root) > 0) return null;
    // "None" for a required number: the smallest value the schema allows (a safe default).
    if (NULL_WORDS.has(value.trim()) && !allowed.includes("null") && !allowed.includes("string")
        && (allowed.includes("integer") || allowed.includes("number")) && typeof schema["minimum"] === "number")
      return schema["minimum"];
    if ((allowed.includes("integer") || allowed.includes("number")) && !allowed.includes("string")) {
      const number = Number(value);
      if (value.trim() !== "" && Number.isFinite(number)) return number;
    }
    if (allowed.includes("boolean") && !allowed.includes("string") && (value === "true" || value === "false"))
      return value === "true";
    if ((allowed.includes("array") || allowed.includes("object")) && !allowed.includes("string")) {
      try {
        return coerce(JSON.parse(value), schema, root);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items = schema["items"];
    return typeof items === "object" && items !== null ? value.map((v) => coerce(v, items as JsonSchema, root)) : value;
  }
  if (typeof value === "object" && value !== null) {
    const properties = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
    const options = [schema["anyOf"], schema["oneOf"]].flat()
      .filter((o): o is JsonSchema => typeof o === "object" && o !== null)
      .map((o) => resolve(o, root) ?? o);
    // The union branch whose property names fit the value best.
    const keys = Object.keys(value);
    const withProperties = options
      .filter((o) => o["properties"] !== undefined)
      .sort((x, y) => fit(y, keys) - fit(x, keys))[0];
    const props = Object.keys(properties).length ? properties : ((withProperties?.["properties"] ?? {}) as Record<string, JsonSchema>);
    const fixed: Record<string, unknown> = Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, coerce(v, props[key], root)]));
    // A required field the model left out: an empty list for a list, null where null is allowed.
    const holder = Object.keys(properties).length ? schema : withProperties;
    const required = Array.isArray(holder?.["required"]) ? (holder["required"] as unknown[]) : [];
    for (const key of required) {
      if (typeof key !== "string" || key in fixed || props[key] === undefined) continue;
      const kinds = types(props[key], root);
      if (kinds.includes("null")) fixed[key] = null;
      else if (kinds.includes("array")) fixed[key] = [];
    }
    return fixed;
  }
  return value;
};

/** Raw line breaks and tabs inside JSON strings, escaped (they are invalid JSON there). */
const escapeControlCharacters = (raw: string): string => {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch === "\n") { out += "\\n"; continue; }
      else if (ch === "\r") { out += "\\r"; continue; }
      else if (ch === "\t") { out += "\\t"; continue; }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
};

/**
 * Arguments with a common slip repaired: a bare word as a value (`"op": create_file`) gets
 * quotes. Valid JSON comes back unchanged. Exported for tests.
 */
export const repairJson = (raw: string): string => {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return escapeControlCharacters(raw).replace(/(:\s*)([A-Za-z_][A-Za-z0-9_.-]*)(\s*[,}\]])/g, (whole, before: string, word: string, after: string) =>
      ["true", "false", "null"].includes(word) ? whole : `${before}"${word}"${after}`);
  }
};

/**
 * apply_patch arguments in the one form the tool reads reliably, `{"patch": "*** Begin Patch…"}`.
 * Models mix its forms (a command tuple beside an operation, `content` instead of a diff, a
 * "Create File" header, absolute /workspace paths). Exported for tests.
 */
export const normalizePatch = (args: unknown): unknown => {
  if (typeof args !== "object" || args === null) return args;
  const a = args as Record<string, unknown>;
  const command = Array.isArray(a["command"]) ? a["command"] : [];
  const text = [a["patch"], command[1], a["diff"]].find(
    (v): v is string => typeof v === "string" && v.includes("*** Begin Patch"));
  if (text !== undefined) return { patch: fixPatchText(text) };
  const operations = Array.isArray(a["operations"]) ? a["operations"] : [a["operation"] ?? a];
  const parts: string[] = [];
  for (const op of operations) {
    if (typeof op !== "object" || op === null) return args;
    const o = op as Record<string, unknown>;
    const type = String(o["type"] ?? a["type"] ?? (typeof a["operation"] === "string" ? a["operation"] : ""));
    const path = typeof o["path"] === "string" ? relativePath(o["path"]) : undefined;
    const content = typeof o["content"] === "string" ? o["content"] : undefined;
    const diff = typeof o["diff"] === "string" ? o["diff"] : undefined;
    if (!path) return args;
    if (type === "create_file" && (content ?? diff) !== undefined)
      parts.push(`*** Add File: ${path}\n${(content ?? diff ?? "").split("\n").map((line) => (content !== undefined || !line.startsWith("+") ? `+${line}` : line)).join("\n")}`);
    else if (type === "delete_file") parts.push(`*** Delete File: ${path}`);
    else return args;   // an update needs a real diff: leave it to the tool
  }
  return parts.length ? { patch: `*** Begin Patch\n${parts.join("\n")}\n*** End Patch` } : args;
};

const relativePath = (path: string) => path.replace(/^\/workspace\//, "").replace(/^\.\//, "");

const fixPatchText = (text: string) =>
  text
    .replace(/^\*\*\* Create File: /gm, "*** Add File: ")
    .replace(/^(\*\*\* (?:Add|Update|Delete) File: )\/workspace\//gm, "$1")
    .replace(/\s*$/, text.includes("*** End Patch") ? "" : "\n*** End Patch");

const fit = (schema: JsonSchema, keys: string[]) => {
  const names = Object.keys((schema["properties"] ?? {}) as object);
  return keys.filter((k) => names.includes(k)).length - names.filter((n) => !keys.includes(n)).length;
};

/** The response with each function call's arguments corrected against its tool's schema. */
const withCoercedArguments = (response: ModelResponse, request: ModelRequest): ModelResponse => {
  const schemas = new Map(request.tools.filter((t) => t.type === "function").map((t) => [t.name, Reflect.get(t, "parameters") as JsonSchema]));
  let changed = false;
  const output = response.output.map((item) => {
    if (item.type !== "function_call") return item;
    const schema = schemas.get(String(Reflect.get(item, "name")));
    const raw = String(Reflect.get(item, "arguments") ?? "");
    if (schema === undefined) return item;
    try {
      const parsed: unknown = JSON.parse(repairJson(raw));
      const value = String(Reflect.get(item, "name")) === "apply_patch" ? normalizePatch(parsed) : coerce(parsed, schema);
      const fixed = JSON.stringify(value);
      if (fixed === raw) return item;
      changed = true;
      return { ...item, arguments: fixed };
    } catch {
      return item;
    }
  });
  return changed ? { ...response, output } : response;
};

/**
 * With BROWSER_ENGINE_LOG_PROGRESS=1, each model call writes one line to stderr: its time, its
 * token counts and what the model did (the tools it called, or a text reply), never the content.
 */
const logModelCall = (request: ModelRequest, response: ModelResponse, ms: number) => {
  if (process.env["BROWSER_ENGINE_LOG_PROGRESS"] !== "1") return;
  const calls = response.output
    .filter((item) => item.type === "function_call")
    .map((item) => {
      const name = String(Reflect.get(item, "name"));
      // execute's arguments in full, to see which field a step's check refuses.
      return `${name}(${String(Reflect.get(item, "arguments")).replace(/\s+/g, " ").slice(0, name === "execute" ? 4000 : 200)})`;
    });
  const text = responseText(response).length;
  const usage = response.usage;
  // The last tool result the model was answering, shortened (debugging only).
  const input = Array.isArray(request.input) ? request.input : [];
  const last = [...input].reverse().find((item) => item.type === "function_call_result");
  if (last !== undefined) {
    const output: unknown = Reflect.get(last, "output");
    const shown = typeof output === "string" ? output : JSON.stringify(output);
    const tool = String(Reflect.get(last, "name"));
    process.stderr.write(`  after ${tool}: ${shown.replace(/\s+/g, " ").slice(0, tool === "execute" ? 3000 : 300)}\n`);
  }
  process.stderr.write(
    `Model call: ${ms} ms, ${usage.inputTokens} in / ${usage.outputTokens} out, ` +
      `${request.tools.length} tools offered -> ${calls.length ? `calls ${calls.join(", ")}` : `text (${text} chars): ${responseText(response).replace(/\s+/g, " ").slice(0, 240)}`}\n`,
  );
};

/** Marks a summary this class wrote inside a compaction item. */
export const summaryPrefix = "opengpt-summary:";

const summaryRequest =
  "Summarise the conversation so far for yourself, so you can continue the task without it. " +
  "Keep every fact you still need: the task and its constraints, what you found on the site " +
  "(URLs, selectors, field names, values), the files you wrote and what each does, what was " +
  "tested and its results, the user's answers, and what is left to do. Plain text, no preamble.";

const endsWithCompactionTrigger = (request: ModelRequest) => {
  if (!Array.isArray(request.input) || request.input.length === 0) return false;
  const last = request.input[request.input.length - 1];
  return rawType(last) === "compaction_trigger";
};

/** The `type` of an item's raw provider data, for items the SDK passes as "unknown". */
const rawType = (item: AgentInputItem | undefined): unknown =>
  item !== undefined && item.type === "unknown" && item.providerData !== undefined
    ? Reflect.get(item.providerData, "type")
    : undefined;

const responsesOnlySettings = [
  "include",
  "prompt_cache_options",
  "prompt_cache_key",
  "context_management",
  "tool_choice",
  "reasoning",
  "store",
  "truncation",
] as const;

/** The request with only what a tool-calling chat API accepts. Exported for tests. */
export const toChatRequest = (
  request: ModelRequest,
  options: { readonly reasoningEffort?: boolean; readonly strictTools?: boolean } = {},
): ModelRequest => {
  const settings = request.modelSettings;
  const providerData = { ...(settings.providerData ?? {}) };
  const allowed = allowedToolNames(providerData["tool_choice"]);
  for (const key of responsesOnlySettings) delete providerData[key];
  const effort = settings.reasoning?.effort;
  const { store: _store, reasoning: _reasoning, parallelToolCalls: _parallel, promptCacheOptions: _cache, ...rest } =
    settings as ModelSettings & { promptCacheOptions?: unknown };
  const modelSettings: ModelSettings = {
    ...rest,
    ...(options.reasoningEffort && effort ? { reasoning: { effort } } : {}),
    providerData,
  };
  const tools = (allowed === undefined ? request.tools : request.tools.filter((t) => allowed.has(t.name))).map(
    (tool) => (tool.type === "function" && options.strictTools === false ? { ...tool, strict: false } : tool),
  );
  return {
    ...request,
    modelSettings,
    tools,
    input: Array.isArray(request.input) ? toChatItems(request.input) : request.input,
  };
};

const allowedToolNames = (choice: unknown): Set<string> | undefined => {
  if (typeof choice !== "object" || choice === null) return undefined;
  if (Reflect.get(choice, "type") !== "allowed_tools") return undefined;
  const tools: unknown = Reflect.get(choice, "tools");
  if (!Array.isArray(tools)) return undefined;
  return new Set(
    tools.map((t: unknown) => (typeof t === "object" && t !== null ? Reflect.get(t, "name") : undefined))
      .filter((name): name is string => typeof name === "string"),
  );
};

/**
 * Input items a chat API accepts, in the same order. System messages only lead the
 * conversation (merged into one): many chat APIs refuse a system message after others, so a
 * later one becomes a user message marked as a host note.
 */
export const toChatItems = (items: readonly AgentInputItem[]): AgentInputItem[] => {
  const converted = plainItems(items);
  const leading: string[] = [];
  let index = 0;
  for (; index < converted.length; index++) {
    const item = converted[index] as { role?: string; content?: unknown };
    if (item.role !== "system" || typeof item.content !== "string") break;
    leading.push(item.content);
  }
  const rest = converted.slice(index).map((item) => {
    const message = item as { role?: string; content?: unknown };
    return message.role === "system" && typeof message.content === "string"
      ? ({ type: "message", role: "user", content: `Host note:\n${message.content}` } as AgentInputItem)
      : item;
  });
  return leading.length
    ? [{ type: "message", role: "system", content: leading.join("\n\n") } as AgentInputItem, ...rest]
    : rest;
};

const plainItems = (items: readonly AgentInputItem[]): AgentInputItem[] =>
  items.flatMap((item): AgentInputItem[] => {
    const raw = rawType(item);
    if (raw === "message" && item.type === "unknown") {
      const data = item.providerData ?? {};
      const content: unknown = Reflect.get(data, "content");
      const text = Array.isArray(content)
        ? content.map((part: unknown) => (typeof part === "object" && part !== null ? Reflect.get(part, "text") : ""))
          .filter((t): t is string => typeof t === "string").join("\n\n")
        : typeof content === "string" ? content : "";
      const role = Reflect.get(data, "role") === "user" ? "user" : "system";
      return text ? [{ type: "message", role, content: text } as AgentInputItem] : [];
    }
    if (raw === "configuration_update" || raw === "compaction_trigger") return [];
    if (item.type === "reasoning") return [];
    if (item.type === "function_call") {
      // A provider refuses a whole request whose history holds a tool call with invalid JSON.
      const raw = String(item.arguments ?? "");
      try {
        JSON.parse(raw);
        return [item];
      } catch {
        const repaired = repairJson(raw);
        try {
          JSON.parse(repaired);
          return [{ ...item, arguments: repaired }];
        } catch {
          return [{ ...item, arguments: JSON.stringify({ invalid_arguments: raw.slice(0, 2000) }) }];
        }
      }
    }
    if (item.type === "compaction") {
      const text = item.encrypted_content.startsWith(summaryPrefix)
        ? item.encrypted_content.slice(summaryPrefix.length)
        : "(An earlier part of this conversation was compacted and is not available.)";
      return [{
        type: "message",
        role: "user",
        content: `Host note: earlier turns were summarised to save context. Summary:\n\n${text}`,
      } as AgentInputItem];
    }
    return [item];
  });

const responseText = (response: ModelResponse): string =>
  response.output
    .map((item): string => {
      if (item.type !== "message") return "";
      const content: unknown = Reflect.get(item, "content");
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part: unknown) =>
          typeof part === "object" && part !== null && Reflect.get(part, "type") === "output_text"
            ? String(Reflect.get(part, "text") ?? "")
            : "")
        .join("");
    })
    .join("");
