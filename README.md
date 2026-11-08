# nexus-bot

The UW Data Science Club Discord bot: one Discord application in the exec and public servers.
Today it serves slash commands over **HTTP interactions** on Vercel (`apps/http`). The gateway
process on the club cluster (`apps/bot`) comes in B1b, and `apps/http` stays as the fallback.

Spec: [nexus-bot: the club Discord bot](https://app.notion.com/p/4031b70395fc8195ac6dcf6fc014f960).

This repo is **public**. Never commit tokens, keys or connection strings. `.env*` and
`config/guilds.yaml` are gitignored.

## Layout

```txt
apps/http/            Next.js app with one route: POST /api/interactions (Vercel)
packages/core/        feature registry, dispatcher, permission gate, guild settings, features/
packages/discord/     signature verification, REST client, custom_id helpers, response builders
packages/db/          `discord` schema migrations, repositories (settings, usage)
scripts/              migrate, seed-settings, register-commands
config/               guilds.example.yaml: the template for config/guilds.yaml
```

Stack: Node 24, pnpm 12, Turbo, TypeScript, Vitest, `@discordjs/core` + `@discordjs/rest`.
Errors go to Raft (`@uw-datasci/raft`), like the other club apps.

## How a command runs

1. Discord POSTs the interaction to `/api/interactions`. The route checks the Ed25519 signature
   on the raw body and answers **401** if it's bad.
2. `dispatch()` (packages/core) answers PING, loads the guild's settings from `discord.settings`,
   finds the handler in the registry, and checks the gate: `can(actor, capability)`.
3. The handler returns `{ response, background? }`. The response goes out within Discord's 3 s;
   `background` runs afterwards in `after()`. For 15 minutes the interaction token can edit the
   reply; after that, use the bot token (`editInteractionMessage` picks the right one).

Component and modal IDs are `<feature>:<action>:<id>` (for example `evt:review:42`). The
dispatcher routes on the feature, then the action.

## Adding a feature

Create `packages/core/src/features/<name>/index.ts` exporting a `FeatureModule`:

```ts
export const demo: FeatureModule = {
  name: "demo", // also the custom_id prefix
  guilds: ["exec"], // which servers get it
  commands: [
    { definition: { name: "demo", description: "…" }, capability: "event.create", handle },
  ],
  components: { approve: { capability: "event.create", handle: onApprove } }, // demo:approve:<id>
};
```

Then add it to `modules` in `packages/core/src/features/index.ts`. That's the only wiring:
`pnpm register-commands` and the dispatcher read the same registry. Capabilities and the website
roles they need are in `packages/core/src/gate.ts`.

## Permissions

`can(actor, capability)` checks the member's Discord roles. While `require_linked_accounts` is
`false` (until B2 links Discord accounts to website accounts), the guild's `role_ids` setting says
which Discord roles stand for the website roles `exec`, `admin` (VP) and `pres`. That generalizes
the website bot's `DISCORD_EXEC_ROLE_ID`.

## Database

The bot owns the `discord` schema in the website's Supabase database. Migrations are plain SQL in
`packages/db/migrations`, applied in name order and recorded in `discord.schema_migrations` (not
the website's migrations table). They're up-only: to undo something, add a migration.

```sh
pnpm migrate          # apply pending migrations
pnpm migrate:status   # list applied and pending
```

Use a direct or session-pooler connection for migrations. On Vercel, `DATABASE_URL` is the
transaction pooler (`createDb(url, { pooled: true })` turns off prepared statements).
On `main`, `.github/workflows/migrate-db.yml` runs migrations with `DATABASE_URL` from Infisical
(folder `/db`, project from the `INFISICAL_PROJECT_SLUG` repository variable).

## Local development

You need your own Discord application and test server, never the club's.

1. **Install.** Add `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` to your user-level
   `~/.npmrc` and export `NODE_AUTH_TOKEN` (a classic PAT with `read:packages`) for Raft. Then
   run `pnpm install`.
2. **Discord app.** At <https://discord.com/developers/applications>, create an application. Copy
   the Application ID and Public Key, and reset the bot token. Invite it to your test server with
   the `bot` and `applications.commands` scopes.
3. **Database.** Any Postgres works, for example
   `docker run -d --name nexus-bot-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17`.
4. **Config.**
   - `cp .env.example .env.local` and fill in the Discord values and `DATABASE_URL`.
   - `cp config/guilds.example.yaml config/guilds.yaml` and put in your test server's ID and role
     IDs (Developer Mode on → right-click → Copy ID). Quote every ID.
5. **Set up.** `pnpm migrate`, then `pnpm seed-settings`, then `pnpm register-commands`.
6. **Run.** `pnpm dev` starts `apps/http` on <http://localhost:3000>. In another terminal, run
   `cloudflared tunnel --url http://localhost:3000` and copy the `https://….trycloudflare.com` URL.
7. **Connect.** In the Developer Portal, set **Interactions Endpoint URL** to
   `https://<tunnel>/api/interactions`. Discord checks it when you save, so `pnpm dev` must be
   running with the right `DISCORD_PUBLIC_KEY`.
8. Run `/ping` in your test server.

The tunnel URL changes every time cloudflared restarts, so update the endpoint URL when it does.

## Checks

```sh
pnpm lint
pnpm check-types
pnpm test             # set TEST_DATABASE_URL (a throwaway DB) to include the database tests
pnpm format:check
```

CI (`.github/workflows/quality-gate.yml`) runs lint and typecheck through nexus-workflows, and
the tests against a Postgres service container.

## Deploying (Vercel)

`apps/http` deploys as its own Vercel project, with **Root Directory** `apps/http`. Environment
variables:

| Variable                                                            |                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` | the club application                                                |
| `DATABASE_URL`                                                      | Supabase transaction pooler, `nexus_bot` role                       |
| `RAFT_APP_NAME`, `RAFT_DATABASE_URL`                                | Raft error reporting                                                |
| `NODE_AUTH_TOKEN`                                                   | read access to `@uw-datasci/raft` (used by `vercel.json`'s install) |

Once it's deployed, set the application's Interactions Endpoint URL to
`https://<deployment>/api/interactions`.
