import type { Strictness } from "../../github-app";
import type { Environment, ExtractedItem, FeedbackItem } from "./types";

/** Discord allows 10 embeds per message, and the card has one per item. */
export const MAX_ITEMS = 10;

/** An item before its screenshots are copied: image numbers instead of Blob URLs. */
export type PendingItem = Omit<FeedbackItem, "screenshots"> & { screenshots: number[] };

const URL_IN_TEXT = /https?:\/\/[^\s<>()]+/i;

/**
 * The environment a page points at: a URL on the production host is Production, any other URL
 * (a Vercel preview, the dev branch's deployment) is Staging, and plain text says nothing.
 */
export function environmentFor(page: string | null, productionUrl: string): Environment | null {
  const match = page?.match(URL_IN_TEXT)?.[0];
  if (!match) return null;
  try {
    const host = new URL(match).hostname.toLowerCase();
    const production = new URL(productionUrl).hostname.toLowerCase();
    return host === production || host === `www.${production}` ? "prod" : "staging";
  } catch {
    return null;
  }
}

/** How "the same page" is compared when merging nits: a URL's path, else the text. */
function pageKey(page: string | null): string {
  if (!page) return "";
  const match = page.match(URL_IN_TEXT)?.[0];
  if (match) {
    try {
      const url = new URL(match);
      return `${url.hostname}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
      // fall through to the text
    }
  }
  return page.trim().toLowerCase();
}

/**
 * `relaxed` apps get one issue for all the nits on a page; `strict` apps (CxC) one per nit.
 * Done here rather than by the model, so it's predictable.
 */
export function mergeNits(items: PendingItem[]): PendingItem[] {
  const groups = new Map<string, PendingItem[]>();
  for (const item of items) {
    if (item.type !== "nit") continue;
    const key = pageKey(item.page);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const merged: PendingItem[] = [];
  const done = new Set<string>();
  for (const item of items) {
    if (item.type !== "nit") {
      merged.push(item);
      continue;
    }
    const key = pageKey(item.page);
    if (done.has(key)) continue;
    done.add(key);
    const group = groups.get(key)!;
    if (group.length === 1) {
      merged.push(item);
      continue;
    }
    const environments = new Set(group.map((i) => i.environment));
    merged.push({
      ...item,
      title: item.page ? `Small fixes on ${item.page}`.slice(0, 120) : "Small fixes",
      verbatim: group.map((i) => i.verbatim).join("\n\n"),
      restatement: group.map((i) => `- ${i.restatement}`).join("\n"),
      sources: [...new Set(group.flatMap((i) => i.sources))],
      screenshots: [...new Set(group.flatMap((i) => i.screenshots))],
      environment: environments.size === 1 ? item.environment : null,
    });
  }
  return merged;
}

export interface ItemContext {
  /** Jump links of the transcript's messages: links[i] is [m(i+1)]. */
  messageLinks: string[];
  strictness: Strictness;
  productionUrl: string;
  /** From the modal: applies to every item. */
  environment: Environment | null;
  /** From the modal: used for items the model didn't place. */
  page: string | null;
}

/** What the model found → the card's items: questions out, links in, environments prefilled. */
export function buildItems(extracted: ExtractedItem[], ctx: ItemContext): PendingItem[] {
  const items = extracted.flatMap((item): PendingItem[] => {
    if (item.type === "question") return [];
    const page = item.page ?? ctx.page;
    return [
      {
        title: item.title,
        type: item.type,
        page,
        verbatim: item.verbatim,
        restatement: item.restatement,
        sources: item.messages.map((n) => ctx.messageLinks[n - 1]!).filter(Boolean),
        screenshots: item.screenshots,
        environment: ctx.environment ?? environmentFor(page, ctx.productionUrl),
        dropped: false,
        issue: null,
      },
    ];
  });
  return (ctx.strictness === "relaxed" ? mergeNits(items) : items).slice(0, MAX_ITEMS);
}

/** The items Create files: kept, and not filed yet. */
export const toFile = (items: FeedbackItem[]) =>
  items.flatMap((item, index) => (item.dropped || item.issue ? [] : [{ item, index }]));

/** Create needs something to file, and an environment on everything it files. */
export function createBlocker(items: FeedbackItem[]): string | null {
  const pending = toFile(items);
  if (pending.length === 0) return "Every item is left out. Pick at least one to file.";
  const missing = pending.filter(({ item }) => !item.environment).map(({ index }) => index + 1);
  if (missing.length > 0) {
    return `Pick an environment for item${missing.length > 1 ? "s" : ""} ${missing.join(", ")} first (the menu sets all of them; Edit sets one).`;
  }
  return null;
}
