import { Schema } from "effect";

// Published ManagedAuthError categories (https://www.kernel.sh/openapi.json) and the login failure
// codes in Kernel's connection-lifecycle guide. The flow error_code is a free string, so this list
// is not exhaustive; the diagnostic keeps Kernel's exact code beside it (`providerErrorCode`).
export const ManagedAuthErrorCode = Schema.Literal(
  "login_form_not_found",
  "navigation_confused",
  "domain_not_allowed",
  "stuck_in_loop",
  "max_attempts_reached",
  "website_error",
  "network_error",
  "element_not_found",
  "credentials_invalid",
  "mfa_required",
  "external_action_required",
  "unsupported_auth_method",
  "bot_detected",
  "captcha_blocked",
  "session_expired",
  "no_active_flow",
  "flow_failed",
  "awaiting_input_timeout",
  "external_action_timeout",
  "flow_timeout",
  "max_steps_exceeded",
  "browser_error",
  "provider_unavailable",
  "internal_error",
  "totp_code_rejected",
  "totp_required",
  "sms_code_required",
  "email_code_required",
  "account_choice_required",
  "customer_input_required",
  "account_locked",
  "rate_limited",
);
