---
name: Telegram bot runtime
description: Runtime choices for the Telegram movie bot and its local persistence.
---

The bot uses Telegram long polling and Node's built-in `node:sqlite` instead of a native npm SQLite package. Forwarded channel posts should read both the current `forward_origin` shape and Telegram's legacy forward fields.

Ordinary movies can contain multiple ordered channel posts under one code (for example, poster first and the movie second); this is separate from serial seasons and episodes.

**Why:** The requested storage is SQLite, and the workspace runs Node 24, so the built-in module avoids native dependency installation and keeps deployment simpler.

**How to apply:** Keep movie metadata and polling offsets in the local SQLite file, and use Telegram `copyMessage` so channel videos are not downloaded or duplicated. Prefer collecting source chat/message IDs from an admin-forwarded post instead of asking admins to type them. Add ordinary-movie parts with `/add` for post 1 and `/addpost CODE | ORDER | NOTE` for later posts; deliver them in order without treating them as serial episodes.