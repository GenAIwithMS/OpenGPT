import { expect, it } from "vitest";
import { fileReadback } from "../../src/mint/file-readback.js";

const scan = (source: string, handlesFiles: boolean) =>
  fileReadback(new Map([["src/tool.mjs", source]]), handlesFiles)?.does;

it("lets a build without files use the page's own files, downloads and drag data", () => {
  for (const source of [
    "await page.waitForEvent('download');",
    'page.on("download", (download) => seen.push(download.suggestedFilename()));',
    "await page.evaluate(() => new DataTransfer());",
    "await page.route('**/*.png', (route) => route.abort());",
    "const names = node.files[0];",
  ])
    expect(scan(source, false), source).toBeUndefined();
});

it("refuses in a file build an input's files, but not a list a JSON value calls files", () => {
  for (const source of [
    "return node.files[0].text();",
    "return node.files?.[0];",
    "return node.files.item(0);",
    "return Array.from(node.files);",
    "return [...node.files];",
    "for (const file of node.files) read(file);",
  ])
    expect(scan(source, true), source).toBe("reads an input's files");
  for (const source of [
    "return data.files.map((file) => file.name);",
    "return data.files?.filter(Boolean).length;",
    "if (node.files.length !== 1) throw new Error();",
  ])
    expect(scan(source, true), source).toBeUndefined();
});

it("refuses in a file build any routing of the page's requests", () => {
  for (const source of [
    "await page.route('**/upload', (route) => route.continue({ url: elsewhere }));",
    "await context.route(/upload/, (route) => route.fetch({ url: elsewhere }));",
    "await page.routeFromHAR('recorded.har');",
  ])
    expect(scan(source, true), source).toBe(
      "routes the page's requests, which can send its upload elsewhere",
    );
});

it("lets a build without files set an input from base64 input, deprecated, and refuses it with files", () => {
  const source =
    'await page.getByLabel("Receipt").setInputFiles({ name: "receipt.txt", mimeType: "text/plain", buffer: Buffer.from(input.content_base64, "base64") });';
  expect(scan(source, false)).toBeUndefined();
  expect(scan(source, true)).toBe("sets a file input itself (use files.place)");
  expect(scan(`${source}\nconst unused = FileInput;`, false)).toBe(
    "sets a file input itself (use files.place)",
  );
});
