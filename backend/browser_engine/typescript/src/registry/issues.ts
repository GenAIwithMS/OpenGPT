export type RegistryIssue =
  | "definition_invalid"
  | "site_origin_invalid"
  | "destination_evidence_invalid"
  | "variants_invalid"
  | "login_url_without_signed_in_browser"
  | "login_url_unusable"
  | "target_mismatch"
  | "write_confirmation_on_read"
  | "catalog_generation_invalid"
  | "attempt_stopped"
  | "catalog_moved"
  | "variant_removed"
  | "variant_contract_changed"
  | "generation_moved"
  | "revision_exists"
  /** Another enabled tool in the integration has the same tool name. */
  | "tool_name_taken";
