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
    expect(maria?.title).toBe("Director of Product");
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

describe("findContacts on real-world team page shapes", () => {
  it("finds a person whose card has no LinkedIn link", () => {
    const contacts = findContacts(`<div class="teammate">
      <h3>Joel Gascoigne</h3>
      <p>CEO &amp; Co-Founder</p>
    </div>`);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.name).toBe("Joel Gascoigne");
    expect(contacts[0]?.title).toBe("CEO & Co-Founder");
    expect(contacts[0]?.seniority).toBe("C-Suite");
    expect(contacts[0]?.buyingRole).toBe("Economic Buyer");
    expect(contacts[0]?.linkedin).toBeNull();
  });

  it("does not weld a name onto an adjacent title inside one anchor", () => {
    const contacts = findContacts(
      `<a href="https://www.linkedin.com/in/cristinacordova"><span>Cristina Cordova</span><span>COO</span></a>`,
    );
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.name).toBe("Cristina Cordova");
    expect(contacts[0]?.title).toBe("COO");
  });

  it("never borrows a title from a different person in a flat container", () => {
    const contacts = findContacts(`<div class="people">
      <a href="https://www.linkedin.com/in/amy-liu">Amy Liu</a>
      <span>Head of Design</span>
      <a href="https://www.linkedin.com/in/ben-ortiz">Ben Ortiz</a>
      <span>Founder</span>
    </div>`);
    expect(contacts.find((c) => c.name === "Amy Liu")?.title).toBe("Head of Design");
    expect(contacts.find((c) => c.name === "Ben Ortiz")?.title).toBe("Founder");
  });

  it("keeps the whole title so buying role stays correct", () => {
    const contacts = findContacts(
      `<div><a href="https://www.linkedin.com/in/dana">Dana Whitfield</a><span>VP of Sales</span></div>`,
    );
    expect(contacts[0]?.title).toBe("VP of Sales");
    expect(contacts[0]?.buyingRole).toBe("Champion");
  });

  it("reads a name and title written inline in one line of prose", () => {
    const contacts = findContacts(`<p>Joel Gascoigne, Chief Executive Officer</p>`);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.name).toBe("Joel Gascoigne");
    expect(contacts[0]?.title).toBe("Chief Executive Officer");
  });

  it("does not mistake capitalized navigation labels for people", () => {
    const contacts = findContacts(`<nav>
      <a href="/privacy">Privacy Policy</a>
      <a href="/contact">Contact Us</a>
      <a href="/about">Our Team</a>
    </nav>`);
    expect(contacts).toEqual([]);
  });
});

describe("findContacts filtering people from other companies", () => {
  const ABOUT_HTML = `<div>
    <div><h3>Tom Moor</h3><p>Head of Engineering</p></div>
    <div><h3>Carolyn Kopprasch</h3><p>Chief of Staff</p></div>
    <div><h3>Dylan Field</h3><p>CEO, Figma</p></div>
    <div><h3>Nat Friedman</h3><p>Former CEO of GitHub</p></div>
  </div>`;

  it("drops investors and advisors who work at another company", () => {
    const names = findContacts(ABOUT_HTML, "Linear").map((c) => c.name);
    expect(names).toContain("Tom Moor");
    expect(names).not.toContain("Dylan Field");
    expect(names).not.toContain("Nat Friedman");
  });

  it("keeps a title whose 'of' names a scope rather than an employer", () => {
    const names = findContacts(ABOUT_HTML, "Linear").map((c) => c.name);
    expect(names).toContain("Carolyn Kopprasch");
  });

  it("keeps someone whose title names the prospect's own company", () => {
    const contacts = findContacts(
      `<div><h3>Joel Gascoigne</h3><p>CEO of Buffer</p></div>`,
      "Buffer, Inc.",
    );
    expect(contacts.map((c) => c.name)).toEqual(["Joel Gascoigne"]);
  });

  it("filters on the title alone when the company name is unknown", () => {
    const names = findContacts(ABOUT_HTML).map((c) => c.name);
    expect(names).toEqual(["Tom Moor", "Carolyn Kopprasch"]);
  });

  it("treats a bare CPO as C-suite rather than an employer name", () => {
    const contacts = findContacts(`<div><h3>Jori Lallo</h3><p>Co-founder, CPO</p></div>`);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.seniority).toBe("C-Suite");
  });
});

describe("findContacts LinkedIn URL normalization", () => {
  it("keeps a protocol-relative profile href well-formed", () => {
    const html = `<html><body><div>
      <a href="//www.linkedin.com/in/jane-doe"><h3>Jane Doe</h3></a>
      <p>Chief Executive Officer</p>
    </div></body></html>`;
    const jane = findContacts(html).find(
      (person) => person.name === "Jane Doe",
    );
    expect(jane?.linkedin).toBe("https://www.linkedin.com/in/jane-doe");
  });
});
