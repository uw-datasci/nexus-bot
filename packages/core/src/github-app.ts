import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { parse } from "yaml";
import type { Severity } from "./types";

/**
 * GitHub, as the nexus-feedback App: the bot files feedback issues with an installation token so
 * they trigger the repo's triage workflow (events made with GITHUB_TOKEN don't trigger workflows).
 * Credentials: FEEDBACK_APP_ID and FEEDBACK_APP_PRIVATE_KEY, the same names nexus-workflows uses.
 */

export type Strictness = "strict" | "relaxed";

export interface NewIssue {
  title: string;
  body: string;
  labels: string[];
}

export interface CreatedIssue {
  number: number;
  url: string;
}

export interface FeedbackGitHub {
  /** Whether the repo is public, for the card's warning. */
  isPublic(repo: string): Promise<boolean>;
  /** `strictness` from the repo's .github/feedback.yml (strict when unset or missing). */
  strictness(repo: string): Promise<Strictness>;
  createIssue(repo: string, issue: NewIssue): Promise<CreatedIssue>;
}

export class GitHubError extends Error {
  /** Raft severity: "error" for setup problems someone must fix, "warning" for transient ones. */
  readonly severity: Severity;

  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "GitHubError";
    this.severity =
      status === undefined || status === 401 || status === 403 || status === 404 || status === 422
        ? "error"
        : "warning";
  }
}

export interface GitHubAppOptions {
  appId: string | undefined;
  /** PEM. Escaped newlines (`\n`, as some secret stores keep them) are accepted. */
  privateKey: string | undefined;
  apiUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

const CONFIG_TTL_MS = 5 * 60 * 1000;
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** The App's JWT (RS256), valid for 9 minutes and backdated a minute for clock drift. */
export function appJwt(appId: string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Only the field the bot reads; the workflows validate the whole file (nexus-workflows config.js). */
export function parseStrictness(text: string | null): Strictness {
  if (!text) return "strict";
  try {
    const doc: unknown = parse(text);
    const value = (doc as { strictness?: unknown } | null)?.strictness;
    return value === "relaxed" ? "relaxed" : "strict";
  } catch {
    return "strict";
  }
}

export function createGitHubApp({
  appId,
  privateKey,
  apiUrl = "https://api.github.com",
  timeoutMs = 10_000,
  fetch = globalThis.fetch,
  now = Date.now,
}: GitHubAppOptions): FeedbackGitHub {
  let key: KeyObject | null = null;
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  const configs = new Map<string, { strictness: Strictness; at: number }>();

  const appKey = () => {
    if (!appId || !privateKey) {
      throw new GitHubError("FEEDBACK_APP_ID and FEEDBACK_APP_PRIVATE_KEY aren't configured.");
    }
    key ??= createPrivateKey(privateKey.replaceAll("\\n", "\n"));
    return key;
  };

  async function call(
    path: string,
    auth: string,
    init: { method?: string; body?: unknown; accept?: string } = {}
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${apiUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${auth}`,
          Accept: init.accept ?? "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "nexus-bot",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GitHubError(`GitHub request failed: ${(error as Error).message}`, 0);
    }
    return response;
  }

  async function fail(response: Response, what: string): Promise<never> {
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message : response.statusText;
    throw new GitHubError(
      `${what}: GitHub returned ${response.status} (${message})`,
      response.status
    );
  }

  /** An installation token for the repo's owner, cached until shortly before it expires. */
  async function tokenFor(repo: string): Promise<string> {
    const cached = tokens.get(repo);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > now()) return cached.token;

    const jwt = appJwt(appId!, appKey(), now());
    const installation = await call(`/repos/${repo}/installation`, jwt);
    if (!installation.ok) {
      await fail(installation, `The nexus-feedback App isn't installed on ${repo}`);
    }
    const { id } = (await installation.json()) as { id: number };
    const created = await call(`/app/installations/${id}/access_tokens`, jwt, { method: "POST" });
    if (!created.ok) await fail(created, "Creating an installation token failed");
    const { token, expires_at } = (await created.json()) as { token: string; expires_at: string };
    tokens.set(repo, { token, expiresAt: Date.parse(expires_at) });
    return token;
  }

  return {
    async isPublic(repo) {
      const response = await call(`/repos/${repo}`, await tokenFor(repo));
      if (!response.ok) await fail(response, `Reading ${repo}`);
      return !((await response.json()) as { private?: boolean }).private;
    },

    async strictness(repo) {
      const cached = configs.get(repo);
      if (cached && now() - cached.at < CONFIG_TTL_MS) return cached.strictness;
      const response = await call(
        `/repos/${repo}/contents/.github/feedback.yml`,
        await tokenFor(repo),
        { accept: "application/vnd.github.raw+json" }
      );
      if (!response.ok && response.status !== 404) {
        await fail(response, `Reading ${repo}'s .github/feedback.yml`);
      }
      const strictness = parseStrictness(response.ok ? await response.text() : null);
      configs.set(repo, { strictness, at: now() });
      return strictness;
    },

    async createIssue(repo, issue) {
      const response = await call(`/repos/${repo}/issues`, await tokenFor(repo), {
        method: "POST",
        body: issue,
      });
      if (!response.ok) await fail(response, `Creating an issue on ${repo}`);
      const created = (await response.json()) as { number: number; html_url: string };
      return { number: created.number, url: created.html_url };
    },
  };
}
