import { Context } from "effect";
import { withDialogAction } from "./action.js";
import type { DialogActionPort } from "./action.js";

/** Assigned-page actions keep their original Promise alive under host dialog control. */
export const makeNativeDialogs = (actions: DialogActionPort, pageId: string) => ({
  run: <A>(
    actionId: string,
    actionAndPostcondition: (options: { readonly timeout: 0 }) => Promise<A>,
  ) => withDialogAction(actions, { pageId, actionId }, actionAndPostcondition),
});

export class NativeDialogs extends Context.Tag("opengpt-browser-engine/NativeDialogs")<
  NativeDialogs,
  ReturnType<typeof makeNativeDialogs>
>() {}
