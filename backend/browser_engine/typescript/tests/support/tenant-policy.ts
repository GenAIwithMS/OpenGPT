const before = "Upstream policy before the slot.\n";
const slot = "{{ tenant_policy_config }}";
const after = "\nUpstream policy after the slot.";

/** An upstream Guardian policy whose markers bound the tenant policy an adapter puts in its slot. */
export const markedUpstreamPolicy = `${before}${slot}${after}`;

/**
 * How many times a model request's instructions carry the tenant policy an adapter put in
 * `markedUpstreamPolicy`'s slot. It never names the policy, so a policy edit needs no test edit.
 * An unfilled slot counts as none, whatever else the instructions carry.
 */
export const tenantPolicyCopies = (instructions: string): number => {
  if (instructions.includes(slot)) return 0;
  const start = instructions.indexOf(before);
  const end = instructions.indexOf(after, start);
  if (start === -1 || end === -1) return 0;
  const tenantPolicy = instructions.slice(start + before.length, end);
  return tenantPolicy.length === 0 ? 0 : instructions.split(tenantPolicy).length - 1;
};
