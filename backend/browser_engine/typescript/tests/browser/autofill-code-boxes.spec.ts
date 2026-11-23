import { expect, test, type Page } from "@playwright/test";
import { Effect } from "effect";
import {
  codeBoxesRefusal,
  inspectAutofillStep,
  type AutofillStep,
} from "../../src/destinations/autofill-step.js";
import { hostPage } from "./autofill-host-page.js";

// Which code fields the host's inspection reads as one-character code boxes, and where each sits
// among them, when a page limits each box to one character by its own script rather than by
// `maxlength`. Chromium must lay the page out: a box counts only when it shows.

const site = "https://bank.example.test";

/** `count` see-through `tel` boxes with no `maxlength`, in one container, as script widgets draw. */
const scriptBoxes = (count: number) =>
  `<div id="boxes" style="display:flex;gap:4px"><input type="hidden" name="code">${Array.from(
    { length: count },
    (_, at) =>
      `<input id="box-${at + 1}" type="tel" inputmode="numeric" autocomplete="one-time-code" style="opacity:0;width:32px;height:40px">`,
  ).join("")}</div>`;

/** The code fields of each box, in order. */
const boxFields = (boxes: readonly number[]): AutofillStep["fields"] =>
  boxes.map((box) => ({ selector: `#box-${box}`, slot: "code" }));

/** Inspects the step on a page that shows `screen` in a form with a Verify button. */
const inspect = async (page: Page, screen: string, fields: AutofillStep["fields"]) => {
  await page.route(`${site}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<form method="post" action="/verify"><p>Enter the code we sent you</p>${screen}<button id="verify">Verify</button></form>`,
    }),
  );
  await page.goto(`${site}/verify`);
  const step: AutofillStep = { fields, submit: "#verify" };
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: await hostPage(page), siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  return { step, inspection, places: inspection.screen.fields.map((field) => field.codeBox) };
};

test("seven boxes a script limits, with no maxlength, are each read with their place among seven", async ({
  page,
}) => {
  const places = [1, 2, 3, 4, 5, 6, 7];
  const { step, inspection, places: read } = await inspect(page, scriptBoxes(7), boxFields(places));
  expect(read).toEqual(places.map((box) => ({ box, of: 7 })));
  expect(codeBoxesRefusal(step, inspection)).toBeUndefined();
});

test("a step that names five of six boxes a script limits is sent back with how many the screen shows", async ({
  page,
}) => {
  const { step, inspection } = await inspect(page, scriptBoxes(6), boxFields([1, 2, 3, 4, 5]));
  expect(codeBoxesRefusal(step, inspection)).toMatchObject({
    outcome: "refused",
    reason: "code_boxes_incomplete",
    codeBoxes: { boxes: 6, named: [1, 2, 3, 4, 5] },
  });
});

test("one code field with no maxlength beside another text field is no box", async ({ page }) => {
  const { step, inspection, places } = await inspect(
    page,
    '<div><input id="name" aria-label="Name"><input id="code" autocomplete="one-time-code" aria-label="Code"></div>',
    [{ selector: "#code", slot: "code" }],
  );
  expect(places).toEqual([undefined]);
  expect(codeBoxesRefusal(step, inspection)).toBeUndefined();
});

test("two code fields with no maxlength, each alone in its own container, are no boxes", async ({ page }) => {
  const { places } = await inspect(
    page,
    '<div><input id="email-code" aria-label="Email code"></div><div><input id="text-code" aria-label="Text code"></div>',
    [
      { selector: "#email-code", slot: "code" },
      { selector: "#text-code", slot: "code" },
    ],
  );
  expect(places).toEqual([undefined, undefined]);
});

test("code fields with no maxlength beside a field of another type in their container are no boxes", async ({
  page,
}) => {
  const { places } = await inspect(
    page,
    '<div><input id="box-1" type="tel"><input id="box-2" type="tel"><input id="note" type="text" aria-label="Note"></div>',
    boxFields([1, 2]),
  );
  expect(places).toEqual([undefined, undefined]);
});

test("six boxes a script limits, split three and three between two containers, are no boxes, so a step that names all six is not sent back", async ({
  page,
}) => {
  const half = (first: number) =>
    `<div style="display:flex;gap:4px">${[first, first + 1, first + 2]
      .map((box) => `<input id="box-${box}" type="tel" inputmode="numeric" style="width:32px;height:40px">`)
      .join("")}</div>`;
  const { step, inspection, places } = await inspect(
    page,
    `<div style="display:flex;gap:8px">${half(1)}<span>-</span>${half(4)}</div>`,
    boxFields([1, 2, 3, 4, 5, 6]),
  );
  expect(places).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  expect(codeBoxesRefusal(step, inspection)).toBeUndefined();
});

/**
 * `count` `tel` boxes with no `maxlength`, each wrapped by `wrap`, the wrappers side by side in one
 * container after `first`, and the widget's script that keeps one digit in each box and moves to
 * the next.
 */
const wrappedBoxes = (count: number, wrap = (box: string) => `<span>${box}</span>`, first = "") =>
  `<div id="boxes" style="display:flex;gap:4px">${first}${Array.from({ length: count }, (_, at) =>
    wrap(
      `<input id="box-${at + 1}" type="tel" inputmode="numeric" autocomplete="one-time-code" aria-label="Code digit" style="width:32px;height:40px">`,
    ),
  ).join("")}</div>
<script>
const boxes = [...document.querySelectorAll('#boxes input[type="tel"]')];
boxes.forEach((box, at) => box.addEventListener("input", () => {
  box.value = box.value.replace(/[^0-9]/g, "").slice(-1);
  if (box.value !== "" && boxes[at + 1]) boxes[at + 1].focus();
}));
</script>`;

test("six boxes a script limits, each the only element of its own wrapper, are each read with their place among six", async ({
  page,
}) => {
  const places = [1, 2, 3, 4, 5, 6];
  const { step, inspection, places: read } = await inspect(page, wrappedBoxes(6), boxFields(places));
  expect(read).toEqual(places.map((box) => ({ box, of: 6 })));
  expect(codeBoxesRefusal(step, inspection)).toBeUndefined();
});

test("a step that names five of six boxes in their own wrappers is sent back with how many the screen shows", async ({
  page,
}) => {
  const { step, inspection } = await inspect(page, wrappedBoxes(6), boxFields([1, 2, 3, 4, 5]));
  expect(codeBoxesRefusal(step, inspection)).toMatchObject({
    outcome: "refused",
    reason: "code_boxes_incomplete",
    codeBoxes: { boxes: 6, named: [1, 2, 3, 4, 5] },
  });
});

test("six boxes a script limits, each wrapped two levels deep, are no boxes", async ({ page }) => {
  const { places } = await inspect(
    page,
    wrappedBoxes(6, (box) => `<span><span>${box}</span></span>`),
    boxFields([1, 2, 3, 4, 5, 6]),
  );
  expect(places).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
});

test("a box beside five boxes in their own wrappers is no box, nor are they, so a step that names all six is not sent back", async ({
  page,
}) => {
  const { step, inspection, places } = await inspect(
    page,
    wrappedBoxes(6, (box) => (box.includes('id="box-1"') ? box : `<span>${box}</span>`)),
    boxFields([1, 2, 3, 4, 5, 6]),
  );
  expect(places).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  expect(codeBoxesRefusal(step, inspection)).toBeUndefined();
});

test("six address fields, each in its own wrapper with its label, are no boxes even when a step names them as code fields", async ({
  page,
}) => {
  const labels = ["Street", "City", "Region", "Postal code", "Country", "Phone"];
  const { places } = await inspect(
    page,
    `<div>${labels
      .map((label, at) => `<div><label for="box-${at + 1}">${label}</label><input id="box-${at + 1}" type="text"></div>`)
      .join("")}</div>`,
    boxFields([1, 2, 3, 4, 5, 6]),
  );
  expect(places).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
});

test("one code field whose maxlength is 6, alone in its own wrapper, is no box", async ({ page }) => {
  const { step, inspection, places } = await inspect(
    page,
    '<div><span><input id="code" maxlength="6" inputmode="numeric" autocomplete="one-time-code" aria-label="Code"></span></div>',
    [{ selector: "#code", slot: "code" }],
  );
  expect(places).toEqual([undefined]);
  expect(codeBoxesRefusal(step, inspection)).toBeUndefined();
});

/** Wraps each box in a `span`, and box 3's wrapper in `third` instead. */
const wrapThird = (third: (box: string) => string) => (box: string) =>
  box.includes('id="box-3"') ? third(box) : `<span>${box}</span>`;

for (const [what, wrap, first] of [
  ["a hidden input in the container", undefined, '<input type="hidden" name="code">'],
  ["an error message not shown in the container", undefined, '<div role="alert" style="display:none">That code is wrong</div>'],
  ["a style element in the container", undefined, "<style>#boxes span{display:inline-block}</style>"],
  ["an element not shown inside one wrapper", wrapThird((box) => `<span>${box}<span hidden>Required</span></span>`), ""],
] as const)
  test(`six boxes in their own wrappers, beside ${what}, are each read with their place among six`, async ({
    page,
  }) => {
    const places = [1, 2, 3, 4, 5, 6];
    const { places: read } = await inspect(page, wrappedBoxes(6, wrap, first), boxFields(places));
    expect(read).toEqual(places.map((box) => ({ box, of: 6 })));
  });

for (const [what, wrap] of [
  ["a separator shown between two wrappers", wrapThird((box) => `<span>${box}</span><span>-</span>`)],
  ["a label shown inside one wrapper", wrapThird((box) => `<span><label for="box-3">Digit 3</label>${box}</span>`)],
] as const)
  test(`six boxes in their own wrappers, with ${what}, are no boxes`, async ({ page }) => {
    const { places } = await inspect(page, wrappedBoxes(6, wrap), boxFields([1, 2, 3, 4, 5, 6]));
    expect(places).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });
