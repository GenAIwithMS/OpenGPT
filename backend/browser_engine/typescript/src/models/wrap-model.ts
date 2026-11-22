import type { Model } from "@openai/agents";

/**
 * A model wrapper that keeps the wrapped model's class. The SDK reads a model's class name to
 * decide what it can send it: hosted shell and apply_patch tools, structured tool output and
 * server-side compaction go only to models whose class isn't a Chat Completions one. A plain
 * object spread would lose the class, so a Chat Completions model behind a wrapper would get
 * Responses-only tools.
 */
export const wrapModel = <M extends Model>(model: M, overrides: Partial<Model>): M =>
  Object.assign(Object.create(Object.getPrototypeOf(model) as object) as M, model, overrides);
