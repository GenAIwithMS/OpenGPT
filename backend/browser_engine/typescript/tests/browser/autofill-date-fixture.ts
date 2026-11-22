import type { Page } from "playwright";
import { Effect } from "effect";
import type { DateOfBirthFormat } from "../../src/destinations/autofill-contracts.js";
import { inspectAutofillStep } from "../../src/destinations/autofill-step.js";
import type { AutofillInspection, AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

export const site = "https://bank.example.test";
const dateOfBirth = "1984-11-09";

/** Serves the screen and keeps each sign-in form the site receives. */
export const serve = async (page: Page, screen: string) => {
  const received: URLSearchParams[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      received.push(new URLSearchParams(request.postData() ?? ""));
      await route.fulfill({ contentType: "text/html", body: "<p>Signed in</p>" });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: `<form action="/session" method="post">${screen}<button>Continue</button></form>`,
      });
  });
  await page.goto(`${site}/verify`);
  return received;
};

export const dateStep = (
  fields: readonly (readonly [string, DateOfBirthFormat])[],
): AutofillStep => ({
  fields: fields.map(([selector, format]) => ({ selector, slot: "date_of_birth", format })),
  submit: 'button:text-is("Continue")',
});

/** Inspects and fills the step as the host does. */
export const signIn = async (
  page: Page,
  step: AutofillStep,
  onInspection?: (inspection: AutofillInspection, values: readonly string[]) => void,
) => {
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) return { refused: inspection };
  const values = step.fields.map(() => dateOfBirth);
  onInspection?.(inspection, values);
  const { keyboard } = await hostKeyboard(page);
  const report = await Effect.runPromise(
    fillAutofillStep({ step, values, inspection, page: host, keyboard, settleMs: 2_000 }),
  );
  return { report, inspection };
};

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const dateScenarios = [
  [
    "a text box in MM/DD/YYYY",
    `<label>Date of birth<input name="dob" autocomplete="bday" placeholder="MM/DD/YYYY"></label>`,
    [["input[name=dob]", "MM/DD/YYYY"]],
    { dob: "11/09/1984" },
    ["text"],
  ],
  [
    "a native date input",
    `<label>Date of birth<input name="dob" type="date"></label>`,
    [["input[name=dob]", "YYYY-MM-DD"]],
    { dob: "1984-11-09" },
    ["date"],
  ],
  [
    "month, day and year selects",
    `<select name="m" aria-label="Month"><option value="">Month</option>${months.map((month, index) => `<option value="${index + 1}">${month}</option>`).join("")}</select>
<select name="d" aria-label="Day"><option value="">Day</option>${Array.from({ length: 31 }, (_, index) => `<option>${String(index + 1).padStart(2, "0")}</option>`).join("")}</select>
<input name="y" aria-label="Year" maxlength="4">`,
    [
      ["select[name=m]", "MMM"],
      ["select[name=d]", "DD"],
      ["input[name=y]", "YYYY"],
    ],
    { m: "11", d: "09", y: "1984" },
    ["select", "select", "text"],
  ],
] as const;

const dropdown = (name: string, options: readonly string[]) =>
  `<button type="button" aria-label="${name}" aria-haspopup="listbox" aria-expanded="false" aria-controls="${name}-list" onclick="this.setAttribute('aria-expanded','true');document.getElementById('${name}-list').hidden=false">${name}</button>
<input type="hidden" name="${name}">
<ul role="listbox" id="${name}-list" hidden onclick="const option=event.target.closest('[role=option]');if(!option)return;this.hidden=true;const button=this.previousElementSibling.previousElementSibling;button.textContent=option.textContent;button.setAttribute('aria-expanded','false');this.previousElementSibling.value=option.dataset.value">${options.map((label, index) => `<li role="option" data-value="${index + 1}">${label}</li>`).join("")}</ul>`;
export const customDateScreen =
  dropdown("month", months) +
  dropdown(
    "day",
    Array.from({ length: 31 }, (_, index) => String(index + 1)),
  ) +
  `<input name="year" aria-label="Year">`;
export const customDateFields = [
  ["[aria-label=month]", "MM"],
  ["[aria-label=day]", "D"],
  ["[aria-label=Year]", "YYYY"],
] as const;
