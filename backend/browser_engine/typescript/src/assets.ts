import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const assetPath = (relative: string, directory: boolean): string => {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  try {
    const asset = statSync(path);
    if (directory ? asset.isDirectory() : asset.isFile()) return path;
  } catch {
    // Report the missing package asset with the same error as an unexpected asset type.
  }
  throw new Error(`OpenGPT package asset is missing: ${path}. Reinstall the pinned package version.`);
};

/** The shared authoring tree shipped with this installed package. */
export const getAuthoringDirectory = (): string => assetPath("../authoring/", true);

/** The upstream Guardian policy shipped with this installed package. */
export const getGuardianPolicyPath = (): string => assetPath("./guardian/upstream-policy.md", false);

export { getRuntimeSources, runtimeSourceEntry } from "./execution/runtime-sources.js";
