/**
 * Page code, inside a function evaluated on a control: `controlNaming(element)`, what names it as
 * the host reads it, never its value: the words of its labels and `aria-labelledby` elements
 * without their fields, its `aria-label` and `placeholder`, its `type` and `autocomplete`, and its
 * `name` and `id`.
 * Inspection describes a control with it, and the signed-in check compares a recorded challenge
 * field with it.
 */
export const controlNamingCode = `const controlNaming = (element) => {
  const labels = "labels" in element && element.labels ? Array.from(element.labels) : [];
  const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
    .split(/\\s+/).map((id) => element.ownerDocument.getElementById(id)).filter(Boolean);
  const words = (node) => {
    const copy = node.cloneNode(true);
    for (const field of copy.querySelectorAll("input,textarea,select")) field.remove();
    return copy.textContent;
  };
  return {
    label: [...labels, ...labelledBy].map(words).join(" "),
    placeholder: element.getAttribute("placeholder"),
    ariaLabel: element.getAttribute("aria-label"),
    type: element.getAttribute("type"),
    autocomplete: element.getAttribute("autocomplete"),
    name: element.getAttribute("name"),
    id: element.getAttribute("id"),
  };
};`;

/** Page code: `clip`, words as the host keeps them: trimmed and collapsed, at most 200 characters. */
export const clipCode = `const clip = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim().replace(/\\s+/g, " ").slice(0, 200) : null);`;
