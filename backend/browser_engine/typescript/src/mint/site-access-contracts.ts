export type SiteAccessDiagnostic =
  | { readonly code: "site_bot_challenge"; readonly evidence: "screened_page_and_response_headers" }
  | { readonly code: "site_rate_limited"; readonly evidence: "response_headers" };
