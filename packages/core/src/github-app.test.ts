import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubError, appJwt, createGitHubApp, parseStrictness } from "./github-app";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const NOW = Date.parse("2026-11-08T17:00:00Z");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake api.github.com: installation lookup, tokens, and whatever `routes` adds. */
function fakeGitHub(routes: Record<string, (init: RequestInit) => Response> = {}) {
  const calls: { method: string; path: string; auth: string; body?: unknown }[] = [];
  const fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    const auth = (init.headers as Record<string, string>).Authorization ?? "";
    calls.push({ method, path, auth, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${path}`];
    if (route) return route(init);
    if (path === "/repos/uw-datasci/cxc/installation") return json({ id: 42 });
    if (path === "/app/installations/42/access_tokens")
      return json({ token: "inst-token", expires_at: new Date(NOW + 3_600_000).toISOString() });
    return json({ message: "Not Found" }, 404);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("appJwt", () => {
  it("is an RS256 JWT for the App, backdated a minute and valid 9", () => {
    const jwt = appJwt("123", privateKey, NOW);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      iat: NOW / 1000 - 60,
      exp: NOW / 1000 + 540,
      iss: "123",
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature!, "base64url")
      )
    ).toBe(true);
  });
});

describe("parseStrictness", () => {
  it("reads strictness, and anything else is strict", () => {
    expect(parseStrictness("app: x\nstrictness: relaxed\n")).toBe("relaxed");
    expect(parseStrictness("strictness: strict")).toBe("strict");
    expect(parseStrictness("app: x")).toBe("strict");
    expect(parseStrictness(null)).toBe("strict");
    expect(parseStrictness(": : not yaml [")).toBe("strict");
  });
});

describe("createGitHubApp", () => {
  const app = (fetch: typeof globalThis.fetch, key = PEM) =>
    createGitHubApp({ appId: "123", privateKey: key, fetch, now: () => NOW });

  it("files an issue with an installation token, reusing the token", async () => {
    const { fetch, calls } = fakeGitHub({
      "POST /repos/uw-datasci/cxc/issues": () =>
        json({ number: 12, html_url: "https://github.com/uw-datasci/cxc/issues/12" }, 201),
    });
    const github = app(fetch);
    const issue = { title: "Fix it", body: "b", labels: ["feedback"] };
    expect(await github.createIssue("uw-datasci/cxc", issue)).toEqual({
      number: 12,
      url: "https://github.com/uw-datasci/cxc/issues/12",
    });
    await github.createIssue("uw-datasci/cxc", issue);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/uw-datasci/cxc/installation",
      "POST /app/installations/42/access_tokens",
      "POST /repos/uw-datasci/cxc/issues",
      "POST /repos/uw-datasci/cxc/issues",
    ]);
    expect(calls[0]!.auth).toMatch(/^Bearer ey/);
    expect(calls[2]).toMatchObject({ auth: "Bearer inst-token", body: issue });
  });

  it("accepts a private key with escaped newlines", async () => {
    const { fetch } = fakeGitHub({ "GET /repos/uw-datasci/cxc": () => json({ private: false }) });
    expect(await app(fetch, PEM.replaceAll("\n", "\\n")).isPublic("uw-datasci/cxc")).toBe(true);
  });

  it("reads strictness from feedback.yml, caching it, and a missing file is strict", async () => {
    const { fetch, calls } = fakeGitHub({
      "GET /repos/uw-datasci/cxc/contents/.github/feedback.yml": () =>
        new Response("strictness: relaxed\n"),
    });
    const github = app(fetch);
    expect(await github.strictness("uw-datasci/cxc")).toBe("relaxed");
    expect(await github.strictness("uw-datasci/cxc")).toBe("relaxed");
    expect(calls.filter((c) => c.path.endsWith("feedback.yml"))).toHaveLength(1);

    const missing = fakeGitHub();
    expect(await app(missing.fetch).strictness("uw-datasci/cxc")).toBe("strict");
  });

  it("throws GitHubError: setup problems are errors, outages warnings", async () => {
    const notInstalled = app(fakeGitHub().fetch);
    await expect(notInstalled.isPublic("uw-datasci/other")).rejects.toMatchObject({
      name: "GitHubError",
      status: 404,
      severity: "error",
      message: expect.stringMatching(/isn't installed on uw-datasci\/other/),
    });

    const down = app(
      fakeGitHub({ "POST /repos/uw-datasci/cxc/issues": () => json({ message: "oops" }, 502) })
        .fetch
    );
    await expect(
      down.createIssue("uw-datasci/cxc", { title: "t", body: "b", labels: [] })
    ).rejects.toMatchObject({ status: 502, severity: "warning" });

    const unset = createGitHubApp({ appId: undefined, privateKey: undefined });
    await expect(unset.isPublic("uw-datasci/cxc")).rejects.toThrow(GitHubError);
    await expect(unset.isPublic("uw-datasci/cxc")).rejects.toThrow(/FEEDBACK_APP_ID/);
  });

  it("reads PRs and issues, comments, reopens and labels for the Discord buttons", async () => {
    const { fetch, calls } = fakeGitHub({
      "GET /repos/uw-datasci/cxc/pulls/34": () =>
        json({
          number: 34,
          html_url: "https://github.com/p/34",
          state: "closed",
          merged: true,
          user: { login: "nexus-feedback[bot]", type: "Bot" },
        }),
      "GET /repos/uw-datasci/cxc/issues/12": () =>
        json({
          number: 12,
          html_url: "https://github.com/i/12",
          state: "closed",
          labels: [{ name: "feedback" }, "route:agent"],
          assignees: [{ login: "lead" }],
        }),
      "POST /repos/uw-datasci/cxc/issues/12/comments": () =>
        json({ html_url: "https://github.com/i/12#c1" }, 201),
      "PATCH /repos/uw-datasci/cxc/issues/12": () => json({}),
      "POST /repos/uw-datasci/cxc/issues/12/labels": () => json([]),
    });
    const github = app(fetch);
    expect(await github.getPull("uw-datasci/cxc", 34)).toEqual({
      number: 34,
      url: "https://github.com/p/34",
      state: "closed",
      merged: true,
      author: "nexus-feedback[bot]",
      authorIsBot: true,
    });
    expect(await github.getIssue("uw-datasci/cxc", 12)).toEqual({
      number: 12,
      url: "https://github.com/i/12",
      state: "closed",
      labels: ["feedback", "route:agent"],
      assignees: ["lead"],
    });
    expect(await github.comment("uw-datasci/cxc", 12, "hi")).toEqual({
      url: "https://github.com/i/12#c1",
    });
    await github.reopenIssue("uw-datasci/cxc", 12);
    await github.addLabels("uw-datasci/cxc", 12, ["retriage"]);
    const writes = calls.filter(
      (c) => c.method !== "GET" && c.path.startsWith("/repos/uw-datasci/cxc/issues")
    );
    expect(writes.map((c) => [c.method, c.body])).toEqual([
      ["POST", { body: "hi" }],
      ["PATCH", { state: "open" }],
      ["POST", { labels: ["retriage"] }],
    ]);
    await expect(github.getPull("uw-datasci/cxc", 99)).rejects.toMatchObject({ status: 404 });
  });
});
