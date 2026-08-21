import { describe, expect, it } from "vitest";
import {
  classifyBuyingRole,
  classifySeniority,
  findContacts,
} from "./contact-finder";

const TEAM_HTML = `<!doctype html>
<html>
<body>
  <script type="application/ld+json">
    [
      {"@type":"Person","name":"Jane Doe","jobTitle":"Chief Executive Officer",
       "sameAs":["https://www.linkedin.com/in/jane-doe"]},
      {"@type":"Person","name":"Ravi Patel","jobTitle":"VP Engineering"}
    ]
  </script>
  <div class="member">
    <a href="https://www.linkedin.com/in/maria-garcia">Maria Garcia</a>
    <span>Director of Product</span>
  </div>
</body>
</html>`;

describe("findContacts", () => {
  const contacts = findContacts(TEAM_HTML);

  it("extracts JSON-LD people with roles and links", () => {
    const jane = contacts.find((c) => c.name === "Jane Doe");
    expect(jane).toBeDefined();
    expect(jane?.title).toBe("Chief Executive Officer");
    expect(jane?.seniority).toBe("C-Suite");
    expect(jane?.buyingRole).toBe("Economic Buyer");
    expect(jane?.linkedin).toContain("linkedin.com/in/jane-doe");
  });

  it("extracts HTML card people with a nearby title", () => {
    const maria = contacts.find((c) => c.name === "Maria Garcia");
    expect(maria).toBeDefined();
    expect(maria?.title).toBe("Director");
    expect(maria?.seniority).toBe("Director");
  });

  it("deduplicates by normalized name", () => {
    const names = contacts.map((c) => c.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("returns an empty list for pages with no people", () => {
    expect(findContacts("<html><body><p>No team here</p></body></html>")).toEqual([]);
  });
});

describe("classifiers", () => {
  it("maps titles to seniority bands", () => {
    expect(classifySeniority("CEO")).toBe("C-Suite");
    expect(classifySeniority("VP of Sales")).toBe("VP");
    expect(classifySeniority("Director of Product")).toBe("Director");
    expect(classifySeniority("Engineering Manager")).toBe("Manager");
    expect(classifySeniority("Designer")).toBe("IC");
    expect(classifySeniority(null)).toBe("IC");
  });

  it("predicts buying roles", () => {
    expect(classifyBuyingRole("Chief Financial Officer")).toBe("Economic Buyer");
    expect(classifyBuyingRole("CTO")).toBe("Technical Evaluator");
    expect(classifyBuyingRole("VP Sales")).toBe("Champion");
    expect(classifyBuyingRole("Account Executive")).toBe("End User");
    expect(classifyBuyingRole(null)).toBe("Unknown");
  });
});
