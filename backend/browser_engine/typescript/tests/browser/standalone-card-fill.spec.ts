import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import {
  authorityOf,
  call,
  currentOf,
  execution,
  patch,
  probe,
  readOf,
  recordingGuardian,
  toolResult,
} from "./guardian-context-fixture.js";
import { executions, mint } from "./standalone-mint-fixture.js";

const host = "www.checkout.test";
/**
 * A checkout page on its own HTTPS site, since a card goes only into an https site's page, and a
 * browser that resolves its host; closed after `use`.
 */
const withCheckout = async (
  page: string,
  use: (site: { readonly url: string }, endpoint: string) => Promise<void>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "opengpt-card-fill-"));
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-subj",
    `/CN=${host}`,
    "-days",
    "1",
  ]);
  const server = createServer(
    {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    },
    (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(page);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing checkout port");
  const browser = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${host} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  try {
    await use({ url: `https://${host}:${address.port}/checkout` }, browser.wsEndpoint());
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
};

const cardQuestions = {
  intent: "Ask for the card the checkout requires",
  questions: [
    { id: "number", type: "secret", secretKind: "card_number", prompt: "Card number?" },
    { id: "cvc", type: "secret", secretKind: "card_cvc", prompt: "Security code?" },
  ],
};
const cardFill = execution("card_fill", "operation/card-fill-step.json", {
  cardFillStep: {
    fields: [
      { selector: "#number", handle: "{{secret.s1}}" },
      { selector: "#cvc", handle: "{{secret.s2}}" },
    ],
  },
});

// The local host's card-fill step: the minter asks for the card, names the checkout's fields and
// their handles, Guardian reviews handles only, and the host types the values. The page groups
// the number in fours as it is typed, as a card form does, and that form is masked too.
test("types the caller's card into the checkout's fields, with handles only in reviews and results", async () => {
  test.setTimeout(90_000);
  const number = "4242424242424242";
  const page = `<title>Checkout</title><h1>Checkout</h1>
<label for="number">Card number</label><input id="number" autocomplete="cc-number" inputmode="numeric" oninput="this.value=this.value.replace(/\\D/g,'').replace(/(\\d{4})(?=\\d)/g,'$1 ')">
<label for="cvc">Security code</label><input id="cvc" autocomplete="cc-csc">`;
  await withCheckout(page, async (site, endpoint) => {
    const guardian = recordingGuardian();
    const { requests, last } = await mint({
      effect: "write",
      url: site.url,
      browser: { endpoint },
      guardian,
      intent: "Book the table and secure it with the caller's card",
      answer: () => ({ number, cvc: "123" }),
      turns: [
        () => patch({ "explore/open.mjs": probe() }),
        () => [call("execute", execution("explore", "explore/open.mjs"), "open")],
        () => [call("request_input", cardQuestions, "ask")],
        () => [call("execute", cardFill, "card")],
        () =>
          patch({
            "explore/look.mjs": probe("return await page.locator('#number').inputValue();"),
          }),
        () => [call("execute", execution("explore", "explore/look.mjs"), "look")],
      ],
    });
    expect(toolResult(last, "card"), JSON.stringify(toolResult(last, "card"))).toMatchObject({
      status: "completed",
    });
    expect(JSON.stringify(toolResult(last, "card"))).toContain('\\"cardFill\\":\\"filled\\"');
    // Once the build has the caller's card, no live step reads a card field back.
    expect(toolResult(last, "look")).toMatchObject({ status: "unsupported" });
    expect(JSON.stringify(toolResult(last, "look"))).toContain(
      "explore/look.mjs line 5 reads a field's value: a card stays with the host",
    );
    const answered = JSON.stringify(toolResult(last, "ask"));
    expect(answered).toContain("{{secret.s1}}");
    expect(answered).toContain("run an execution with purpose card_fill");
    // Every secret answer is a card, so the rule for handles in source is left out.
    expect(answered).not.toContain("Write the handle exactly as given");
    const review = executions(guardian.reviews).find(
      (candidate) => currentOf(candidate)?.["purpose"] === "card_fill",
    );
    expect(review).toBeDefined();
    const step = readOf(review, "operation/card-fill-step.json") ?? "";
    expect(step).toContain("{{secret.s1}}");
    expect(step).toContain("card_number");
    expect(step).toContain("Card number");
    expect(authorityOf(review!)["paymentFrameOrigins"]).toContain("https://js.stripe.com");
    expect(String(authorityOf(review!)["allowedEffects"])).toContain(
      "Typing the caller's payment card into the card fields of the site's own checkout",
    );
    for (const shown of [number, "4242 4242 4242 4242"]) {
      expect(JSON.stringify(guardian.reviews)).not.toContain(shown);
      expect(JSON.stringify(requests)).not.toContain(shown);
    }
  });
});

test("refuses a card handle written into source, before any review", async () => {
  test.setTimeout(90_000);
  const page = `<title>Checkout</title><label for="number">Card number</label><input id="number">`;
  await withCheckout(page, async (site, endpoint) => {
    const guardian = recordingGuardian();
    const { last } = await mint({
      effect: "write",
      url: site.url,
      browser: { endpoint },
      guardian,
      intent: "Book the table and secure it with the caller's card",
      answer: () => ({ number: "4242424242424242", cvc: "123" }),
      turns: [
        () => patch({ "explore/open.mjs": probe() }),
        () => [call("execute", execution("explore", "explore/open.mjs"), "open")],
        () => [call("request_input", cardQuestions, "ask")],
        () =>
          patch({
            "explore/type.mjs": probe("await page.locator('#number').fill('{{secret.s1}}'); return 1;"),
          }),
        () => [call("execute", execution("explore", "explore/type.mjs"), "type")],
      ],
    });
    expect(toolResult(last, "type")).toMatchObject({ status: "unsupported" });
    expect(JSON.stringify(toolResult(last, "type"))).toContain(
      "{{secret.s1}} is a card answer, which never goes into source",
    );
    // Only the opening step was reviewed; the refused one never reached Guardian.
    expect(executions(guardian.reviews)).toHaveLength(1);
  });
});

// A script asks for the card at run time, as a published tool does, and types it with fillCard:
// it holds only handles, the host types the card, and code beside it that could read a card
// field back is refused before review.
test("a script asks for the card and has the host type it with fillCard", async () => {
  test.setTimeout(90_000);
  const number = "4242424242424242";
  const page = `<title>Checkout</title><h1>Checkout</h1>
<label for="number">Card number</label><input id="number" autocomplete="cc-number">
<label for="cvc">Security code</label><input id="cvc" autocomplete="cc-csc">`;
  const pay = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"pay",input:Schema.Unknown,output:Schema.Unknown,questions:{number:{type:"secret",secretKind:"card_number",prompt:"Card number?"},cvc:{type:"secret",secretKind:"card_cvc",prompt:"Security code?"}}},
async ({ask,fillCard}) => {
  const answer = await ask(["number","cvc"]);
  const filled = await fillCard({fields:[{selector:"#number",handle:answer.number},{selector:"#cvc",handle:answer.cvc}]});
  return {answer,filled};
});`;
  await withCheckout(page, async (site, endpoint) => {
    const guardian = recordingGuardian();
    const { requests, last } = await mint({
      effect: "write",
      url: site.url,
      browser: { endpoint },
      guardian,
      intent: "Book the table and secure it with the caller's card",
      answer: () => ({ number, cvc: "123" }),
      turns: [
        () => patch({ "explore/open.mjs": probe(), "explore/pay.mjs": pay }),
        () => [call("execute", execution("explore", "explore/open.mjs"), "open")],
        () => [call("execute", execution("explore", "explore/pay.mjs"), "pay")],
        () =>
          patch({
            "explore/look.mjs": probe("return await page.locator('#number').inputValue();"),
          }),
        () => [call("execute", execution("explore", "explore/look.mjs"), "look")],
      ],
    });
    const paid = JSON.stringify(toolResult(last, "pay"));
    expect(toolResult(last, "pay"), paid).toMatchObject({ status: "completed" });
    // The script got handles, and the host typed both fields.
    expect(paid).toContain("{{card.c1}}");
    expect(paid).toContain("{{card.c2}}");
    expect(paid).toContain('\\"slot\\":\\"card_number\\",\\"status\\":\\"filled\\"');
    // Source beside a fillCard never reads a card field back.
    expect(toolResult(last, "look")).toMatchObject({ status: "unsupported" });
    expect(JSON.stringify(toolResult(last, "look"))).toContain(
      "explore/look.mjs line 5 reads a field's value: a card stays with the host",
    );
    for (const shown of [number, "4242 4242 4242 4242"]) {
      expect(JSON.stringify(guardian.reviews)).not.toContain(shown);
      expect(JSON.stringify(requests)).not.toContain(shown);
    }
  });
});
