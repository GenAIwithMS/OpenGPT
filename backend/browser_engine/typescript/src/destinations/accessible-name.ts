/*
 * Source: Playwright 1.63.0, packages/injected/src/roleUtils.ts (the accessible name computation),
 * https://github.com/microsoft/playwright
 * Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0. See
 * THIRD_PARTY_NOTICES.md.
 * Modified by OpenGPT. It is rewritten as one self-contained page function that keeps what was
 * typed out of a name as far as page code can tell: never a field's value or placeholder, an
 * editable element's text, or CSS generated text that holds an attribute value or a value typed in
 * this document or its open shadow roots (not other frames).
 */

/**
 * Page code: `accessibleNames()` returns a reader of controls' accessible names, as Playwright's
 * `role=` selector computes the name it matches, so a selector written from a name finds its
 * control. A name comes from `aria-labelledby`, else `aria-label`, else the control's labels or
 * its native text (an input button's value, an image's alt text), else its own words for a role a
 * person reads from its content, such as a button or link, else its `title`. Words the page hides
 * from assistive technology (`aria-hidden="true"`, `display: none`, `visibility: hidden`) add
 * nothing, unless the label or referenced element that holds them is hidden itself, and CSS
 * generated text adds its quoted words. A control the page hides is named as the selector's
 * `include-hidden` names it: with its hidden words.
 * It keeps what was typed out of a name as far as page code can tell. A field, an editable element
 * or a control that holds a value, such as a text box, list box or slider, adds nothing to a name it
 * sits in, where Playwright would add its value or text; an editable control is never named by its
 * own words; and a placeholder never names a field. CSS generated text adds nothing when it holds,
 * at two characters or more, one of its element's attribute values other than its class, id or
 * style, as `attr()` reads them, or a value that a text field or editable element holds now in this
 * document or its open shadow roots, since a page may draw what was typed from an attribute, a
 * custom property or a rule its script adds. Those values are read only to compare. Text a page
 * draws from a value no such field holds any more, or holds in another frame, is not caught, so the
 * host still screens names for typed values. Names come back as the page has them, never trimmed or
 * collapsed.
 *
 * It is self-contained: `pageControlsCode` embeds this same function. The reader keeps computed
 * styles for the page as it is now, so read names with one reader at a time and drop it after.
 */
export const accessibleNames = (): ((target: Element) => string) => {
  interface Context {
    readonly visited: Set<Element>;
    /** Read hidden words too: the control itself is hidden. */
    readonly includeHidden: boolean;
    /** Inside the control ("self"), its content ("descendant"), or a label or reference. */
    readonly scope: "self" | "descendant" | "other";
    /** Inside an aria-labelledby reference, whose own references are not followed. */
    readonly referenced: boolean;
    /** Inside a label, reference or native text alternative: every element lends its words. */
    readonly labelled: boolean;
    /** The label, reference or text alternative being read is hidden, so its hidden words count. */
    readonly hiddenRoot: boolean;
  }
  // Roles named from their content, and roles that lend their content to such a name.
  const contentRoles = new Set(
    "button cell checkbox columnheader gridcell heading link menuitem menuitemcheckbox menuitemradio option radio row rowheader switch tab tooltip treeitem".split(" "),
  );
  const lendingRoles = new Set(
    " caption code contentinfo definition deletion emphasis insertion list listitem mark none paragraph presentation region row rowgroup section strong subscript superscript table term time".split(" "),
  );
  // Roles that hold a value, never read into a name.
  const valueRoles = new Set(
    "textbox searchbox combobox listbox slider spinbutton progressbar scrollbar meter menu".split(" "),
  );
  const valueTags = new Set(["input", "textarea", "select", "datalist", "progress", "meter"]);
  // Implicit roles that matter here: a button names itself, and the others lend no content.
  const implicitRoles: Readonly<Record<string, string>> = {
    button: "button",
    article: "article",
    aside: "complementary",
    blockquote: "blockquote",
    details: "group",
    dialog: "dialog",
    fieldset: "group",
    figure: "figure",
    hr: "separator",
    main: "main",
    math: "math",
    nav: "navigation",
    optgroup: "group",
    output: "status",
    search: "search",
    svg: "img",
  };
  const ignoredTags = new Set(["style", "script", "noscript", "template"]);
  const landmarkFree =
    "article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]";
  // A native text alternative: a fieldset's legend, a figure's caption, a table's caption.
  const captions: Readonly<Record<string, string>> = {
    fieldset: "legend",
    figure: "figcaption",
    table: "caption",
  };

  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (element: Element) => {
    let computed = styles.get(element);
    if (computed === undefined) {
      computed = getComputedStyle(element);
      styles.set(element, computed);
    }
    return computed;
  };
  const parentOf = (element: Element): Element | null => {
    if (element.parentElement !== null) return element.parentElement;
    const parent = element.parentNode;
    return parent instanceof ShadowRoot ? parent.host : null;
  };
  // Under display: none or aria-hidden="true", or a shadow host's child that no slot shows.
  const chains = new Map<Element, boolean>();
  const inHiddenChain = (element: Element): boolean => {
    let hidden = chains.get(element);
    if (hidden === undefined) {
      const parent = parentOf(element);
      hidden =
        (Boolean(element.parentElement?.shadowRoot) && element.assignedSlot === null) ||
        style(element).display === "none" ||
        element.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
        (parent !== null && inHiddenChain(parent));
      chains.set(element, hidden);
    }
    return hidden;
  };
  const shownText = (node: Node) => {
    const range = document.createRange();
    range.selectNode(node);
    const box = range.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  // Hidden from assistive technology, as Playwright reads it.
  const hiddenElements = new Map<Element, boolean>();
  const hidden = (element: Element): boolean => {
    let found = hiddenElements.get(element);
    if (found === undefined) {
      const computed = style(element);
      const slot = element.localName === "slot";
      const option = element.localName === "option" && element.closest("select") !== null;
      if (ignoredTags.has(element.localName)) found = true;
      else if (computed.display === "contents" && !slot)
        found = !Array.from(element.childNodes).some((child) =>
          child instanceof Element
            ? !hidden(child)
            : child.nodeType === Node.TEXT_NODE && shownText(child),
        );
      else if (
        !option &&
        !slot &&
        (!element.checkVisibility() || computed.visibility !== "visible")
      )
        found = true;
      else found = inHiddenChain(element);
      hiddenElements.set(element, found);
    }
    return found;
  };

  // The elements an ID reference attribute names, once each, in its document or shadow root.
  const references = (element: Element, attribute: string): Element[] => {
    const root = element.getRootNode();
    if (!(root instanceof Document || root instanceof ShadowRoot)) return [];
    const found: Element[] = [];
    for (const id of (element.getAttribute(attribute) ?? "").split(/\s+/u)) {
      const target = id === "" ? null : root.getElementById(id);
      if (target !== null && !found.includes(target)) found.push(target);
    }
    return found;
  };
  const roleOf = (element: Element): string => {
    const explicit = (element.getAttribute("role") ?? "").trim().split(/\s+/u)[0] ?? "";
    if (explicit !== "") return explicit;
    const tag = element.localName;
    if (tag === "a" || tag === "area") return element.hasAttribute("href") ? "link" : "";
    if (tag === "header" || tag === "footer")
      return element.closest(landmarkFree) !== null ? "" : tag === "header" ? "banner" : "contentinfo";
    if (tag === "form")
      return element.hasAttribute("aria-label") || element.hasAttribute("aria-labelledby") ? "form" : "";
    return implicitRoles[tag] ?? "";
  };

  // What this document and its open shadow roots hold as typed now: each text field's value and
  // each editable element's text, trimmed, when two characters or more (one turns up in any text by
  // chance). Read once, when generated text first needs it, and only to compare.
  const untyped = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "hidden", "file", "color", "range"]);
  let typedValues: string[] | undefined;
  const typed = () => {
    if (typedValues === undefined) {
      typedValues = [];
      const roots: (Document | ShadowRoot)[] = [document];
      for (let index = 0; index < roots.length; index += 1) {
        for (const source of Array.from(roots[index]?.querySelectorAll("*") ?? [])) {
          if (source.shadowRoot !== null) roots.push(source.shadowRoot);
          const value =
            source instanceof HTMLInputElement
              ? untyped.has(source.type) ? "" : source.value
              : source instanceof HTMLTextAreaElement
                ? source.value
                : source instanceof HTMLElement && source.hasAttribute("contenteditable") && source.isContentEditable
                  ? (source.textContent ?? "")
                  : "";
          if (value.trim().length >= 2) typedValues.push(value.trim());
        }
      }
    }
    return typedValues;
  };
  // CSS generated text: a pseudo-element's content, or an element's own content's alternative
  // after "/", when it is only quoted strings; none for anything else, such as an image. None
  // either when it holds, at two characters or more, one of the element's own attribute values, as
  // attr() reads them, or a value typed on the page: a page may draw what was typed from an
  // attribute, a custom property or a rule its script adds, and the browser gives each already
  // resolved, as a quoted string. Its class and id are left out, since generated text often repeats
  // a class such as "required"; a typed value copied there is still in its field.
  const readGenerated = (element: Element, pseudo: "::before" | "::after" | null) => {
    const computed = pseudo === null ? style(element) : getComputedStyle(element, pseudo);
    const content = computed.content;
    if (content === "" || content === "none" || content === "normal") return undefined;
    if (computed.display === "none" || computed.visibility === "hidden") return undefined;
    const tokens: { readonly text: string | null; readonly slash?: true }[] = [];
    let index = 0;
    while (index < content.length) {
      const char = content.charAt(index);
      if (/\s/u.test(char)) {
        index += 1;
      } else if (char === '"' || char === "'") {
        let text = "";
        index += 1;
        while (index < content.length && content.charAt(index) !== char) {
          if (content.charAt(index) !== "\\") {
            text += content.charAt(index);
            index += 1;
            continue;
          }
          const hex = /^[0-9a-f]{1,6}\s?/iu.exec(content.slice(index + 1));
          if (hex !== null) {
            const code = Number.parseInt(hex[0], 16);
            text += code === 0 || code > 0x10ffff ? "\uFFFD" : String.fromCodePoint(code);
            index += 1 + hex[0].length;
          } else {
            if (content.charAt(index + 1) !== "\n") text += content.charAt(index + 1);
            index += 2;
          }
        }
        if (index >= content.length) return undefined;
        index += 1;
        tokens.push({ text });
      } else if (char === "/") {
        tokens.push({ text: null, slash: true });
        index += 1;
      } else {
        const other = /^[^\s"'/(]*(?:\([^)]*\))?/u.exec(content.slice(index))?.[0] ?? "";
        if (other === "") return undefined;
        tokens.push({ text: null });
        index += other.length;
      }
    }
    const slash = tokens.findIndex((token) => token.slash === true);
    if (slash === -1 && pseudo === null) return undefined;
    const kept = tokens.slice(slash + 1);
    if (kept.some((token) => token.text === null)) return undefined;
    const text = kept.map((token) => token.text ?? "").join("");
    const copied =
      Array.from(element.attributes).some(
        ({ name, value }) =>
          !["class", "id", "style"].includes(name) && value.trim().length >= 2 && text.includes(value.trim()),
      ) || typed().some((value) => text.includes(value));
    if (copied) return undefined;
    return pseudo !== null && (computed.display || "inline") !== "inline" ? " " + text + " " : text;
  };
  // Each pseudo-element's generated text, read once per reader: nested controls read it often.
  const pseudoTexts = {
    "::before": new Map<Element, string | undefined>(),
    "::after": new Map<Element, string | undefined>(),
  };
  const generated = (element: Element, pseudo: "::before" | "::after" | null) => {
    if (pseudo === null) return readGenerated(element, null);
    const texts = pseudoTexts[pseudo];
    if (!texts.has(element)) texts.set(element, readGenerated(element, pseudo));
    return texts.get(element);
  };

  // An element's words: its generated text and each child's text alternative, a block apart.
  const contentOf = (element: Element, context: Context): string => {
    let text = generated(element, "::before") ?? "";
    const own = generated(element, null);
    if (own !== undefined) text += own;
    else {
      const visit = (node: Node, skipSlotted: boolean) => {
        if (skipSlotted && (node instanceof Element || node instanceof Text) && node.assignedSlot !== null)
          return;
        if (node instanceof Element) {
          const part = alternative(node, context);
          text +=
            (style(node).display || "inline") !== "inline" || node.localName === "br"
              ? " " + part + " "
              : part;
        } else if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
      };
      const assigned = element instanceof HTMLSlotElement ? element.assignedNodes() : [];
      if (assigned.length > 0) for (const node of assigned) visit(node, false);
      else {
        for (const node of Array.from(element.childNodes)) visit(node, true);
        for (const node of Array.from(element.shadowRoot?.childNodes ?? [])) visit(node, true);
        for (const owned of references(element, "aria-owns")) visit(owned, true);
      }
    }
    return text + (generated(element, "::after") ?? "");
  };

  const labelsOf = (element: Element): HTMLLabelElement[] =>
    "labels" in element && element.labels instanceof NodeList
      ? Array.from(element.labels).filter((label) => label instanceof HTMLLabelElement)
      : [];
  const fromLabels = (labels: readonly HTMLLabelElement[], context: Context) =>
    labels
      .map((label) =>
        alternative(label, {
          ...context,
          scope: "other",
          referenced: false,
          labelled: true,
          hiddenRoot: hidden(label),
        }),
      )
      .filter((text) => text !== "")
      .join(" ");

  // The element's text alternative, by the accessible name rules Playwright follows.
  const alternative = (element: Element, context: Context): string => {
    const { visited } = context;
    if (visited.has(element)) return "";
    if (!context.includeHidden && (ignoredTags.has(element.localName) || (!context.hiddenRoot && hidden(element)))) {
      visited.add(element);
      return "";
    }
    const referenced = references(element, "aria-labelledby");
    if (!context.referenced) {
      const text = referenced
        .map((reference) =>
          alternative(reference, {
            ...context,
            scope: "other",
            referenced: true,
            labelled: true,
            hiddenRoot: hidden(reference),
          }),
        )
        .join(" ");
      if (text !== "") return text;
    }
    const tag = element.localName;
    const role = roleOf(element);
    // A field, an editable element or a control that holds a value lends nothing: never what was
    // typed or chosen. An editable control is not named by its own words either, below.
    const editable = element instanceof HTMLElement && element.isContentEditable;
    if ((context.labelled || context.scope === "descendant") && (valueTags.has(tag) || valueRoles.has(role) || editable)) {
      visited.add(element);
      return "";
    }
    const label = element.getAttribute("aria-label") ?? "";
    if (label.trim() !== "") {
      visited.add(element);
      return label;
    }
    const inner: Context = { ...context, scope: context.scope === "self" ? "descendant" : context.scope };
    const presentational = role === "presentation" || role === "none";
    const title = element.getAttribute("title") ?? "";
    if (!presentational) {
      if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)) {
        visited.add(element);
        if (element.value.trim() !== "") return element.value;
        return element.type === "submit" ? "Submit" : element.type === "reset" ? "Reset" : title;
      }
      if (element instanceof HTMLInputElement && (element.type === "image" || element.type === "file")) {
        visited.add(element);
        const labels = labelsOf(element);
        if (labels.length > 0 && !context.referenced) return fromLabels(labels, context);
        if (element.type === "file") return "Choose File";
        const alt = element.getAttribute("alt") ?? "";
        return alt.trim() !== "" ? alt : title.trim() !== "" ? title : "Submit";
      }
      if (referenced.length === 0 && ["button", "input", "textarea", "select", "meter", "progress", "output"].includes(tag)) {
        visited.add(element);
        const labels = labelsOf(element);
        if (labels.length > 0) return fromLabels(labels, context);
        // A field's placeholder may hold what was typed, so it never names one.
        if (tag !== "button") return title;
      }
      const caption = captions[tag];
      if (caption !== undefined && (tag === "table" || referenced.length === 0)) {
        visited.add(element);
        const child = Array.from(element.children).find((found) => found.localName === caption);
        if (child !== undefined)
          return alternative(child, { ...inner, labelled: true, hiddenRoot: context.hiddenRoot || hidden(child) });
        if (tag !== "table") return title;
        const summary = element.getAttribute("summary") ?? "";
        if (summary !== "") return summary;
      }
      if (tag === "img" || tag === "area") {
        visited.add(element);
        const alt = element.getAttribute("alt") ?? "";
        return alt.trim() !== "" ? alt : title;
      }
      if (element instanceof SVGElement) {
        visited.add(element);
        const svgTitle = Array.from(element.children).find((found) => found.localName === "title");
        if (svgTitle !== undefined) return svgTitle.textContent ?? "";
      }
    }
    if (
      !editable &&
      (contentRoles.has(role) ||
        (context.scope === "descendant" && lendingRoles.has(role)) ||
        (tag === "summary" && !presentational) ||
        context.labelled)
    ) {
      visited.add(element);
      const text = contentOf(element, inner);
      if ((context.scope === "self" ? text.trim() : text) !== "") return text;
    }
    visited.add(element);
    if ((!presentational || tag === "iframe" || tag === "frame") && title.trim() !== "") return title;
    return "";
  };

  return (target) => {
    const visited = new Set<Element>();
    return alternative(target, {
      visited,
      includeHidden: hidden(target),
      scope: "self",
      referenced: false,
      labelled: false,
      hiddenRoot: false,
    });
  };
};
