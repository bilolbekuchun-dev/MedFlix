export type TelegramPostReference = {
  chatId: string;
  messageId: number;
};

type MovieEntry = {
  code: string;
  title: string;
};

type SeriesEntry = MovieEntry & {
  episodeCount: number;
};

const PAGE_VISIBLE_CHAR_LIMIT = 3700;
const PAGE_LINK_LIMIT = 90;

export function parseTelegramPostLink(
  value: string,
): TelegramPostReference | null {
  try {
    const url = new URL(value.trim());
    if (url.hostname !== "t.me" && url.hostname !== "telegram.me") {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }

    const messageId = Number(parts.at(-1));
    if (!Number.isInteger(messageId) || messageId <= 0) {
      return null;
    }

    if (parts[0] === "c" && parts.length >= 3) {
      const internalChatId = parts[1];
      if (!/^\d+$/.test(internalChatId)) {
        return null;
      }
      return {
        chatId: `-100${internalChatId}`,
        messageId,
      };
    }

    if (!/^[A-Za-z0-9_]+$/.test(parts[0])) {
      return null;
    }

    return { chatId: `@${parts[0]}`, messageId };
  } catch {
    return null;
  }
}

export function formatTelegramPostLink(
  reference: TelegramPostReference,
): string {
  if (reference.chatId.startsWith("@")) {
    return `https://t.me/${reference.chatId.slice(1)}/${reference.messageId}`;
  }

  if (reference.chatId.startsWith("-100")) {
    return `https://t.me/c/${reference.chatId.slice(4)}/${reference.messageId}`;
  }

  return `${reference.chatId}/${reference.messageId}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildBotLink(botUsername: string, code: string): string | null {
  if (!botUsername || !/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
    return null;
  }
  return `https://t.me/${botUsername}?start=${code}`;
}

export function buildContentsPages(
  sourceMovies: readonly MovieEntry[],
  sourceSeries: readonly SeriesEntry[],
  botUsername: string,
): string[] {
  const byCode = (a: MovieEntry, b: MovieEntry) =>
    a.code.localeCompare(b.code, undefined, { numeric: true });
  const movies = [...sourceMovies].sort(byCode);
  const series = [...sourceSeries].sort(byCode);

  type Entry = { section: string; code: string; title: string; suffix: string };
  const entries: Entry[] = [
    ...movies.map((movie) => ({
      section: "🎬 KINOLAR",
      code: movie.code,
      title: movie.title,
      suffix: "",
    })),
    ...series.map((item) => ({
      section: "📺 SERIALLAR",
      code: item.code,
      title: item.title,
      suffix: ` (${item.episodeCount} qism)`,
    })),
  ];

  const pages: string[][] = [];
  let body: string[] = [];
  let visible = 0;
  let links = 0;
  let section = "";
  let lastSection = "";

  const closePage = () => {
    if (body.length > 0) {
      pages.push(body);
    }
    body = [];
    visible = 0;
    links = 0;
    section = "";
  };

  for (const entry of entries) {
    const plain = `${entry.code} — ${entry.title}${entry.suffix}`;
    const headingCost = entry.section !== section ? entry.section.length + 20 : 0;
    if (
      visible + headingCost + plain.length + 1 > PAGE_VISIBLE_CHAR_LIMIT ||
      links >= PAGE_LINK_LIMIT
    ) {
      closePage();
    }

    if (entry.section !== section) {
      if (body.length > 0) {
        body.push("");
        visible += 1;
      }
      const heading =
        entry.section === lastSection && body.length === 0
          ? `${entry.section} (davomi)`
          : entry.section;
      body.push(heading);
      visible += heading.length + 1;
      section = entry.section;
      lastSection = entry.section;
    }

    const link = buildBotLink(botUsername, entry.code);
    if (link) {
      links += 1;
    }
    const titleHtml = link
      ? `<a href="${link}">${escapeHtml(entry.title)}</a>`
      : escapeHtml(entry.title);
    body.push(
      `${escapeHtml(entry.code)} — ${titleHtml}${escapeHtml(entry.suffix)}`,
    );
    visible += plain.length + 1;
  }
  closePage();

  if (pages.length === 0) {
    pages.push(["Hali kino qo‘shilmagan."]);
  }

  return pages.map((lines, index) => {
    const counter = pages.length > 1 ? ` (${index + 1}/${pages.length})` : "";
    return [
      `📚 MEDFLIX — MUNDARIJA${counter}`,
      "",
      ...lines,
      "",
      "🔎 Kino nomini bosing yoki kodni botga yuboring.",
    ].join("\n");
  });
}