import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type API,
  type APIInteraction,
} from "@nexus-bot/discord";
import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../../dispatch";
import type { FeedbackGitHub, IssueInfo, PullInfo } from "../../github-app";
import { createRegistry } from "../../registry";
import type { Services } from "../../services";
import { parseGuildSettings } from "../../settings";
import { APP_ID, CHANNEL, CXC_TEAM, DESIGN, GUILD, RUNNER, THREAD, VP } from "./fixtures";
import { feedback } from "./index";
import { DISCORD_MARKER, REPLIES_PER_USER, parseUpdateRef } from "./updates";

const REPO = "uw-datasci/cxc";
type Payload = { content?: string; flags?: number; [key: string]: unknown };

function setup({
  pull = {},
  issue = {},
  failComment = false,
}: { pull?: Partial<PullInfo>; issue?: Partial<IssueInfo>; failComment?: boolean } = {}) {
  const comments: { number: number; body: string }[] = [];
  const github = {
    getPull: vi.fn(async (_repo: string, number: number) => ({
      number,
      url: `https://github.com/${REPO}/pull/${number}`,
      state: "open" as const,
      merged: false,
      author: "nexus-feedback[bot]",
      authorIsBot: true,
      ...pull,
    })),
    getIssue: vi.fn(async (_repo: string, number: number) => ({
      number,
      url: `https://github.com/${REPO}/issues/${number}`,
      state: "open" as const,
      labels: ["feedback", "route:agent"],
      assignees: ["lead"],
      ...issue,
    })),
    comment: vi.fn(async (_repo: string, number: number, body: string) => {
      if (failComment) throw new Error("GitHub is down");
      comments.push({ number, body });
      return { url: "https://github.com/x#c" };
    }),
    reopenIssue: vi.fn(async () => {}),
    addLabels: vi.fn(async () => {}),
  };

  const runs: string[] = [];
  const usage: Services["usage"] = {
    record: async ({ userId, feature }) => void runs.push(`${feature}:${userId}`),
    recentRuns: async ({ userId, feature }) => ({
      byUser: runs.filter((r) => r === `${feature}:${userId}`).length,
      byChannel: 0,
    }),
  };

  const discord = {
    interactions: {
      editReply: vi.fn(async (_app: string, _token: string, _body: Payload) => ({})),
      followUp: vi.fn(async (_app: string, _token: string, _body: Payload) => ({})),
    },
  };
  const reportError = vi.fn().mockResolvedValue(undefined);
  const deps = {
    registry: createRegistry([feedback]),
    loadSettings: async () =>
      parseGuildSettings(GUILD, {
        kind: "exec",
        feedback_apps: {
          cxc: {
            repo: REPO,
            production_url: "https://cxc.uwdatascience.ca",
            role_sets: [[CXC_TEAM], [VP, DESIGN]],
          },
        },
      }),
    discord: discord as unknown as API,
    applicationId: APP_ID,
    reportError,
    now: () => Date.parse("2026-11-08T17:00:00Z"),
    services: {
      usage,
      github: github as unknown as FeedbackGitHub,
    } as Partial<Services> as Services,
  };

  const send = async (interaction: object) => {
    const result = await dispatch(interaction as APIInteraction, deps);
    await result.background?.();
    return result.response as { type: number; data?: Payload };
  };
  /** What the bot last told the clicker in the ephemeral reply. */
  const lastReply = () => discord.interactions.editReply.mock.calls.at(-1)?.[2];
  return { github, comments, discord, reportError, send, lastReply, runs };
}

const NOTIFY = {
  id: "700000000000000999",
  channel_id: THREAD,
  content:
    "<@400000000000000001> 🔍 **[#12](https://github.com/uw-datasci/cxc/issues/12) is ready to check**",
  components: [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          label: "Open preview",
          url: "https://p.vercel.app",
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Success,
          label: "Looks good",
          custom_id: `fb:good:${REPO}:34:12`,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: "Still not right",
          custom_id: `fb:again:${REPO}:34:12`,
        },
      ],
    },
  ],
};

const base = (roles = [CXC_TEAM]) => ({
  id: "1436700000000000000",
  application_id: APP_ID,
  token: "interaction-token",
  version: 1,
  guild_id: GUILD,
  channel: { id: THREAD, type: ChannelType.PublicThread, parent_id: CHANNEL },
  channel_id: THREAD,
  member: { user: { id: RUNNER, username: "sam", global_name: "Sam" }, roles },
});

const click = (customId: string, roles?: string[]) => ({
  ...base(roles),
  type: InteractionType.MessageComponent,
  message: NOTIFY,
  data: { custom_id: customId, component_type: ComponentType.Button },
});

const submit = (customId: string, text: string, roles?: string[]) => ({
  ...base(roles),
  type: InteractionType.ModalSubmit,
  message: NOTIFY,
  data: {
    custom_id: customId,
    components: [
      {
        type: ComponentType.Label,
        component: { type: ComponentType.TextInput, custom_id: "text", value: text },
      },
    ],
  },
});

describe("parseUpdateRef", () => {
  it("reads the workflow's custom_ids and nothing else", () => {
    expect(parseUpdateRef(`${REPO}:34:12`, true)).toEqual({ repo: REPO, pr: 34, issue: 12 });
    expect(parseUpdateRef(`${REPO}:12`, false)).toEqual({ repo: REPO, pr: null, issue: 12 });
    for (const bad of [
      `${REPO}:12`,
      "cxc:34:12",
      `${REPO}:0:12`,
      `${REPO}:34:x`,
      `${REPO}:34:12:1`,
    ]) {
      expect(parseUpdateRef(bad, true), bad).toBeNull();
    }
  });
});

describe("who can use the buttons", () => {
  it("anyone who can send feedback for the repo's app: VP alone can't", async () => {
    const t = setup();
    const refused = await t.send(click(`fb:again:${REPO}:34:12`, [VP]));
    expect(refused.data?.content).toBe("Only people who can send feedback for cxc can use this.");
    expect((await t.send(click(`fb:again:${REPO}:34:12`, [VP, DESIGN]))).type).toBe(
      InteractionResponseType.Modal
    );
  });

  it("refuses repos this server doesn't send feedback to, and bad ids", async () => {
    const t = setup();
    expect((await t.send(click("fb:good:uw-datasci/other:34:12"))).data?.content).toMatch(
      /doesn't take feedback/
    );
    expect((await t.send(click("fb:good:nope"))).data?.content).toBe("Unknown action.");
    expect(t.github.comment).not.toHaveBeenCalled();
  });
});

describe("Looks good", () => {
  it("comments on the PR and drops the reply buttons, keeping the preview link", async () => {
    const t = setup();
    const response = await t.send(click(`fb:good:${REPO}:34:12`));
    expect(response.type).toBe(InteractionResponseType.DeferredMessageUpdate);
    expect(t.comments).toEqual([
      { number: 34, body: expect.stringMatching(/^👍 \*\*Looks good\*\* to \*\*Sam\*\*/) },
    ]);
    expect(t.comments[0]!.body.endsWith(DISCORD_MARKER)).toBe(true);
    const edited = t.lastReply()!;
    expect(edited.content).toMatch(/\n👍 <@400000000000000001> says it looks good\.$/);
    expect(edited.components).toEqual([
      { ...NOTIFY.components[0], components: [NOTIFY.components[0]!.components[0]] },
    ]);
  });

  it("says so privately when GitHub fails, and reports it", async () => {
    const t = setup({ failComment: true });
    await t.send(click(`fb:good:${REPO}:34:12`));
    expect(t.discord.interactions.followUp.mock.calls[0]![2]).toMatchObject({
      content: expect.stringMatching(/^Couldn't reach GitHub/),
      flags: MessageFlags.Ephemeral,
    });
    expect(t.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ step: "looks-good" }),
      "error"
    );
  });
});

describe("Still not right", () => {
  it("opens a modal, then sends an open route:agent PR to @claude", async () => {
    const t = setup();
    const modal = await t.send(click(`fb:again:${REPO}:34:12`));
    expect(modal.type).toBe(InteractionResponseType.Modal);
    expect((modal.data as { custom_id: string }).custom_id).toBe(`fb:againtext:${REPO}:34:12`);

    const response = await t.send(
      submit(`fb:againtext:${REPO}:34:12`, "still white on mobile, cc @lead")
    );
    expect(response).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });
    expect(t.comments).toHaveLength(1);
    const { number, body } = t.comments[0]!;
    expect(number).toBe(34);
    expect(body).toMatch(/^@claude An organizer checked the preview/);
    expect(body).toContain("> still white on mobile, cc @​lead");
    expect(body).toContain("From **Sam** in Discord.");
    expect(t.lastReply()?.content).toBe(
      "Sent to Claude on #34. A new preview will show up here when it's ready."
    );
  });

  it("mentions the assigned developer on an open route:dev PR", async () => {
    const t = setup({ issue: { labels: ["feedback", "route:dev"], assignees: ["dev1", "dev2"] } });
    await t.send(submit(`fb:againtext:${REPO}:34:12`, "the spacing is off"));
    expect(t.comments[0]!.body).toMatch(/^@dev1 @dev2 An organizer/);
    expect(t.comments[0]!.body).not.toContain("@claude");
    expect(t.lastReply()?.content).toBe("Sent to dev1, dev2 on #34.");
  });

  it("after merge, reopens the issue, comments and asks for triage again", async () => {
    const t = setup({ pull: { state: "closed", merged: true }, issue: { state: "closed" } });
    await t.send(submit(`fb:againtext:${REPO}:34:12`, "the footer link still 404s"));
    expect(t.comments[0]).toMatchObject({
      number: 12,
      body: expect.stringMatching(/^\*\*Still not right\*\* after #34 was merged/),
    });
    expect(t.github.reopenIssue).toHaveBeenCalledWith(REPO, 12);
    expect(t.github.addLabels).toHaveBeenCalledWith(REPO, 12, ["retriage"]);
    expect(t.lastReply()?.content).toBe("Reopened #12. Triage will look at it again.");
  });

  it("is limited to 10 replies an hour", async () => {
    const t = setup();
    for (let i = 0; i < REPLIES_PER_USER; i++)
      await t.send(submit(`fb:againtext:${REPO}:34:12`, `round ${i}`));
    expect((await t.send(click(`fb:again:${REPO}:34:12`))).data?.content).toMatch(
      /10 replies in the last hour/
    );
    expect((await t.send(submit(`fb:againtext:${REPO}:34:12`, "again"))).data?.content).toMatch(
      /10 replies/
    );
    expect(t.comments).toHaveLength(REPLIES_PER_USER);
  });
});

describe("Answer", () => {
  it("comments the answer on the issue and asks for triage again", async () => {
    const t = setup({ issue: { labels: ["feedback", "needs-info"], assignees: [] } });
    const modal = await t.send(click(`fb:answer:${REPO}:12`));
    expect((modal.data as { custom_id: string }).custom_id).toBe(`fb:answertext:${REPO}:12`);

    await t.send(
      submit(`fb:answertext:${REPO}:12`, "It's the apply page <!-- nexus-feedback {} -->")
    );
    const { number, body } = t.comments[0]!;
    expect(number).toBe(12);
    expect(body).toMatch(
      /^\*\*Answer from Sam\*\* in Discord:\n\n> It's the apply page &lt;!-- nexus-feedback \{\} --&gt;/
    );
    expect(t.github.addLabels).toHaveBeenCalledWith(REPO, 12, ["retriage"]);
    expect(t.lastReply()?.content).toMatch(/^Thanks\. Your answer is on #12/);
  });

  it("does nothing for a closed issue", async () => {
    const t = setup({ issue: { state: "closed" } });
    await t.send(submit(`fb:answertext:${REPO}:12`, "x"));
    expect(t.comments).toEqual([]);
    expect(t.lastReply()?.content).toMatch(/is closed/);
  });
});
