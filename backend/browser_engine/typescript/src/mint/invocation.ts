export type CurrentInvocation =
  | { readonly status: "outcome_unknown" }
  | { readonly status: "partial"; readonly evidenceRef: string }
  | { readonly status: "resolved"; readonly evidenceRef: string; readonly resultRef: string };
