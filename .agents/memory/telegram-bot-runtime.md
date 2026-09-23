---
name: Telegram bot runtime
description: Runtime choices for the Telegram movie bot and its local persistence.
---

The bot uses Telegram long polling and Node's built-in `node:sqlite` instead of a native npm SQLite package.

**Why:** The requested storage is SQLite, and the workspace runs Node 24, so the built-in module avoids native dependency installation and keeps deployment simpler.

**How to apply:** Keep movie metadata and polling offsets in the local SQLite file, and use Telegram `copyMessage` so channel videos are not downloaded or duplicated.