export type SourceSyntax = "javascript" | "typescript";

export const sourceSyntax = (path: string): SourceSyntax | undefined => {
  if (/\.(?:js|mjs|cjs)$/.test(path)) return "javascript";
  if (/\.(?:ts|mts|cts)$/.test(path)) return "typescript";
  return undefined;
};
