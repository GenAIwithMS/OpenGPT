import { describe, expect, it } from "vitest";
import { formDecoded, observedForms, shownForms } from "../../src/privacy/value-forms.js";

describe("observed forms of a value", () => {
  const value = 'p a+ss"w\\rd';

  it("lists the value, its percent, form and base64 encodings and JSON escape", () => {
    expect(observedForms(value)).toEqual([
      value,
      encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice(2),
      Buffer.from(value).toString("base64"),
      JSON.stringify(value).slice(1, -1),
    ]);
  });

  it("lists each form once", () => {
    expect(observedForms("plain1234")).toEqual([
      "plain1234",
      Buffer.from("plain1234").toString("base64"),
    ]);
  });

  it("throws for a value a URL cannot encode", () => {
    expect(() => observedForms("pass\ud800word")).toThrow(URIError);
  });
});

describe("shown forms of a value", () => {
  const forms = (value: string) => shownForms(value).map(([form]) => form);

  it.each([
    ["as Chromium writes it into a URL's query", "p%20a+ss%22w\\rd"],
    ["as Chromium writes it into a URL's path", "p%20a+ss%22w/rd"],
    ["percent-encoded in lowercase hex", "p%20a%2bss%22w%5crd"],
    ["base64-encoded", Buffer.from('p a+ss"w\\rd').toString("base64")],
  ])("adds the value %s", (_, shown) => {
    expect(forms('p a+ss"w\\rd')).toContain(shown);
  });

  it("adds a snapshot's quoted value and key, and its collapsed whitespace", () => {
    expect(forms("o'brien \"x\"")).toEqual(
      expect.arrayContaining(['o\'brien \\"x\\"', "o''brien \"x\""]),
    );
    expect(forms("  two   words ")).toContain("two words");
  });

  it("escapes a control character as a snapshot's quoted value writes it", () => {
    expect(forms("bell\u0007pass")).toContain("bell\\x07pass");
  });

  it("writes a value outside ASCII into a URL as UTF-8 escapes", () => {
    expect(forms("ñandú 😀\\x")).toEqual(
      expect.arrayContaining([
        "%C3%B1and%C3%BA%20%F0%9F%98%80\\x",
        "%C3%B1and%C3%BA%20%F0%9F%98%80/x",
        "%c3%b1and%c3%ba%20%f0%9f%98%80/x",
      ]),
    );
  });

  it("counts a short value's base64 form as short, as its other forms", () => {
    expect(shownForms("red")).toContainEqual([Buffer.from("red").toString("base64"), true]);
    expect(shownForms("correct horse")).toContainEqual([
      Buffer.from("correct horse").toString("base64"),
      false,
    ]);
  });

  it("counts a padded short value's trimmed forms as short, by the shown value they came from", () => {
    const padded = shownForms("   ab   ");
    expect(padded).toContainEqual(["   ab   ", false]);
    expect(padded).toContainEqual(["%20%20%20ab%20%20%20", false]);
    expect(padded).toContainEqual(["ab", true]);
    expect(padded).toContainEqual([Buffer.from("   ab   ").toString("base64"), false]);
  });

  it("keeps every other form of a value a URL cannot encode", () => {
    expect(forms("pass\ud800word")).toContain("pass\ud800word");
  });
});

describe("formDecoded", () => {
  it("decodes + and each valid run of escapes, leaving an invalid run as written", () => {
    expect(formDecoded("pw=%70%40ss+word&bad=%E0")).toBe("pw=p@ss word&bad=%E0");
  });

  it("is undefined when there is nothing to decode", () => {
    expect(formDecoded("plain text")).toBeUndefined();
    expect(formDecoded("50%")).toBeUndefined();
  });
});
