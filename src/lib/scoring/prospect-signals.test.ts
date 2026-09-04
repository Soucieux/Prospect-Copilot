import { describe, expect, it } from "vitest";
import { buildProspectSignals } from "@/lib/scoring/prospect-signals";
import type { ContactCandidate } from "@/lib/extract/contact-finder";

const SOURCE = {
  techStack: ["Stripe", "Segment"],
  hasPricingPage: true,
  enterpriseTierListed: false,
  jsonLdOrg: { numberOfEmployees: "51-200" },
};

const CONTACTS: ContactCandidate[] = [
  {
    name: "Jane Doe",
    title: "CEO",
    seniority: "C-Suite",
    buyingRole: "Economic Buyer",
    linkedin: null,
    source: "html",
  },
  {
    name: "Ravi Patel",
    title: null,
    seniority: "IC",
    buyingRole: "Unknown",
    linkedin: null,
    source: "html",
  },
];

describe("buildProspectSignals", () => {
  it("derives page-backed signals from the extraction and contacts", () => {
    const signals = buildProspectSignals(SOURCE, CONTACTS);
    expect(signals.employeeCount).toBe(51);
    expect(signals.hasPricingPage).toBe(true);
    expect(signals.enterpriseTierListed).toBe(false);
    expect(signals.decisionMakersFound).toBe(2);
    expect(signals.cSuiteIdentified).toBe(true);
    expect(signals.techStackCount).toBe(2);
    expect(signals.orgChartMapped).toBe(true);
  });

  it("reports no org chart when no contact carries a title", () => {
    const untitled = CONTACTS.map((contact) => ({ ...contact, title: null }));
    const signals = buildProspectSignals(SOURCE, untitled);
    expect(signals.orgChartMapped).toBe(false);
    expect(signals.cSuiteIdentified).toBe(true);
  });

  it("folds in evidenced subagent signals without inventing absent ones", () => {
    const signals = buildProspectSignals(SOURCE, CONTACTS, {
      painPointsDetected: 3,
      activeJobPostings: 12,
    });
    expect(signals.painPointsDetected).toBe(3);
    expect(signals.activeJobPostings).toBe(12);
    expect(signals.recentFundingWithin12Months).toBeUndefined();
    expect(signals.fundingTotalUsd).toBeUndefined();
  });

  it("omits an employee count when the page states none", () => {
    const signals = buildProspectSignals(
      { ...SOURCE, jsonLdOrg: null },
      CONTACTS,
    );
    expect(signals.employeeCount).toBeUndefined();
  });
});
