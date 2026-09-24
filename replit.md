# Telegram Kino Bot

Telegram bot that stores movie codes in SQLite and copies the matching movie post from a Telegram channel to the user.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server and Telegram long-polling bot
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secret: `TELEGRAM_BOT_TOKEN` — token from BotFather
- Optional env: `TELEGRAM_ADMIN_IDS` — comma-separated Telegram user IDs allowed to use admin commands
- Optional env: `TELEGRAM_REQUIRED_CHANNEL_IDS` and `TELEGRAM_REQUIRED_CHAT_IDS` — comma-separated channel/chat IDs for subscription checks
- Optional env: `TELEGRAM_REQUIRED_CHANNEL_URLS` and `TELEGRAM_REQUIRED_CHAT_URLS` — matching comma-separated invite/public links for the subscription buttons
- Optional env: `TELEGRAM_DISCUSSION_URL` — discussion link shown below delivered movies

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: SQLite via Node's built-in `node:sqlite` module (`data/kino-bot.sqlite`)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot/telegram.ts` — Telegram API client, polling loop, commands and movie lookup
- `artifacts/api-server/src/bot/database.ts` — SQLite schema and movie/settings persistence
- `data/kino-bot.sqlite` — runtime database file, created automatically

## Architecture decisions

- The bot uses Telegram long polling so it works without a public webhook URL.
- Movie delivery uses `copyMessage`, so the bot does not download or duplicate video files.
- Telegram update offsets are persisted in SQLite to avoid replaying old messages after restart.
- Admin access is controlled with `TELEGRAM_ADMIN_IDS`; regular users can search by code or title after the optional subscription gate.
- Subscription checks use Telegram `getChatMember`; administrators bypass the gate.

## Product

- Users send a movie code or title and receive the matching post from the source channel. `/catalog` and inline buttons provide browsing.
- Admins can add or update movies with `/add`, assign genres with `/genre`, remove them with `/delete`, and inspect the catalog with `/list`.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
