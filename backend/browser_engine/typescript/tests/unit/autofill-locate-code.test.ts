import { expect, it } from "vitest";
import { formControlsCode } from "../../src/browser/form-controls.js";
import { locateCode } from "../../src/destinations/autofill-locate-code.js";

// A step call reads a control's shape in the same evaluation as its other properties, with the
// function `formControlShape` evaluates, so the two never judge a control's shape differently.
it("reads a control's shape with the function formControlShape evaluates", () => {
  const shape =
    /const formControlShape = \(control, options\) =>\n {2}control\.evaluate\((\(element\) => \{[\s\S]*?\n {2}\}), undefined, options\);\n/u.exec(
      formControlsCode,
    )?.[1];
  expect(shape).toBeDefined();
  expect(locateCode).toContain(`shape: (${shape ?? "missing"})(element),`);
});
