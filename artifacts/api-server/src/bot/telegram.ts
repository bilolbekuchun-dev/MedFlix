import {
  deleteMovie,
  deleteSeries,
  findMovie,
  listMoviePosts,
  findSeries,
  findSeriesEpisode,
  getSetting,
  listMovies,
  listSeries,
  listSeriesSeasons,
  listSeriesEpisodes,
  listGenres,
  listMoviesByGenre,
  searchSeries,
  setSetting,
  setMovieGenres,
  searchMovies,
  upsertSeries,
  upsertSeriesEpisode,
  upsertMovie,
  upsertMoviePost,
} from "./database";
import { logger } from "../lib/logger";

type TelegramResponse<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

type TelegramUser = {
  id: number;
  first_name?: string;
  username?: string;
};

type TelegramChat = {
  id: number;
  title?: string;
  username?: string;
};

type TelegramForwardOrigin = {
  type?: string;
  chat?: TelegramChat;
  message_id?: number;
};

type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  forward_origin?: TelegramForwardOrigin;
  forward_from_chat?: TelegramChat;
  forward_from_message_id?: number;
  reply_to_message?: TelegramMessage;
};

type InlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

const token = process.env.TELEGRAM_BOT_TOKEN;
const pendingForwardedPosts = new Map<
  string,
  { channelChatId: string; channelMessageId: number }
>();
const subscriptionCache = new Map<number, { subscribed: boolean; expiresAt: number }>();

type ReplyMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

type RequiredSubscription = {
  chatId: string;
  label: string;
  url?: string;
};

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function telegramApi<T>(
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as TelegramResponse<T>;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? `Telegram API error: ${response.status}`);
  }

  return payload.result;
}

async function sendText(
  chatId: number,
  text: string,
  replyMarkup?: ReplyMarkup,
): Promise<void> {
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function isAdmin(userId: number): boolean {
  return new Set(getAdminIds()).has(String(userId));
}

function getAdminIds(): string[] {
  return (process.env.TELEGRAM_ADMIN_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function getCsvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getRequiredSubscriptions(): RequiredSubscription[] {
  const channelIds = getCsvEnv("TELEGRAM_REQUIRED_CHANNEL_IDS");
  const channelUrls = getCsvEnv("TELEGRAM_REQUIRED_CHANNEL_URLS");
  const chatIds = getCsvEnv("TELEGRAM_REQUIRED_CHAT_IDS");
  const chatUrls = getCsvEnv("TELEGRAM_REQUIRED_CHAT_URLS");

  return [
    ...channelIds.map((chatId, index) => ({
      chatId,
      label: "Asosiy kanalga obuna bo‘lish",
      url: channelUrls[index],
    })),
    ...chatIds.map((chatId, index) => ({
      chatId,
      label: "Muhokama chatiga qo‘shilish",
      url: chatUrls[index],
    })),
  ];
}

function encodeCallbackValue(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeCallbackValue(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function getDiscussionUrl(): string | undefined {
  const value = process.env.TELEGRAM_DISCUSSION_URL?.trim();
  return value || undefined;
}

type TelegramPostReference = {
  chatId: string;
  messageId: number;
};

const defaultStructurePost: TelegramPostReference = {
  chatId: "@MF_Base",
  messageId: 6,
};

function parseTelegramPostLink(value: string): TelegramPostReference | null {
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

function getStructurePostReference(): TelegramPostReference {
  const chatId = getSetting("structure_post_chat_id");
  const messageId = Number(getSetting("structure_post_message_id"));

  if (chatId && Number.isInteger(messageId) && messageId > 0) {
    return { chatId, messageId };
  }

  return defaultStructurePost;
}

function formatTelegramPostLink(reference: TelegramPostReference): string {
  if (reference.chatId.startsWith("@")) {
    return `https://t.me/${reference.chatId.slice(1)}/${reference.messageId}`;
  }

  if (reference.chatId.startsWith("-100")) {
    return `https://t.me/c/${reference.chatId.slice(4)}/${reference.messageId}`;
  }

  return `${reference.chatId}/${reference.messageId}`;
}

function formatStructurePost(): string {
  const movies = listMovies();
  const series = listSeries();
  const genres = listGenres();
  const startVideoConfigured = Boolean(
    getSetting("start_channel_chat_id") &&
      getSetting("start_channel_message_id"),
  );
  const requiredSubscriptions = getRequiredSubscriptions();
  const recentMovies = movies
    .slice(0, 12)
    .map((movie) => `• ${movie.code} — ${movie.title}`)
    .join("\n");

  return [
    "🩺 MEDFLIX BOT — TIZIM MA’LUMOTI",
    "",
    "📦 DATABASE",
    `• SQLite: ${movies.length} ta kino/material`,
    `• Seriallar: ${series.length} ta, jami ${series.reduce((sum, item) => sum + item.episodeCount, 0)} ta qism`,
    `• Janrlar: ${genres.length} ta`,
    "",
    "📚 SO‘NGGI KODLAR",
    recentMovies || "• Hali kino qo‘shilmagan",
    "",
    "🔌 API VA ISHLASH STRUKTURASI",
    "• Telegram Bot API + long polling",
    "• Kino yetkazish: copyMessage",
    "• Qidiruv: kod va nom bo‘yicha",
    "• Katalog: janrlar va inline tugmalar",
    "",
    "👤 USER FLOW",
    "• /start — welcome va start video",
    "• Kod yoki nom yuborish — kino olish",
    "• /catalog — katalogni ko‘rish",
    "• /search — qidiruv",
    `• Majburiy obuna: ${requiredSubscriptions.length > 0 ? "yoqilgan" : "o‘chirilgan"}`,
    "",
    "🔐 ADMIN COMMANDS",
    "• /add KOD | Nomi — 1-post",
    "• /addpost KOD | Tartib | Izoh — qo‘shimcha post",
    "• /addseries KOD | Serial nomi",
    "• /addpart KOD | Fasl | Qism | Nomi",
    "• /genre KOD | Janr 1, Janr 2",
    "• /setstart",
    "• /setstructure POST_LINK",
    "• /delete KOD",
    "• /list",
    `• Start video: ${startVideoConfigured ? "sozlangan" : "sozlanmagan"}`,
    "",
    `🔄 Oxirgi sinxronlash: ${new Date().toISOString()}`,
  ].join("\n");
}

async function refreshStructurePost(): Promise<boolean> {
  const reference = getStructurePostReference();

  try {
    await telegramApi("editMessageText", {
      chat_id: reference.chatId,
      message_id: reference.messageId,
      text: formatStructurePost(),
      disable_web_page_preview: true,
    });
    logger.info(
      { chatId: reference.chatId, messageId: reference.messageId },
      "Structure post updated",
    );
    return true;
  } catch (err: unknown) {
    const errorText = err instanceof Error ? err.message : String(err);
    if (errorText.includes("message is not modified")) {
      return true;
    }

    logger.warn(
      { err, chatId: reference.chatId, messageId: reference.messageId },
      "Failed to update structure post",
    );
    return false;
  }
}

function getSubscriptionKeyboard(): ReplyMarkup {
  const buttons: InlineKeyboardButton[] = getRequiredSubscriptions().map(
    (subscription) => ({
      text: subscription.label,
      ...(subscription.url ? { url: subscription.url } : {}),
    }),
  );

  buttons.push({ text: "✅ Tekshirish", callback_data: "subscription:check" });
  return {
    inline_keyboard: buttons.map((button) => [button]),
  };
}

async function isSubscribed(userId: number): Promise<boolean> {
  if (isAdmin(userId) || getRequiredSubscriptions().length === 0) {
    return true;
  }

  const cached = subscriptionCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.subscribed;
  }

  for (const subscription of getRequiredSubscriptions()) {
    try {
      const member = await telegramApi<{ status: string }>("getChatMember", {
        chat_id: subscription.chatId,
        user_id: userId,
      });
      if (
        member.status !== "creator" &&
        member.status !== "administrator" &&
        member.status !== "member"
      ) {
        subscriptionCache.set(userId, {
          subscribed: false,
          expiresAt: Date.now() + 60_000,
        });
        return false;
      }
    } catch (err: unknown) {
      logger.error(
        { err, userId, requiredChatId: subscription.chatId },
        "Failed to check Telegram subscription",
      );
      subscriptionCache.set(userId, {
        subscribed: false,
        expiresAt: Date.now() + 15_000,
      });
      return false;
    }
  }

  subscriptionCache.set(userId, {
    subscribed: true,
    expiresAt: Date.now() + 60_000,
  });
  return true;
}

async function requireSubscription(
  chatId: number,
  userId: number,
): Promise<boolean> {
  if (await isSubscribed(userId)) {
    return true;
  }

  await sendText(
    chatId,
    [
      "Botdan foydalanish uchun avval kanal va muhokama chatiga obuna bo‘ling.",
      "",
      "Obuna bo‘lgach, «✅ Tekshirish» tugmasini bosing.",
    ].join("\n"),
    getSubscriptionKeyboard(),
  );
  return false;
}

function getStartKeyboard(): ReplyMarkup {
  const rows: InlineKeyboardButton[][] = [
    [
      { text: "🎬 Katalog", callback_data: "catalog" },
      { text: "🔍 Qidirish", callback_data: "search:help" },
    ],
  ];
  const discussionUrl = getDiscussionUrl();
  if (discussionUrl) {
    rows.push([{ text: "💬 Muhokama chati", url: discussionUrl }]);
  }
  return { inline_keyboard: rows };
}

async function configureBotCommands(): Promise<void> {
  await telegramApi("setMyCommands", {
    commands: [
      { command: "start", description: "Botni boshlash" },
      { command: "catalog", description: "Katalogni ko‘rish" },
      { command: "search", description: "Kino nomi bo‘yicha qidirish" },
    ],
  });

  const adminCommands = [
    { command: "start", description: "Botni boshlash" },
    { command: "catalog", description: "Katalogni ko‘rish" },
    { command: "search", description: "Kino nomi bo‘yicha qidirish" },
    { command: "add", description: "Kanal postidan kino qo‘shish" },
    { command: "addpost", description: "Kinoga qo‘shimcha post qo‘shish" },
    { command: "addseries", description: "Serial yoki ko‘p qismli kino yaratish" },
    { command: "addpart", description: "Serial qismi qo‘shish" },
    { command: "genre", description: "Kino janrini belgilash" },
    { command: "setstart", description: "Start videosini o‘rnatish" },
    { command: "setstructure", description: "Avto-yangilanadigan postni sozlash" },
    { command: "delete", description: "Kino kodini o‘chirish" },
    { command: "deleteseries", description: "Serialni o‘chirish" },
    { command: "list", description: "Kinolar ro‘yxati" },
  ];

  for (const adminId of getAdminIds()) {
    const chatId = Number(adminId);
    if (!Number.isSafeInteger(chatId)) {
      logger.warn({ adminId }, "Skipping invalid Telegram admin ID");
      continue;
    }

    try {
      await telegramApi("setMyCommands", {
        commands: adminCommands,
        scope: { type: "chat", chat_id: chatId },
      });
    } catch (err: unknown) {
      logger.error({ err, adminId }, "Failed to configure admin commands");
    }
  }
}

function normalizeCode(value: string): string {
  return value.trim().replace(/^#/, "").toUpperCase();
}

function commandParts(text: string): { command: string; args: string } {
  const [rawCommand, ...rest] = text.trim().split(/\s+/);
  return {
    command: rawCommand.toLowerCase().split("@")[0],
    args: rest.join(" ").trim(),
  };
}

function formatMovieList(): string {
  const movies = listMovies();
  const series = listSeries();
  if (movies.length === 0 && series.length === 0) {
    return "Hozircha bazada kino yo‘q.";
  }

  return [
    "MedFlix bazasi:",
    "",
    "Kinolar:",
    ...movies.map((movie) => `${movie.code} — ${movie.title}`),
    "",
    "Seriallar va ko‘p qismli kinolar:",
    ...series.map(
      (item) => `${item.code} — ${item.title} (${item.episodeCount} qism)`,
    ),
  ].join("\n");
}

function movieKeyboard(movies: ReturnType<typeof listMovies>): ReplyMarkup | undefined {
  if (movies.length === 0) {
    return undefined;
  }

  return {
    inline_keyboard: movies.slice(0, 25).map((movie) => [
      {
        text: `${movie.code} — ${movie.title}`.slice(0, 64),
        callback_data: `movie:${encodeCallbackValue(movie.code)}`,
      },
    ]),
  };
}

function seriesKeyboard(series: ReturnType<typeof listSeries>): ReplyMarkup | undefined {
  if (series.length === 0) {
    return undefined;
  }

  return {
    inline_keyboard: series.slice(0, 25).map((item) => [
      {
        text: `📺 ${item.code} — ${item.title} (${item.seasonCount} fasl, ${item.episodeCount} qism)`.slice(0, 64),
        callback_data: `series:${encodeCallbackValue(item.code)}`,
      },
    ]),
  };
}

function genreKeyboard(): ReplyMarkup | undefined {
  const genres = listGenres();
  if (genres.length === 0) {
    return undefined;
  }

  return {
    inline_keyboard: genres.slice(0, 20).map((genre) => [
      {
        text: `${genre.name} (${genre.movieCount})`.slice(0, 64),
        callback_data: `genre:${encodeCallbackValue(genre.name)}`,
      },
    ]),
  };
}

function catalogKeyboard(
  movies: ReturnType<typeof listMovies>,
  series: ReturnType<typeof listSeries>,
): ReplyMarkup | undefined {
  const rows = [
    ...(genreKeyboard()?.inline_keyboard ?? []),
    ...(movieKeyboard(movies)?.inline_keyboard ?? []),
    ...(seriesKeyboard(series)?.inline_keyboard ?? []),
  ];

  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

async function sendCatalog(chatId: number): Promise<void> {
  const movies = listMovies();
  const series = listSeries();
  const genres = listGenres();
  const lines = [
    "🎬 MedFlix katalogi",
    "",
    `Kinolar: ${movies.length} ta`,
    `Seriallar: ${series.length} ta`,
  ];

  if (genres.length > 0 || series.length > 0 || movies.length > 0) {
    lines.push("", "Kerakli janr, kino yoki serialni tanlang.");
  } else {
    lines.push("", "Katalog hozircha bo‘sh.");
  }

  await sendText(
    chatId,
    lines.join("\n"),
    catalogKeyboard(movies, series),
  );
}

async function sendMovieResults(
  chatId: number,
  movies: ReturnType<typeof listMovies>,
  heading: string,
): Promise<void> {
  if (movies.length === 0) {
    await sendText(chatId, "Kino topilmadi. Kod yoki nomni tekshirib qayta yuboring.");
    return;
  }

  await sendText(chatId, heading, movieKeyboard(movies));
}

async function sendSeriesEpisodes(
  chatId: number,
  seriesCode: string,
): Promise<void> {
  const series = findSeries(seriesCode);
  if (!series) {
    await sendText(chatId, "Serial kodi bazada topilmadi.");
    return;
  }

  const episodes = listSeriesEpisodes(seriesCode);
  if (episodes.length === 0) {
    await sendText(chatId, `${series.title} uchun hali qism qo‘shilmagan.`);
    return;
  }

  const seasons = listSeriesSeasons(seriesCode);
  if (seasons.length > 1) {
    await sendText(
      chatId,
      [
        `📺 ${series.title}`,
        `Fasllar soni: ${seasons.length}`,
        "Ko‘rish uchun faslni tanlang:",
      ].join("\n"),
      {
        inline_keyboard: seasons.map((seasonNumber) => [
          {
            text: `${seasonNumber}-fasl`,
            callback_data: `season:${encodeCallbackValue(series.code)}:${seasonNumber}`,
          },
        ]),
      },
    );
    return;
  }

  await sendSeriesSeasonEpisodes(chatId, series.code, seasons[0] ?? 1);
}

async function sendSeriesSeasonEpisodes(
  chatId: number,
  seriesCode: string,
  seasonNumber: number,
): Promise<void> {
  const series = findSeries(seriesCode);
  if (!series) {
    await sendText(chatId, "Serial kodi bazada topilmadi.");
    return;
  }

  const episodes = listSeriesEpisodes(seriesCode, seasonNumber);
  if (episodes.length === 0) {
    await sendText(
      chatId,
      `${series.title} ${seasonNumber}-faslida hali qism qo‘shilmagan.`,
    );
    return;
  }

  await sendText(
    chatId,
    [
      `📺 ${series.title}`,
      `Kod: ${series.code}`,
      `${seasonNumber}-fasl — ${episodes.length} ta qism`,
      "",
      "Ko‘rish uchun qismni tanlang:",
    ].join("\n"),
    {
      inline_keyboard: episodes.slice(0, 50).map((episode) => [
        {
          text: `${episode.episodeNumber}-qism${episode.title ? ` — ${episode.title}` : ""}`.slice(
            0,
            64,
          ),
          callback_data: `episode:${encodeCallbackValue(series.code)}:${seasonNumber}:${episode.episodeNumber}`,
        },
      ]),
    },
  );
}

async function sendSeriesResults(
  chatId: number,
  series: ReturnType<typeof listSeries>,
  heading: string,
): Promise<void> {
  if (series.length === 0) {
    return;
  }

  await sendText(chatId, heading, seriesKeyboard(series));
}

async function deliverChannelPost(
  chatId: number,
  reference: {
    code: string;
    channelChatId: string;
    channelMessageId: number;
  },
  kind: "Kino" | "Qism",
): Promise<void> {
  try {
    const discussionUrl = getDiscussionUrl();
    await telegramApi("copyMessage", {
      chat_id: chatId,
      from_chat_id: reference.channelChatId,
      message_id: reference.channelMessageId,
      ...(discussionUrl
        ? {
            reply_markup: {
              inline_keyboard: [[
                { text: "💬 Muhokama qilish", url: discussionUrl },
              ]],
            },
          }
        : {}),
    });
  } catch (err: unknown) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        err,
        code: reference.code,
        channelChatId: reference.channelChatId,
        channelMessageId: reference.channelMessageId,
      },
      `Failed to copy ${kind.toLowerCase()} message`,
    );

    let userMessage =
      `${kind} topildi, lekin kanal postini yuborib bo‘lmadi. Bot manba kanalga qo‘shilganini tekshiring.`;
    if (errorText.includes("message to copy not found")) {
      userMessage =
        `${kind} bazada bor, lekin kanal postining ID raqami topilmadi. Postni botga forward qilib, qaytadan qo‘shing.`;
    } else if (errorText.includes("chat not found")) {
      userMessage =
        "Kanal topilmadi. Forward orqali qaytadan /add qiling yoki kanal ID sini tekshiring.";
    } else if (
      errorText.includes("not enough rights") ||
      errorText.includes("bot is not a member")
    ) {
      userMessage =
        "Bot manba kanalga qo‘shilmagan yoki yetarli huquqqa ega emas. Botni kanalga admin qilib qo‘shing.";
    }

    await sendText(chatId, userMessage);
  }
}

async function deliverMovie(
  chatId: number,
  movie: ReturnType<typeof findMovie>,
): Promise<void> {
  if (!movie) {
    await sendText(chatId, "Bu kino bazada topilmadi.");
    return;
  }

  const posts = listMoviePosts(movie.code);
  const references =
    posts.length > 0
      ? posts
      : [
          {
            channelChatId: movie.channelChatId,
            channelMessageId: movie.channelMessageId,
          },
        ];

  for (const post of references) {
    await deliverChannelPost(
      chatId,
      {
        code: movie.code,
        channelChatId: post.channelChatId,
        channelMessageId: post.channelMessageId,
      },
      "Kino",
    );
  }
}

async function deliverSeriesEpisode(
  chatId: number,
  seriesCode: string,
  seasonNumber: number,
  episodeNumber: number,
): Promise<void> {
  const episode = findSeriesEpisode(seriesCode, seasonNumber, episodeNumber);
  if (!episode) {
    await sendText(chatId, "Bu serial qismi bazada topilmadi.");
    return;
  }

  await deliverChannelPost(
    chatId,
    {
      code: `${seriesCode}-${episodeNumber}`,
      channelChatId: episode.channelChatId,
      channelMessageId: episode.channelMessageId,
    },
    "Qism",
  );
}

function getStartVideoReference(): {
  channelChatId: string;
  channelMessageId: number;
} | null {
  const channelChatId = getSetting("start_channel_chat_id");
  const channelMessageId = Number(getSetting("start_channel_message_id"));

  if (
    !channelChatId ||
    !Number.isInteger(channelMessageId) ||
    channelMessageId <= 0
  ) {
    return null;
  }

  return { channelChatId, channelMessageId };
}

function getForwardedChannelPost(
  message: TelegramMessage,
): { channelChatId: string; channelMessageId: number } | null {
  const origin = message.forward_origin;
  const originMessageId = origin?.message_id;
  if (
    origin?.type === "channel" &&
    origin.chat?.id !== undefined &&
    typeof originMessageId === "number" &&
    Number.isInteger(originMessageId) &&
    originMessageId > 0
  ) {
    return {
      channelChatId: String(origin.chat.id),
      channelMessageId: originMessageId,
    };
  }

  const legacyMessageId = message.forward_from_message_id;
  if (
    message.forward_from_chat?.id !== undefined &&
    typeof legacyMessageId === "number" &&
    Number.isInteger(legacyMessageId) &&
    legacyMessageId > 0
  ) {
    return {
      channelChatId: String(message.forward_from_chat.id),
      channelMessageId: legacyMessageId,
    };
  }

  return null;
}

async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

async function handleCallbackQuery(
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  const chatId = message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data ?? "";

  if (data === "subscription:check") {
    subscriptionCache.delete(userId);
    if (await isSubscribed(userId)) {
      await answerCallbackQuery(callbackQuery.id, "Obuna tasdiqlandi.");
      await sendText(
        chatId,
        "Rahmat. Endi kino kodi yoki nomini yuborishingiz mumkin.",
        getStartKeyboard(),
      );
    } else {
      await answerCallbackQuery(
        callbackQuery.id,
        "Hali barcha kanallarga obuna bo‘lmagansiz.",
      );
      await sendText(
        chatId,
        "Iltimos, barcha ko‘rsatilgan kanal va chatlarga obuna bo‘lib, qayta tekshiring.",
        getSubscriptionKeyboard(),
      );
    }
    return;
  }

  if (!(await requireSubscription(chatId, userId))) {
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  await answerCallbackQuery(callbackQuery.id);

  if (data === "catalog") {
    await sendCatalog(chatId);
    return;
  }

  if (data === "search:help") {
    await sendText(
      chatId,
      "Kino kodini yoki nomini yuboring. Masalan: 101 yoki Interstellar",
    );
    return;
  }

  if (data.startsWith("genre:")) {
    const genreName = decodeCallbackValue(data.slice("genre:".length));
    if (!genreName) {
      await sendText(chatId, "Janr ma’lumotini o‘qib bo‘lmadi.");
      return;
    }

    const movies = listMoviesByGenre(genreName);
    await sendMovieResults(
      chatId,
      movies,
      `${genreName} janridagi materiallar:`,
    );
    return;
  }

  if (data.startsWith("movie:")) {
    const code = decodeCallbackValue(data.slice("movie:".length));
    if (!code) {
      await sendText(chatId, "Kino kodi ma’lumotini o‘qib bo‘lmadi.");
      return;
    }
    await deliverMovie(chatId, findMovie(code));
    return;
  }

  if (data.startsWith("series:")) {
    const code = decodeCallbackValue(data.slice("series:".length));
    if (!code) {
      await sendText(chatId, "Serial kodi ma’lumotini o‘qib bo‘lmadi.");
      return;
    }
    await sendSeriesEpisodes(chatId, code);
    return;
  }

  if (data.startsWith("season:")) {
    const payload = data.slice("season:".length);
    const separatorIndex = payload.lastIndexOf(":");
    const code = decodeCallbackValue(
      separatorIndex >= 0 ? payload.slice(0, separatorIndex) : "",
    );
    const seasonNumber = Number(
      separatorIndex >= 0 ? payload.slice(separatorIndex + 1) : "",
    );
    if (
      !code ||
      !Number.isInteger(seasonNumber) ||
      seasonNumber <= 0
    ) {
      await sendText(chatId, "Serial fasli ma’lumotini o‘qib bo‘lmadi.");
      return;
    }
    await sendSeriesSeasonEpisodes(chatId, code, seasonNumber);
    return;
  }

  if (data.startsWith("episode:")) {
    const payload = data.slice("episode:".length);
    const episodeSeparatorIndex = payload.lastIndexOf(":");
    const seasonPayload = payload.slice(0, episodeSeparatorIndex);
    const seasonSeparatorIndex = seasonPayload.lastIndexOf(":");
    const code = decodeCallbackValue(
      seasonSeparatorIndex >= 0
        ? seasonPayload.slice(0, seasonSeparatorIndex)
        : "",
    );
    const seasonNumber = Number(
      seasonSeparatorIndex >= 0
        ? seasonPayload.slice(seasonSeparatorIndex + 1)
        : "",
    );
    const episodeNumber = Number(
      episodeSeparatorIndex >= 0
        ? payload.slice(episodeSeparatorIndex + 1)
        : "",
    );
    if (
      !code ||
      !Number.isInteger(seasonNumber) ||
      seasonNumber <= 0 ||
      !Number.isInteger(episodeNumber) ||
      episodeNumber <= 0
    ) {
      await sendText(chatId, "Serial qismi ma’lumotini o‘qib bo‘lmadi.");
      return;
    }
    await deliverSeriesEpisode(chatId, code, seasonNumber, episodeNumber);
  }
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = (message.text ?? message.caption)?.trim() ?? "";

  if (!userId) {
    return;
  }

  const forwardedPost = getForwardedChannelPost(message);
  if (forwardedPost && isAdmin(userId) && !text.startsWith("/")) {
    pendingForwardedPosts.set(String(userId), forwardedPost);
    await sendText(
      chatId,
      [
        "Kanal posti qabul qilindi.",
        `Kanal ID: ${forwardedPost.channelChatId}`,
        `Post ID: ${forwardedPost.channelMessageId}`,
        "",
        "Endi shu chatga quyidagicha yuboring:",
        "/add KOD | Kino nomi",
        "/addpost KOD | 2 | Kino fayli",
        "/addpart SERIAL_KOD | FASL | QISM | Qism nomi",
        "yoki /setstart — shu postni start videosi qilish",
        "",
        "Masalan: /add 101 | Interstellar",
      ].join("\n"),
    );
    return;
  }

  if (!text) {
    return;
  }

  if (!isAdmin(userId) && !(await requireSubscription(chatId, userId))) {
    return;
  }

  if (text.startsWith("/")) {
    const { command, args } = commandParts(text);

    if (command === "/start" || command === "/help") {
      const welcomeLines = [
        "Kino botga xush kelibsiz.",
        "",
        "Kino ko‘rish uchun kino kodini yuboring.",
        "Masalan: 101",
      ];

      if (isAdmin(userId)) {
        welcomeLines.push(
          "",
          "Admin bo‘limi:",
          "1) Kanal postini botga forward qiling",
          "2) /add KOD | Kino nomi — 1-post",
          "3) /addpost KOD | 2 | Kino fayli — qo‘shimcha post",
          "4) /addseries KOD | Serial nomi",
          "5) Har bir serial posti uchun /addpart KOD | FASL | QISM | Nomi",
          "6) /setstart — start videosini o‘rnatish",
          "7) /setstructure POST_LINK — struktura postini sozlash",
          "/delete KOD",
          "/deleteseries KOD",
          "/list",
        );
      }

      const startVideo = getStartVideoReference();
      if (startVideo) {
        try {
          await telegramApi("copyMessage", {
            chat_id: chatId,
            from_chat_id: startVideo.channelChatId,
            message_id: startVideo.channelMessageId,
          });
        } catch (err: unknown) {
          logger.error(
            { err, chatId, ...startVideo },
            "Failed to copy start video",
          );
        }
      }

      await sendText(chatId, welcomeLines.join("\n"), getStartKeyboard());
      return;
    }

    if (command === "/id") {
      await sendText(
        chatId,
        [
          `Sizning Telegram ID raqamingiz: ${userId}`,
          `Admin holati: ${isAdmin(userId) ? "tasdiqlangan" : "tasdiqlanmagan"}`,
        ].join("\n"),
      );
      return;
    }

    if (command === "/catalog") {
      await sendCatalog(chatId);
      return;
    }

    if (command === "/search") {
      if (!args) {
        await sendText(
          chatId,
          "Qidirish uchun kino kodini yoki nomini yuboring. Masalan: /search Interstellar",
        );
        return;
      }

      const exactSeries = findSeries(normalizeCode(args));
      if (exactSeries) {
        await sendSeriesEpisodes(chatId, exactSeries.code);
        return;
      }

      const exactMovie = findMovie(normalizeCode(args));
      if (exactMovie) {
        await deliverMovie(chatId, exactMovie);
        return;
      }

      const seriesMatches = searchSeries(args);
      if (seriesMatches.length > 0) {
        await sendSeriesResults(
          chatId,
          seriesMatches,
          `«${args}» bo‘yicha seriallar:`,
        );
      }

      await sendMovieResults(
        chatId,
        searchMovies(args),
        `«${args}» bo‘yicha qidiruv natijalari:`,
      );
      return;
    }

    if (!userId || !isAdmin(userId)) {
      if (
        command === "/add" ||
        command === "/addpost" ||
        command === "/addseries" ||
        command === "/addpart" ||
        command === "/genre" ||
        command === "/setstart" ||
        command === "/setstructure" ||
        command === "/delete" ||
        command === "/deleteseries" ||
        command === "/list"
      ) {
        await sendText(
          chatId,
          "Bu buyruq faqat admin uchun. Admin ID sozlanmagan bo‘lsa, TELEGRAM_ADMIN_IDS secretini kiriting.",
        );
      }
      return;
    }

    if (command === "/setstart") {
      const startVideo =
        getForwardedChannelPost(message.reply_to_message ?? message) ??
        pendingForwardedPosts.get(String(userId));

      if (!startVideo) {
        await sendText(
          chatId,
          [
            "Start videosini o‘rnatish uchun:",
            "1. Kanal video postini shu botga forward qiling.",
            "2. /setstart yuboring.",
          ].join("\n"),
        );
        return;
      }

      setSetting("start_channel_chat_id", startVideo.channelChatId);
      setSetting(
        "start_channel_message_id",
        String(startVideo.channelMessageId),
      );
      pendingForwardedPosts.delete(String(userId));
      await refreshStructurePost();
      await sendText(
        chatId,
        "Start videosi saqlandi. Endi foydalanuvchi /start yuborganda shu video chiqadi.",
      );
      return;
    }

    if (command === "/setstructure") {
      const reference = parseTelegramPostLink(args);
      if (!reference) {
        const currentReference = getStructurePostReference();
        await sendText(
          chatId,
          [
            "Format: /setstructure POST_LINK",
            `Joriy struktura posti: ${formatTelegramPostLink(currentReference)}`,
            "Masalan: /setstructure https://t.me/MF_Base/17",
            "",
            "Bot target kanalda postlarni tahrirlash huquqiga ega bo‘lishi kerak.",
          ].join("\n"),
        );
        return;
      }

      setSetting("structure_post_chat_id", reference.chatId);
      setSetting("structure_post_message_id", String(reference.messageId));
      const updated = await refreshStructurePost();
      await sendText(
        chatId,
        updated
          ? `Struktura posti sozlandi va yangilandi: ${reference.chatId}/${reference.messageId}`
          : "Post manzili saqlandi, lekin hozircha tahrirlab bo‘lmadi. Botning kanal huquqlarini tekshiring.",
      );
      return;
    }

    if (command === "/addseries") {
      const [rawCode, rawTitle] = args
        .split("|")
        .map((value) => value.trim());
      const code = normalizeCode(rawCode ?? "");
      const title = rawTitle ?? "";

      if (!code || !title) {
        await sendText(
          chatId,
          [
            "Format: /addseries KOD | Serial nomi",
            "Masalan: /addseries DH | Dr. House",
            "Bu format serial va bir nechta postli kinolar uchun ham ishlaydi.",
          ].join("\n"),
        );
        return;
      }

      if (findMovie(code)) {
        await sendText(
          chatId,
          `${code} kodi oddiy kino sifatida mavjud. Serial uchun boshqa kod tanlang.`,
        );
        return;
      }

      const series = upsertSeries({ code, title });
      await refreshStructurePost();
      await sendText(
        chatId,
        `${series.code} — ${series.title} seriali yaratildi. Endi postlarni forward qilib /addpart yuboring.`,
      );
      return;
    }

    if (command === "/addpart") {
      const partArgs = args.split("|").map((value) => value.trim());
      const [rawCode, rawSeasonOrEpisode, rawEpisodeOrTitle, rawPartTitle] =
        partArgs;
      const code = normalizeCode(rawCode ?? "");
      const hasSeason = partArgs.length >= 4;
      const seasonNumber = Number(hasSeason ? rawSeasonOrEpisode : 1);
      const episodeNumber = Number(
        hasSeason ? rawEpisodeOrTitle : rawSeasonOrEpisode,
      );
      const title = hasSeason ? rawPartTitle ?? "" : rawEpisodeOrTitle ?? "";
      const referencedForward =
        getForwardedChannelPost(message.reply_to_message ?? message) ??
        pendingForwardedPosts.get(String(userId));

      if (
        !code ||
        !Number.isInteger(seasonNumber) ||
        seasonNumber <= 0 ||
        !Number.isInteger(episodeNumber) ||
        episodeNumber <= 0 ||
        !referencedForward
      ) {
        await sendText(
          chatId,
          [
            "Yangi format: /addpart SERIAL_KOD | FASL | QISM | Qism nomi",
            "Eski format: /addpart SERIAL_KOD | QISM | Qism nomi (1-fasl)",
            "1. Serial yarating: /addseries DH | Dr. House",
            "2. Kanal postini botga forward qiling.",
            "3. /addpart DH | 1 | 1 | 1-qism",
          ].join("\n"),
        );
        return;
      }

      if (!findSeries(code)) {
        await sendText(
          chatId,
          `${code} seriali topilmadi. Avval /addseries ${code} | Serial nomi yuboring.`,
        );
        return;
      }

      const episode = upsertSeriesEpisode({
        seriesCode: code,
        seasonNumber,
        episodeNumber,
        title,
        channelChatId: referencedForward.channelChatId,
        channelMessageId: referencedForward.channelMessageId,
      });
      if (!episode) {
        await sendText(chatId, "Serial qismini saqlab bo‘lmadi.");
        return;
      }

      pendingForwardedPosts.delete(String(userId));
      await refreshStructurePost();
      await sendText(
        chatId,
        `${code} serialining ${seasonNumber}-fasl ${episodeNumber}-qismi bazaga saqlandi.`,
      );
      return;
    }

    if (command === "/list") {
      await sendText(chatId, formatMovieList());
      return;
    }

    if (command === "/genre") {
      const [rawCode, rawGenres] = args
        .split("|")
        .map((value) => value.trim());
      const code = normalizeCode(rawCode ?? "");
      const genres = (rawGenres ?? "")
        .split(",")
        .map((genre) => genre.trim())
        .filter(Boolean);

      if (!code || genres.length === 0) {
        await sendText(
          chatId,
          [
            "Format: /genre KOD | Janr 1, Janr 2",
            "Masalan: /genre 101 | Tibbiy drama, Serial",
          ].join("\n"),
        );
        return;
      }

      if (!setMovieGenres(code, genres)) {
        await sendText(chatId, `${code} kodi topilmadi.`);
        return;
      }

      await refreshStructurePost();
      await sendText(
        chatId,
        `${code} kodi uchun janrlar saqlandi: ${genres.join(", ")}`,
      );
      return;
    }

    if (command === "/delete") {
      const code = normalizeCode(args);
      if (!code) {
        await sendText(chatId, "Format: /delete KOD");
        return;
      }

      const deleted = deleteMovie(code);
      if (deleted) {
        await refreshStructurePost();
      }
      await sendText(
        chatId,
        deleted
          ? `${code} kodi o‘chirildi.`
          : `${code} kodi topilmadi.`,
      );
      return;
    }

    if (command === "/deleteseries") {
      const code = normalizeCode(args);
      if (!code) {
        await sendText(chatId, "Format: /deleteseries SERIAL_KOD");
        return;
      }

      const deleted = deleteSeries(code);
      if (deleted) {
        await refreshStructurePost();
      }
      await sendText(
        chatId,
        deleted
          ? `${code} seriali va uning barcha qismlari o‘chirildi.`
          : `${code} seriali topilmadi.`,
      );
      return;
    }

    if (command === "/add") {
      const [rawCode, rawTitle, rawChatId, rawMessageId] = args
        .split("|")
        .map((value) => value.trim());
      const code = normalizeCode(rawCode ?? "");
      const title = rawTitle ?? "";
      const referencedForward =
        getForwardedChannelPost(message.reply_to_message ?? message) ??
        pendingForwardedPosts.get(String(userId));
      const channelChatId = rawChatId || referencedForward?.channelChatId || "";
      const channelMessageId =
        Number(rawMessageId) || referencedForward?.channelMessageId || 0;

      if (
        !code ||
        !title ||
        !channelChatId ||
        !Number.isInteger(channelMessageId) ||
        channelMessageId <= 0 ||
        (rawChatId && !rawMessageId)
      ) {
        await sendText(
          chatId,
          [
            "Format noto‘g‘ri.",
            "Tavsiya etilgan usul:",
            "1. Kanal postini botga forward qiling.",
            "2. /add 101 | Interstellar",
            "",
            "Eski usul:",
            "/add 101 | Interstellar | -1001234567890 | 42",
          ].join("\n"),
        );
        return;
      }

      const movie = upsertMovie({
        code,
        title,
        channelChatId,
        channelMessageId,
      });
      pendingForwardedPosts.delete(String(userId));
      await refreshStructurePost();
      await sendText(chatId, `${movie.code} — ${movie.title} bazaga saqlandi.`);
      return;
    }

    if (command === "/addpost") {
      const [rawCode, rawPostNumber, rawTitle] = args
        .split("|")
        .map((value) => value.trim());
      const code = normalizeCode(rawCode ?? "");
      const postNumber = Number(rawPostNumber);
      const title = rawTitle ?? "";
      const referencedForward =
        getForwardedChannelPost(message.reply_to_message ?? message) ??
        pendingForwardedPosts.get(String(userId));

      if (
        !code ||
        !Number.isInteger(postNumber) ||
        postNumber <= 1 ||
        !referencedForward
      ) {
        await sendText(
          chatId,
          [
            "Format: /addpost KOD | TARTIB | Izoh",
            "Avval 1-postni /add bilan saqlang.",
            "Keyin kanal postini forward qilib yuboring.",
            "Masalan: /addpost 101 | 2 | Kino fayli",
          ].join("\n"),
        );
        return;
      }

      if (!findMovie(code)) {
        await sendText(
          chatId,
          `${code} kodi topilmadi. Avval poster yoki birinchi postni /add orqali saqlang.`,
        );
        return;
      }

      const post = upsertMoviePost({
        movieCode: code,
        postNumber,
        title,
        channelChatId: referencedForward.channelChatId,
        channelMessageId: referencedForward.channelMessageId,
      });
      if (!post) {
        await sendText(chatId, "Kino postini saqlab bo‘lmadi.");
        return;
      }

      pendingForwardedPosts.delete(String(userId));
      await refreshStructurePost();
      await sendText(
        chatId,
        `${code} kodi uchun ${postNumber}-post saqlandi. Kod yuborilganda barcha postlar tartib bilan yuboriladi.`,
      );
      return;
    }

    return;
  }

  const code = normalizeCode(text);
  const series = findSeries(code);
  if (series) {
    await sendSeriesEpisodes(chatId, series.code);
    return;
  }

  const movie = findMovie(code);
  if (movie) {
    await deliverMovie(chatId, movie);
    return;
  }

  const seriesMatches = searchSeries(text);
  if (seriesMatches.length === 1) {
    await sendSeriesEpisodes(chatId, seriesMatches[0].code);
    return;
  }

  if (seriesMatches.length > 1) {
    await sendSeriesResults(
      chatId,
      seriesMatches,
      `«${text}» bo‘yicha seriallar:`,
    );
  }

  const matches = searchMovies(text);
  if (matches.length === 1) {
    await deliverMovie(chatId, matches[0]);
    return;
  }

  await sendMovieResults(
    chatId,
    matches,
    matches.length > 1
      ? `«${text}» bo‘yicha topilgan materiallar:`
      : "Bu kod yoki nom bo‘yicha kino topilmadi. Qayta tekshirib ko‘ring.",
  );
}

async function poll(): Promise<void> {
  let offset = Number(getSetting("telegram_update_offset") ?? "0");

  while (true) {
    try {
      const updates = await telegramApi<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        setSetting("telegram_update_offset", String(offset));
        if (update.message) {
          await handleMessage(update.message);
        }
        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        }
      }
    } catch (err: unknown) {
      logger.error({ err }, "Telegram polling error");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

export async function startTelegramBot(): Promise<void> {
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN is not set; Telegram bot is disabled");
    return;
  }

  await telegramApi("deleteWebhook", { drop_pending_updates: false });
  const bot = await telegramApi<{ username?: string }>("getMe", {});
  await configureBotCommands();
  await refreshStructurePost();
  logger.info({ username: bot.username }, "Telegram bot connected");
  void poll();
}