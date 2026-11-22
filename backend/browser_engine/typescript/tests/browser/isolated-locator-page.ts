import { randomUUID } from "node:crypto";
import type { CDPSession, ElementHandle, Frame, Locator, Page } from "playwright";

/** Patchright's isolated world for locator evaluation, which also binds private typing. */
export const isolatedWorldName = "utility";

const boundMember = (target: object, property: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, property);
  const bound: unknown = typeof value === "function" ? value.bind(target) : value;
  return bound;
};

/**
 * Runs `fn` on the element `objectId` names with `arg`, or, when `handles` holds the object ids
 * of element handles passed as the argument, with those elements in its place.
 */
const runEvaluation = async (
  cdp: CDPSession,
  objectId: string,
  fn: unknown,
  arg: unknown,
  handles: readonly string[] | undefined,
): Promise<unknown> => {
  if (typeof fn !== "function") throw new Error("Fixture evaluator requires a function");
  try {
    const result = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration:
        handles === undefined
          ? `function(arg) { return (${String(fn)})(this, arg); }`
          : `function(...elements) { return (${String(fn)})(this, elements); }`,
      arguments: handles === undefined ? [{ value: arg }] : handles.map((handle) => ({ objectId: handle })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails !== undefined) throw new Error("Fixture evaluation failed");
    return result.result.value;
  } finally {
    for (const id of [objectId, ...(handles ?? [])]) await cdp.send("Runtime.releaseObject", { objectId: id });
  }
};

/** An argument that is a list of element handles, as Playwright passes them to an evaluation. */
const elementHandles = (arg: unknown): readonly ElementHandle<Element>[] | undefined => {
  if (!Array.isArray(arg) || arg.length === 0) return undefined;
  const handles: ElementHandle<Element>[] = [];
  for (const item of arg) {
    const asElement: unknown = typeof item === "object" && item !== null ? Reflect.get(item, "asElement") : undefined;
    if (typeof asElement !== "function" || Reflect.apply(asElement, item, []) !== item) return undefined;
    handles.push(item);
  }
  return handles;
};

/** Patchright's locator evaluation defaults to an isolated world; its fourth argument selects main. */
export const isolatedLocatorPage = async (page: Page) => {
  const sessions = new Map<Frame, CDPSession>();
  const originals = new WeakMap<Page | Frame, Page | Frame>();
  const pages = new WeakMap<Page, Page>();
  const frames = new WeakMap<Frame, Frame>();
  const sessionFor = async (frame: Frame) => {
    const existing = sessions.get(frame);
    if (existing !== undefined) return existing;
    const cdp = await page
      .context()
      .newCDPSession(frame)
      .catch((error: unknown) => {
        if (
          !(error instanceof Error) ||
          !error.message.includes("does not have a separate CDP session")
        )
          throw error;
        return page.context().newCDPSession(frame.page());
      });
    sessions.set(frame, cdp);
    return cdp;
  };
  /**
   * The node `mark` marks with a fresh `data-fixture-` attribute, which it then takes away: each
   * element an evaluation reads is marked as the read starts, which a test page can see.
   */
  const markedNode = async (
    cdp: CDPSession,
    mark: (key: string, marked: boolean) => Promise<unknown>,
  ) => {
    const key = `data-fixture-${randomUUID()}`;
    await mark(key, true);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const pending = [{ node: root, frameId: frameTree.frame.id }];
    let found: { backendNodeId: number; frameId: string } | undefined;
    while (pending.length > 0) {
      const next = pending.pop();
      if (next === undefined) break;
      const { node, frameId } = next;
      if (node.attributes?.includes(key)) found = { backendNodeId: node.backendNodeId, frameId };
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])])
        pending.push({ node: child, frameId });
      if (node.contentDocument !== undefined) {
        if (node.frameId === undefined) throw new Error("Fixture frame missing");
        pending.push({ node: node.contentDocument, frameId: node.frameId });
      }
    }
    await mark(key, false);
    if (found === undefined) throw new Error("Fixture element missing");
    return found;
  };
  const resolved = async (cdp: CDPSession, backendNodeId: number, executionContextId: number) => {
    const { object } = await cdp.send("DOM.resolveNode", { backendNodeId, executionContextId });
    if (object.objectId === undefined) throw new Error("Fixture element unresolved");
    return object.objectId;
  };
  const evaluate = async (
    locator: Locator,
    frame: Frame,
    fn: unknown,
    arg: unknown,
    options: unknown,
  ): Promise<unknown> => {
    const cdp = await sessionFor(frame);
    // The evaluation's own timeout bounds each wait for the element, as Patchright's does.
    const timeout: unknown =
      typeof options === "object" && options !== null ? Reflect.get(options, "timeout") : undefined;
    const wait = typeof timeout === "number" ? { timeout } : undefined;
    const found = await markedNode(cdp, (key, marked) =>
      locator.evaluate(
        (element, [marker, on]) => (on ? element.setAttribute(marker, "") : element.removeAttribute(marker)),
        [key, marked] as const,
        wait,
      ),
    );
    // Element handles in the argument are read in the same world, as Patchright adopts them. One
    // whose element the page took away has no node in the document to find; Patchright still
    // adopts it, as an element that is no longer connected, which the main world shows as well.
    const handles = elementHandles(arg);
    for (const handle of handles ?? [])
      if (!(await handle.evaluate((element) => element.isConnected))) {
        const mainEvaluate = boundMember(locator, "evaluate");
        if (typeof mainEvaluate !== "function") throw new Error("Fixture evaluator missing");
        const result: unknown = await Reflect.apply(mainEvaluate, locator, [fn, arg, wait]);
        return result;
      }
    const handleNodes = [];
    for (const handle of handles ?? []) {
      const node = await markedNode(cdp, (key, marked) =>
        handle.evaluate(
          (element, [marker, on]) => (on ? element.setAttribute(marker, "") : element.removeAttribute(marker)),
          [key, marked] as const,
        ),
      );
      if (node.frameId !== found.frameId) throw new Error("Fixture handle in another frame");
      handleNodes.push(node);
    }
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: found.frameId,
      worldName: isolatedWorldName,
    });
    const objectId = await resolved(cdp, found.backendNodeId, executionContextId);
    const handleIds = [];
    for (const node of handleNodes) handleIds.push(await resolved(cdp, node.backendNodeId, executionContextId));
    return runEvaluation(cdp, objectId, fn, arg, handles === undefined ? undefined : handleIds);
  };
  const locatorView = (locator: Locator, frame: Frame): Locator =>
    new Proxy(locator, {
      get: (target, property) => {
        if (property === "evaluate")
          return (fn: unknown, arg: unknown, options: unknown, isolatedContext = true): unknown => {
            if (isolatedContext) return evaluate(target, frame, fn, arg, options);
            const mainEvaluate = boundMember(target, property);
            if (typeof mainEvaluate !== "function") throw new Error("Fixture evaluator missing");
            const result: unknown = Reflect.apply(mainEvaluate, target, [fn, arg, options]);
            return result;
          };
        if (property === "nth") return (index: number) => locatorView(target.nth(index), frame);
        return boundMember(target, property);
      },
    });
  const frameView = (frame: Frame): Frame => {
    const existing = frames.get(frame);
    if (existing !== undefined) return existing;
    const view = new Proxy(frame, {
      get: (target, property) => {
        if (property === "locator")
          return (selector: string) => locatorView(target.locator(selector), target);
        return boundMember(target, property);
      },
    });
    frames.set(frame, view);
    originals.set(view, frame);
    return view;
  };
  const context = page.context();
  const contextView = new Proxy(context, {
    get: (target, property) => {
      if (property === "pages") return () => target.pages().map(pageView);
      if (property === "newCDPSession")
        return (subject: Page | Frame) => target.newCDPSession(originals.get(subject) ?? subject);
      return boundMember(target, property);
    },
  });
  const pageView = (actual: Page): Page => {
    const existing = pages.get(actual);
    if (existing !== undefined) return existing;
    const view = new Proxy(actual, {
      get: (target, property) => {
        if (property === "frames") return () => target.frames().map(frameView);
        if (property === "opener")
          return async () => {
            const opener = await target.opener();
            return opener === null ? null : pageView(opener);
          };
        if (property === "context") return () => contextView;
        return boundMember(target, property);
      },
    });
    pages.set(actual, view);
    originals.set(view, actual);
    return view;
  };
  return {
    page: pageView(page),
    close: () => Promise.all([...sessions.values()].map((cdp) => cdp.detach())),
  };
};
