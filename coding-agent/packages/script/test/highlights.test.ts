import { describe, expect, test } from "bun:test"
import { parse } from "../src/highlights"

describe("highlights", () => {
  test("joins wrapped lines and drops multiple trailing links", () => {
    const result = parse(
      [
        "### Highlights",
        "",
        "- **Reopen Closed Tabs:** Right-click the new-session button to bring back a session you closed by",
        "  mistake. ([#123](https://github.com/anomalyco/opencode/pull/123), [#124](https://github.com/anomalyco/opencode/pull/124))",
        "* **Faster [Search](https://example.com)**: Results now stream in.",
        "",
        "### Core",
        "",
        "- **Not a Highlight**: Ignored.",
      ].join("\n"),
    )

    expect(result).toEqual({
      items: [
        {
          title: "Reopen Closed Tabs",
          body: "Right-click the new-session button to bring back a session you closed by mistake.",
        },
        { title: "Faster Search", body: "Results now stream in." },
      ],
      problems: [],
    })
  })

  test("returns nothing without a Highlights section", () => {
    expect(parse("### Core\n\n- Fixed a bug.")).toEqual({ items: [], problems: [] })
  })

  test("reports malformed highlights instead of failing", () => {
    const result = parse("### Highlights\n\n- Plain bullet without a title.\n")
    expect(result.items).toEqual([])
    expect(result.problems).toHaveLength(2)
  })

  test("limits the number and length of highlights", () => {
    const result = parse(
      [
        "### Highlights",
        ...Array.from({ length: 7 }, (_, index) => `- **Item ${index}**: ${"word ".repeat(100)}`),
      ].join("\n"),
    )

    expect(result.items).toHaveLength(5)
    expect(result.items[0].body.length).toBeLessThanOrEqual(300)
    expect(result.items[0].body.endsWith("…")).toBe(true)
    expect(result.problems).toEqual(["Kept the first 5 of 7 highlights"])
  })
})
