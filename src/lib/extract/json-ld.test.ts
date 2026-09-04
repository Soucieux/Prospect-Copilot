import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { jsonLdNodes } from "@/lib/extract/json-ld";

/**
 * Load a fragment the way the extractors do.
 * @param body inner HTML for the page body
 * @returns the loaded document
 */
function doc(body: string): cheerio.CheerioAPI {
  return cheerio.load(`<html><body>${body}</body></html>`);
}

describe("jsonLdNodes", () => {
  it("returns a single node", () => {
    const nodes = jsonLdNodes(
      doc('<script type="application/ld+json">{"@type":"Person"}</script>'),
    );
    expect(nodes).toEqual([{ "@type": "Person" }]);
  });

  it("flattens an array of nodes", () => {
    const nodes = jsonLdNodes(
      doc(
        '<script type="application/ld+json">[{"@type":"Person"},{"@type":"Organization"}]</script>',
      ),
    );
    expect(nodes).toHaveLength(2);
  });

  it("reads every script on the page in order", () => {
    const nodes = jsonLdNodes(
      doc(
        '<script type="application/ld+json">{"n":1}</script>' +
          '<script type="application/ld+json">{"n":2}</script>',
      ),
    );
    expect(nodes).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("skips a malformed block without losing the valid ones", () => {
    const nodes = jsonLdNodes(
      doc(
        '<script type="application/ld+json">{ not json </script>' +
          '<script type="application/ld+json">{"n":2}</script>',
      ),
    );
    expect(nodes).toEqual([{ n: 2 }]);
  });

  it("returns nothing when the page carries no structured data", () => {
    expect(jsonLdNodes(doc("<p>plain</p>"))).toEqual([]);
  });
});
