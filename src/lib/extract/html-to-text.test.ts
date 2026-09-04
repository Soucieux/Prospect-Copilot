import { describe, expect, it } from "vitest";
import { htmlToText } from "@/lib/extract/html-to-text";

describe("htmlToText", () => {
  it("drops markup that is not page copy", () => {
    const text = htmlToText(
      `<html><body><script>var a=1;</script><style>p{}</style>
       <nav>Home</nav><footer>Legal</footer><p>Real copy.</p></body></html>`,
    );
    expect(text).toBe("Real copy.");
  });

  it("collapses whitespace into single spaces", () => {
    expect(htmlToText("<p>one\n\n   two\t\tthree</p>")).toBe("one two three");
  });

  it("truncates so one page cannot exhaust the prompt budget", () => {
    const long = `<p>${"word ".repeat(5_000)}</p>`;
    expect(htmlToText(long)).toHaveLength(12_000);
  });

  it("returns an empty string for a page with no body copy", () => {
    expect(htmlToText("<html><body></body></html>")).toBe("");
  });
});
