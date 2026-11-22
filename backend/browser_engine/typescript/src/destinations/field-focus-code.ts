/**
 * Page code: whether the field itself holds its document's focus. A document's `activeElement`
 * names the outermost shadow host for a field inside a shadow root, so the field's own root is
 * read: a shadow root's `activeElement` is the field only when the field is the focused element,
 * not a sibling in the same root, in open, closed and nested roots alike. The field must also sit
 * in its own document's tree, not a detached subtree.
 */
export const holdsFocusCode = `(field) => {
  const root = field.getRootNode();
  return root.activeElement === field && field.getRootNode({ composed: true }) === field.ownerDocument;
}`;
