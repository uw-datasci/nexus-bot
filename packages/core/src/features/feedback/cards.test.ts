import { ComponentType } from "@nexus-bot/discord";
import { describe, expect, it } from "vitest";
import {
  buildCreatedCard,
  buildIntakeModal,
  buildItemModal,
  buildPreviewCard,
  parseDraftRef,
} from "./cards";
import { CXC, draft, item } from "./fixtures";

type Row = {
  components: { type: number; custom_id?: string; disabled?: boolean; label?: string }[];
};
const rows = (payload: { components?: unknown }) => payload.components as Row[];
const button = (payload: { components?: unknown }, action: string) =>
  rows(payload)
    .flatMap((r) => r.components)
    .find((c) => c.custom_id?.startsWith(`fb:${action}:`));

const embedChars = (
  embeds: { title?: string; description?: string; footer?: { text: string } }[]
) =>
  embeds.reduce(
    (n, e) =>
      n + (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0),
    0
  );

describe("preview card", () => {
  it("blocks Create until every item has an environment", () => {
    const card = buildPreviewCard(draft({ items: [item(), item({ environment: null })] }), CXC);
    expect(card.content).not.toContain("public");
    expect(card.content).toContain(
      "From this thread (1 message: [1](https://discord.com/channels/1/2/3))"
    );
    expect(button(card, "create")).toMatchObject({ disabled: true, label: "Create 2 issues" });
    expect(card.embeds?.[1]?.description).toContain("⚠️ pick an environment");

    const ready = buildPreviewCard(draft({ items: [item(), item({ dropped: true })] }), CXC);
    expect(button(ready, "create")).toMatchObject({ disabled: false, label: "Create issue" });
    expect(ready.embeds?.[1]?.title).toMatch(/^~~2\./);
  });

  it("fits 10 long items in Discord's 6000-character embed limit, within 5 rows", () => {
    const long = "word ".repeat(600);
    const items = Array.from({ length: 10 }, (_, i) =>
      item({
        title: `${i} ${long}`.slice(0, 120),
        verbatim: long,
        restatement: long,
        page: long.slice(0, 200),
      })
    );
    const card = buildPreviewCard(draft({ items }), CXC);
    expect(card.embeds).toHaveLength(10);
    expect(embedChars(card.embeds as never)).toBeLessThanOrEqual(6000);
    expect(card.content!.length).toBeLessThanOrEqual(2000);
    expect(rows(card)).toHaveLength(5); // leave out, environment, 2 × edit, create/cancel
    expect(rows(card)[2]!.components.map((c) => c.label)).toEqual([
      "Edit 1",
      "Edit 2",
      "Edit 3",
      "Edit 4",
      "Edit 5",
    ]);
  });

  it("keeps filed items out of the controls after a partial Create", () => {
    const card = buildPreviewCard(
      draft({ items: [item({ issue: { number: 12, url: "https://github.com/x/12" } }), item()] }),
      CXC
    );
    expect(card.content).toContain("Already filed: [#12](https://github.com/x/12)");
    expect(button(card, "edit")?.label).toBe("Edit 2");
    expect(card.embeds?.[0]?.description).toContain("✅ #12");
  });

  it("becomes 'Created #12, #13' with no controls", () => {
    const card = buildCreatedCard(
      draft({
        items: [
          item({ issue: { number: 12, url: "https://github.com/x/12" } }),
          item({ issue: { number: 13, url: "https://github.com/x/13" } }),
          item({ dropped: true }),
        ],
      }),
      CXC
    );
    expect(card.content).toMatch(/^✅ Created \[#12\]\(https:\/\/github.com\/x\/12\), \[#13\]/);
    expect(card.embeds).toHaveLength(2);
    expect(card.components).toEqual([]);
  });
});

describe("modals", () => {
  it("/feedback's modal has the four optional fields, and App only for 2+ apps", () => {
    const one = buildIntakeModal([CXC]) as {
      data: {
        components: { component: { type: number; custom_id: string; required?: boolean } }[];
      };
    };
    expect(one.data.components.map((c) => c.component.custom_id)).toEqual([
      "text",
      "page",
      "environment",
      "screenshots",
    ]);
    expect(one.data.components.every((c) => c.component.required === false)).toBe(true);
    expect(one.data.components[3]!.component).toMatchObject({
      type: ComponentType.FileUpload,
      max_values: 10,
    });
    const two = buildIntakeModal([CXC, { ...CXC, name: "other" }]) as typeof one;
    expect(two.data.components.at(-1)!.component.custom_id).toBe("app");
  });

  it("the item modal is prefilled and has 5 fields", () => {
    const modal = buildItemModal(draft().id, 0, item({ page: null })) as {
      data: {
        custom_id: string;
        components: { component: { custom_id: string; value?: string } }[];
      };
    };
    expect(modal.data.custom_id).toBe(`fb:item:${draft().id}:0`);
    expect(modal.data.components).toHaveLength(5);
    expect(modal.data.components[0]!.component.value).toBe("Fix the apply button");
    expect(modal.data.components[2]!.component).not.toHaveProperty("value");
  });

  it("parses draft references", () => {
    expect(parseDraftRef(`${draft().id}:3`)).toEqual({ draftId: draft().id, item: 3 });
    expect(parseDraftRef(draft().id)).toEqual({ draftId: draft().id, item: null });
    expect(parseDraftRef("nope")).toBeNull();
    expect(parseDraftRef(`${draft().id}:-1`)).toBeNull();
  });
});
