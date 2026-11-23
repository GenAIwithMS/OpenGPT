import { Data } from "effect";

const tenantPolicySlot = "{{ tenant_policy_config }}";

/** The upstream Guardian policy has no single slot for OpenGPT's policy. */
export class UpstreamPolicySlotInvalid extends Data.TaggedError("UpstreamPolicySlotInvalid")<{
  readonly slots: number;
}> {
  override get message() {
    return `The upstream Guardian policy must contain ${tenantPolicySlot} exactly once; it contains it ${this.slots} times`;
  }
}

/**
 * The policy file's opening licence notice, which is for readers and never reaches the model. A
 * byte order mark or whitespace before it, and any line endings after it, go with it.
 */
const leadingNotice = /^\uFEFF?\s*<!--[\s\S]*?-->\s*/;

/**
 * Puts OpenGPT's policy in the upstream policy's one slot. An adapter calls it when it is built,
 * so a policy file without the slot stops startup instead of Guardian reviewing without
 * OpenGPT's policy. A leading HTML comment is dropped first, so the file's licence notice is
 * neither sent to the model nor counted as a slot.
 */
export const withTenantPolicy = (upstreamPolicy: string, tenantPolicy: string): string => {
  const policy = upstreamPolicy.replace(leadingNotice, "");
  const slots = policy.split(tenantPolicySlot).length - 1;
  if (slots !== 1) throw new UpstreamPolicySlotInvalid({ slots });
  return policy.replace(tenantPolicySlot, tenantPolicy);
};
