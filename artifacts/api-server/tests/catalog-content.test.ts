import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContentsPages,
  formatTelegramPostLink,
  parseTelegramPostLink,
} from "../src/bot/catalog-content.ts";

test("private Telegram post links parse and format without losing the channel ID", () => {
  const reference = parseTelegramPostLink("https://t.me/c/4418309907/22");

  assert.deepEqual(reference, {
    chatId: "-1004418309907",
    messageId: 22,
  });
  assert.equal(
    formatTelegramPostLink(reference!),
    "https://t.me/c/4418309907/22",
  );
});

test("public Telegram post links remain supported", () => {
  assert.deepEqual(parseTelegramPostLink("https://t.me/MF_Base/17"), {
    chatId: "@MF_Base",
    messageId: 17,
  });
});

test("contents pages escape titles and make valid codes deep links", () => {
  const [page] = buildContentsPages(
    [{ code: "101", title: "A & B <Film>" }],
    [{ code: "S1", title: "Serial", episodeCount: 4 }],
    "MedFlix_robot",
  );

  assert.match(
    page,
    /<a href="https:\/\/t\.me\/MedFlix_robot\?start=101">A &amp; B &lt;Film&gt;<\/a>/,
  );
  assert.match(page, /<a href="https:\/\/t\.me\/MedFlix_robot\?start=S1">Serial<\/a>/);
  assert.match(page, /4 qism/);
});

test("contents split before exceeding the inline-link limit", () => {
  const movies = Array.from({ length: 91 }, (_, index) => ({
    code: `M${String(index + 1).padStart(3, "0")}`,
    title: `Film ${index + 1}`,
  }));

  const pages = buildContentsPages(movies, [], "MedFlix_robot");

  assert.equal(pages.length, 2);
  assert.match(pages[0], /\(1\/2\)/);
  assert.match(pages[1], /\(2\/2\)/);
  assert.equal((pages[0].match(/<a href=/g) ?? []).length, 90);
  assert.equal((pages[1].match(/<a href=/g) ?? []).length, 1);
});

test("empty contents produce a usable message without a bot username", () => {
  const [page] = buildContentsPages([], [], "");

  assert.match(page, /Hali kino qo‘shilmagan/);
  assert.doesNotMatch(page, /<a href=/);
});