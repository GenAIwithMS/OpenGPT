export type RetainedProviderStage =
  | "profile_decode"
  | "connection_decode"
  | "connection_duplicate_fields"
  | "timeline_decode"
  | "browser_session_mismatch"
  | "login_browser_decode"
  | "login_already_running"
  | "login_response_decode"
  | "submit_state"
  /** The provider answered the submission `accepted: false`. */
  | "submit_rejected"
  | "submit_response_decode"
  | "cleanup_identity_decode";
export type RetainedProviderSchemaField =
  "profile" | "profile.id" | "profile_save_changes" | "stealth" | "browser.stealth" | "other";
export type RetainedProviderCode =
  | "Unavailable"
  | "InvalidConfiguration"
  | "ProxyUnavailable"
  | "AllocationUncertain"
  /** The provider answered the create with a definite refusal, so no browser exists. */
  | "AllocationRejected"
  | "StopUnconfirmed"
  | "UnexpectedBrowserState"
  | "StorageUnavailable"
  | "BindingNotFound";

/** Network failure codes a host retains in sign-in diagnostics, as its provider reported them. */
export type RetainedNetworkError =
  | "upstream_timeout"
  | "provider_unreachable"
  | "upstream_connect_failed"
  | "upstream_dns_failure"
  | "origin_tls_timeout"
  | "restricted_route_unavailable"
  | "destination_route_unavailable"
  | "proxy_unavailable"
  | "origin_response_incomplete"
  | "provider_rejected"
  | "provider_blacklisted"
  | "destination_blocked"
  | "mitm_certificate"
  | "mitm_tls"
  | "mitm_tls_rejected"
  | "mitm_connect"
  | "mitm_stream"
  | "mitm_io"
  | "mitm_timeout"
  | "mitm_canceled"
  | "mitm_upstream_proxy"
  | "mitm_h1"
  | "mitm_request_invalid"
  | "mitm_other"
  | "proxy_forbidden"
  | "proxy_auth_required"
  | "proxy_rate_limited"
  | "other";

/** How the host replaced a browser after a failure, as the agent sees it. */
export type BrowserRecoverySummary =
  | {
      readonly kind: "switched";
      readonly egress: "proxy" | "direct";
      readonly cause: string;
      /** The failed loads may have reached the site. */
      readonly possiblySent: boolean;
      readonly inFlightPossiblySent: true;
      readonly repeated: false;
      /** The browser's cookies, cache and site storage were cleared for the replacement. */
      readonly stateCleared: true;
      /** Set when the clear ended the site's signed-in session. */
      readonly signIn?: "again_once" | "unavailable";
      /** The page a read's new browser reopened: the last page the site served the old one. */
      readonly resumedPage?: string;
      /** The agent asked for it (`request_browser_recovery`). */
      readonly requested?: true;
      readonly fromMode?: string;
      readonly toMode?: string;
    }
  | {
      readonly kind: "no_proxy_left" | "deadline";
      readonly cause: string;
      readonly possiblySent: boolean;
      readonly repeated: false;
    }
  | {
      readonly kind: "browser_unavailable";
      readonly repeated: false;
      /** The host could not stop a browser or confirm a new one: its fault, not the site's. */
      readonly hostFault?: true;
    };
