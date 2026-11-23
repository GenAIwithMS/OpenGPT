import { expect, test } from "@playwright/test";
import {
  serve,
  signIn,
  dateStep,
  dateScenarios,
  customDateScreen,
  customDateFields,
} from "./autofill-date-fixture.js";

for (const [name, screen, fields, sent, controls] of dateScenarios)
  test(`the host fills a date of birth into ${name} and inspects its shape`, async ({ page }) => {
    const received = await serve(page, screen);
    const { report, inspection, refused } = await signIn(page, dateStep(fields));
    expect(refused).toBeUndefined();
    expect(report).toMatchObject({
      outcome: "filled",
      fields: fields.map(() => ({ slot: "date_of_birth", status: "filled" })),
      submit: "clicked",
    });
    expect(received.map((form) => Object.fromEntries(form))).toEqual([sent]);
    expect(inspection?.targets.fields.map((field) => field.control)).toEqual(controls);
  });

test("the host chooses a date of birth in custom dropdowns", async ({ page }) => {
  const received = await serve(page, customDateScreen);
  const fields = customDateFields;
  const { report, inspection, refused } = await signIn(page, dateStep(fields));
  expect(refused).toBeUndefined();
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(received.map((form) => Object.fromEntries(form))).toEqual([
    { month: "11", day: "9", year: "1984" },
  ]);
  expect(inspection?.targets.fields.map((field) => field.control)).toEqual([
    "combobox",
    "combobox",
    "text",
  ]);
});

test("a select is no place for an identifier or a password", async ({ page }) => {
  // Only a date of birth takes a choice; any other field still needs a box that takes typing.
  await serve(
    page,
    `<select name="user" aria-label="Username"><option>synthetic</option></select>`,
  );
  const { refused } = await signIn(page, {
    fields: [{ selector: "select[name=user]", slot: "username", accepts: ["username"] }],
    submit: 'button:text-is("Continue")',
  });
  expect(refused).toMatchObject({ outcome: "refused", reason: "not_editable", target: 0 });
});
