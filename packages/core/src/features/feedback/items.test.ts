import { describe, expect, it } from "vitest";
import { appsFor } from "./access";
import { buildIssue, hiddenBlock, neutralize } from "./issue";
import { buildItems, createBlocker, environmentFor, mergeNits, type PendingItem } from "./items";
import { CHANNEL, CXC, CXC_TEAM, DESIGN, VP, draft, item } from "./fixtures";
import type { ExtractedItem } from "./types";

const settings = (channels: string[] = []) => ({ feedbackApps: { cxc: { ...CXC, channels } } });

describe("appsFor", () => {
  it("needs a whole role set: VP alone is refused, VP and Design pass, cxc-team passes", () => {
    expect(appsFor([VP], undefined, settings())).toEqual([]);
    expect(appsFor([VP, DESIGN], undefined, settings()).map((a) => a.name)).toEqual(["cxc"]);
    expect(appsFor([CXC_TEAM], undefined, settings()).map((a) => a.name)).toEqual(["cxc"]);
    expect(appsFor([], undefined, settings())).toEqual([]);
  });

  it("keeps an app to its channels, counting a thread by its parent", () => {
    const limited = settings([CHANNEL]);
    expect(appsFor([CXC_TEAM], { id: CHANNEL }, limited)).toHaveLength(1);
    expect(appsFor([CXC_TEAM], { id: "999", parent_id: CHANNEL }, limited)).toHaveLength(1);
    expect(appsFor([CXC_TEAM], { id: "999", parent_id: "998" }, limited)).toEqual([]);
    expect(appsFor([CXC_TEAM], undefined, limited)).toEqual([]);
  });
});

describe("environmentFor", () => {
  it("reads Production from the production host, Staging from any other URL", () => {
    const prod = CXC.productionUrl;
    expect(environmentFor("https://cxc.uwdatascience.ca/apply", prod)).toBe("prod");
    expect(environmentFor("on www.cxc… https://www.cxc.uwdatascience.ca/", prod)).toBe("prod");
    expect(environmentFor("https://cxc-git-dev-uwdsc.vercel.app/apply", prod)).toBe("staging");
    expect(environmentFor("the apply page", prod)).toBeNull();
    expect(environmentFor(null, prod)).toBeNull();
  });
});

const extracted = (overrides: Partial<ExtractedItem> = {}): ExtractedItem => ({
  title: "Fix the apply button",
  type: "bug",
  page: null,
  verbatim: "apply does nothing",
  restatement: "Make apply work.",
  messages: [2],
  screenshots: [1],
  ...overrides,
});

describe("buildItems", () => {
  const ctx = {
    messageLinks: ["https://discord.com/channels/g/c/1", "https://discord.com/channels/g/c/2"],
    strictness: "strict" as const,
    productionUrl: CXC.productionUrl,
    environment: null,
    page: null,
  };

  it("drops questions, links messages and prefills the environment", () => {
    const items = buildItems(
      [
        extracted({ page: "https://cxc-preview.vercel.app/apply" }),
        extracted({ type: "question", title: "Is apply open?" }),
        extracted({ type: "change", page: null, messages: [] }),
      ],
      { ...ctx, page: "https://cxc.uwdatascience.ca/faq" }
    );
    expect(items.map((i) => [i.type, i.page, i.environment])).toEqual([
      ["bug", "https://cxc-preview.vercel.app/apply", "staging"],
      ["change", "https://cxc.uwdatascience.ca/faq", "prod"],
    ]);
    expect(items[0]).toMatchObject({
      sources: ["https://discord.com/channels/g/c/2"],
      screenshots: [1],
      dropped: false,
      issue: null,
    });
  });

  it("uses the modal's environment for every item, and keeps at most 10", () => {
    const many = Array.from({ length: 14 }, (_, i) => extracted({ title: `item ${i}` }));
    const items = buildItems(many, { ...ctx, environment: "staging" });
    expect(items).toHaveLength(10);
    expect(new Set(items.map((i) => i.environment))).toEqual(new Set(["staging"]));
  });

  it("merges nits on the same page only when relaxed", () => {
    const nits = [
      extracted({
        type: "nit",
        page: "https://cxc.uwdatascience.ca/apply/",
        restatement: "a",
        screenshots: [1],
      }),
      extracted({ type: "bug", page: "/apply" }),
      extracted({
        type: "nit",
        page: "https://cxc.uwdatascience.ca/apply?x=1",
        restatement: "b",
        screenshots: [2],
      }),
      extracted({ type: "nit", page: "/faq", restatement: "c" }),
    ];
    expect(buildItems(nits, ctx)).toHaveLength(4);
    const relaxed = buildItems(nits, { ...ctx, strictness: "relaxed" });
    expect(relaxed.map((i) => i.type)).toEqual(["nit", "bug", "nit"]);
    expect(relaxed[0]).toMatchObject({
      title: "Small fixes on https://cxc.uwdatascience.ca/apply/",
      restatement: "- a\n- b",
      screenshots: [1, 2],
    });
  });

  it("mergeNits leaves a mixed environment unset", () => {
    const nit = (environment: "prod" | "staging"): PendingItem => ({
      ...item({ type: "nit", page: "/apply", environment }),
      screenshots: [],
    });
    expect(mergeNits([nit("prod"), nit("staging")])[0]?.environment).toBeNull();
  });
});

describe("createBlocker", () => {
  it("blocks Create until every kept, unfiled item has an environment", () => {
    expect(createBlocker([item(), item({ environment: null })])).toMatch(/item 2 first/);
    expect(createBlocker([item(), item({ environment: null, dropped: true })])).toBeNull();
    expect(
      createBlocker([item({ environment: null, issue: { number: 1, url: "u" } }), item()])
    ).toBeNull();
    expect(createBlocker([item({ dropped: true })])).toMatch(/Every item is left out/);
  });
});

describe("issue", () => {
  const submitter = { id: "400000000000000001", name: "Sam @organizer" };

  it("quotes the feedback and carries the hidden block pointing at the card", () => {
    const issue = buildIssue(
      item({ screenshots: ["https://blob.example/1.png"], verbatim: "line one\nline two" }),
      draft(),
      CXC,
      submitter
    );
    expect(issue.title).toBe("Fix the apply button");
    expect(issue.labels).toEqual(["feedback", "feedback:bug", "env:prod"]);
    expect(issue.body).toContain("> line one\n> line two");
    expect(issue.body).toContain("**Environment:** Production (cxc.uwdatascience.ca)");
    expect(issue.body).toContain("![screenshot 1](https://blob.example/1.png)");
    expect(issue.body).toContain(
      "[feedback card](https://discord.com/channels/100000000000000001/300000000000000002/600000000000000001)"
    );
    expect(issue.body.trimEnd().endsWith(hiddenBlock(draft(), submitter.id))).toBe(true);
    expect(hiddenBlock(draft(), submitter.id)).toBe(
      '<!-- nexus-feedback {"guild":"100000000000000001","channel":"300000000000000002","message":"600000000000000001","user":"400000000000000001"} -->'
    );
  });

  it("can't ping GitHub users or forge the hidden block", () => {
    expect(neutralize("cc @aaryan and @uw-datasci/devs, email a@b.c")).toBe(
      "cc @​aaryan and @​uw-datasci/devs, email a@​b.c"
    );
    const body = buildIssue(
      item({ verbatim: '<!-- nexus-feedback {"user":"1"} -->' }),
      draft(),
      CXC,
      submitter
    ).body;
    expect(body.match(/<!-- nexus-feedback/g)).toHaveLength(1);
    expect(body).toContain("Submitted by **Sam @​organizer**");
  });

  it("labels Staging items, and says so in the body", () => {
    const issue = buildIssue(
      item({ environment: "staging", type: "nit" }),
      draft(),
      CXC,
      submitter
    );
    expect(issue.labels).toEqual(["feedback", "feedback:nit", "env:staging"]);
    expect(issue.body).toContain("Staging (on `dev`, not in production yet)");
  });
});
