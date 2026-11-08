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

Right-click → Apps commands on a message go in `messageCommands` (`/feedback`'s **Send as
feedback** is one). Then add the module to `modules` in `packages/core/src/features/index.ts`.
That's the only wiring:
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

## `/event-create`

Execs run `/event-create` in a thread where an event is being planned. The bot reads the thread,
Claude (`claude-opus-5-5`, medium effort, 40 s timeout) extracts the details into a **public**
preview card, and the exec picks a category, reviews the details in a modal and confirms. Admin
then has an **unpublished** event with a Draft badge on admin.uwdatascience.ca/events, and
nothing appears publicly until someone publishes it there.

- Code: `packages/core/src/features/event-create/` (ported from uwdsc-website-v3's
  `packages/server/admin/src/modules/discord-bot/`, behaviour unchanged). Drafts live in
  `discord.event_drafts`.
- The event is created through admin's `POST /api/internal/events/drafts`
  (`ADMIN_INTERNAL_URL`, `NEXUS_BOT_INTERNAL_TOKEN`). Its validation messages show up in the
  usual "⚠️ … [Fix]" message. Because that's a cross-app call, confirming acknowledges straight
  away and creates the event in the background.
- Only the person who ran it can use the card's controls. Errors and "only X can edit" are
  ephemeral. Drafts expire after **1 hour**.
- Rate limits, counted from drafts (failed runs included): **5 runs per exec per hour** and
  **1 run per thread per minute** (`packages/core/src/features/event-create/handlers.ts`).
- Times are typed and shown as `YYYY-MM-DD HH:mm` in **America/Toronto**. Times in the
  spring-forward gap are rejected.
- Who can run it: the guild's `role_ids` (exec, admin, pres) in `discord.settings`.
- Errors go to Raft with `route: "discord:event-bot"`.
- The bot needs **Message Content** intent (Bot → Privileged Gateway Intents) and View Channel +
  Read Message History in the planning channels. Private threads: add the bot to the thread.
- Spend: `ANTHROPIC_API_KEY` comes from the bot's own Claude Console workspace, whose monthly
  spend limit is the hard ceiling.

### Cutover from admin (B1a)

It's the same Discord application, so nothing is re-invited and the cutover is one URL change.

1. Put the exec server in `config/guilds.yaml`, with today's `DISCORD_EXEC_ROLE_ID` values
   (admin's Infisical) under `role_ids.exec`. Run `pnpm migrate` and `pnpm seed-settings`
   against the production database.
2. Deploy `apps/http` with the variables below, then run `pnpm register-commands` with the
   production application's ID and token. The guild's command set becomes `/event-create` and
   `/ping`. Because the name stays `event-create`, Discord keeps the **same command ID**, so the
   role visibility under Server Settings → Integrations is unchanged. Check the ID in the
   script's output against the old one.
3. In the Developer Portal → General Information, change **Interactions Endpoint URL** from
   `https://admin.uwdatascience.ca/api/discord/interactions` to
   `https://<nexus-bot deployment>/api/interactions`. Discord checks it on save.
4. Run `/event-create` in a planning thread and confirm a Draft appears in admin.
5. Record the cutover date on nexus-bot#1. It starts the one-week clock for removing the admin
   code (uwdsc-website-v3#199).

**Rollback:** paste `https://admin.uwdatascience.ca/api/discord/interactions` back into the
Interactions Endpoint URL. The admin code stays until #199, and drafts started on one side can't
be confirmed on the other, so anyone mid-draft runs `/event-create` again.

Rehearse both directions on your personal test app first: point its endpoint at a local or
preview nexus-bot, then at a preview admin, and back.

## `/feedback`

Organizers turn feedback about an event app into GitHub issues on its repo, where the app's
triage workflow (nexus-workflows `feedback-triage.yml`) routes them. Spec: Feedback loop §2.

| How it's run                                        | What the bot reads                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `/feedback` with text and/or screenshots            | **Prompt mode**: what was typed and attached. In a thread, the thread is background only.  |
| `/feedback` submitted empty, in a thread            | The whole thread                                                                           |
| `/feedback` submitted empty, in a channel           | Messages since the bot's last feedback card there, at most 30 minutes and 25 messages back |
| Right-click a message → Apps → **Send as feedback** | That message, its attachments, the replies to it and its thread                            |

- Claude Haiku (`claude-haiku-5-5`, `FEEDBACK_ANTHROPIC_API_KEY`) splits it into items: a title,
  type (bug, change or nit), page, the organizer's words, a one-line summary, links to the
  messages and screenshots. Questions aren't filed. At most 10 items per run.
- A **public** preview card lists the items. The runner can leave items out, set the environment
  for all of them or **Edit** one (title, type, page, summary, environment), then **Create**.
  Create stays disabled until every kept item has an environment, which is prefilled from the
  modal or from a page URL (the production host means Production, any other URL Staging). The
  card warns when the repo is public. Only the runner can use it, and it expires after 1 hour.
- Create files one issue per item through the nexus-feedback GitHub App, labelled `feedback`,
  `feedback:<type>` and `env:<prod|staging>`. The body quotes the feedback (with GitHub
  @-mentions broken up) and ends with `<!-- nexus-feedback {"guild","channel","message","user"} -->`,
  where `message` is the card, so the workflows can post back. A failed issue can be retried
  with Create; filed ones are never filed twice.
- `strictness: relaxed` in the repo's `.github/feedback.yml` merges nits on the same page into one
  issue; `strict` (CxC, and the default) files one per nit.
- Screenshots are copied to Vercel Blob when the card is made, because Discord's attachment
  URLs expire. The issue embeds the Blob URLs.
- Rate limit: **10 runs per user per hour**, in `discord.usage`. Drafts live in
  `discord.feedback_drafts`. Errors go to Raft with `route: "discord:feedback"`.
- Code: `packages/core/src/features/feedback/`, `packages/core/src/github-app.ts` and
  `packages/core/src/screenshots.ts`.

Who can use it, per app, is the guild's `feedback_apps` setting (see
`config/guilds.example.yaml`): the repo, the production URL, and role sets, any one of which is
enough (CxC: `cxc-team`, or `VP` and `Design` together). An app can also be limited to some
channels. Someone allowed for more than one app picks it in the modal.

### Setting up `/feedback`

1. Install the nexus-feedback GitHub App on the app's repo (cxc), with the labels from
   uw-datasci/cxc#46 in place.
2. Create a **public** Vercel Blob store on the nexus-bot project. Vercel adds
   `BLOB_READ_WRITE_TOKEN`.
3. Set `FEEDBACK_ANTHROPIC_API_KEY`, `FEEDBACK_APP_ID` and `FEEDBACK_APP_PRIVATE_KEY` (the
   values in Infisical `/nexus-feedback`). Missing ones fail feedback runs with a clear message;
   nothing else is affected.
4. Add `feedback_apps` to the exec server in `config/guilds.yaml` with the real role IDs, then
   run `pnpm migrate`, `pnpm seed-settings` and `pnpm register-commands`.
5. The bot needs View Channel, Read Message History and Send Messages (in threads too) where
   feedback is sent.

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
| `ANTHROPIC_API_KEY`                                                 | `/event-create` extraction (the bot's Claude Console workspace)     |
| `ADMIN_INTERNAL_URL`, `NEXUS_BOT_INTERNAL_TOKEN`                    | admin's internal API (the token matches admin's)                    |
| `ADMIN_BYPASS_TOKEN`                                                | optional: Vercel protection bypass, to test against a preview admin |
| `FEEDBACK_ANTHROPIC_API_KEY`                                        | `/feedback` extraction (the feedback loop's own workspace)          |
| `FEEDBACK_APP_ID`, `FEEDBACK_APP_PRIVATE_KEY`                       | the nexus-feedback GitHub App, for filing issues                    |
| `BLOB_READ_WRITE_TOKEN`                                             | a public Vercel Blob store, for feedback screenshots                |
| `NODE_AUTH_TOKEN`                                                   | read access to `@uw-datasci/raft` (used by `vercel.json`'s install) |

Once it's deployed, set the application's Interactions Endpoint URL to
`https://<deployment>/api/interactions`.
