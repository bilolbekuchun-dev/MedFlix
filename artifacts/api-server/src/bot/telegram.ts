import {
  deleteMovie,
  findMovie,
  getSetting,
  listMovies,
  listGenres,
  listMoviesByGenre,
  setSetting,
  setMovieGenres,
  searchMovies,
  upsertMovie,
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
    { command: "genre", description: "Kino janrini belgilash" },
    { command: "setstart", description: "Start videosini o‘rnatish" },
    { command: "delete", description: "Kino kodini o‘chirish" },
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
  if (movies.length === 0) {
    return "Hozircha bazada kino yo‘q.";
  }

  return [
    "Kinolar ro‘yxati:",
    ...movies.map((movie) => `${movie.code} — ${movie.title}`),
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
): ReplyMarkup | undefined {
  const rows = [
    ...(genreKeyboard()?.inline_keyboard ?? []),
    ...(movieKeyboard(movies)?.inline_keyboard ?? []),
  ];

  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

async function sendCatalog(chatId: number): Promise<void> {
  const movies = listMovies();
  const genres = listGenres();
  const lines = [
    "🎬 MedFlix katalogi",
    "",
    movies.length > 0
      ? `Jami: ${movies.length} ta material`
      : "Katalog hozircha bo‘sh.",
  ];

  if (genres.length > 0) {
    lines.push("", "Janr bo‘yicha ko‘rish uchun tugmani tanlang.");
  }

  await sendText(
    chatId,
    lines.join("\n"),
    catalogKeyboard(movies),
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

async function deliverMovie(
  chatId: number,
  movie: ReturnType<typeof findMovie>,
): Promise<void> {
  if (!movie) {
    await sendText(chatId, "Bu kino bazada topilmadi.");
    return;
  }

  try {
    const discussionUrl = getDiscussionUrl();
    await telegramApi("copyMessage", {
      chat_id: chatId,
      from_chat_id: movie.channelChatId,
      message_id: movie.channelMessageId,
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
        code: movie.code,
        channelChatId: movie.channelChatId,
        channelMessageId: movie.channelMessageId,
      },
      "Failed to copy movie message",
    );

    let userMessage =
      "Kino topildi, lekin kanal postini yuborib bo‘lmadi. Bot manba kanalga qo‘shilganini tekshiring.";
    if (errorText.includes("message to copy not found")) {
      userMessage =
        "Kino kodi bazada bor, lekin kanal postining ID raqami topilmadi. Postni botga forward qilib, qaytadan /add qiling.";
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
          "2) /add KOD | Kino nomi",
          "3) /setstart — start videosini o‘rnatish",
          "/delete KOD",
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

      const exactMovie = findMovie(normalizeCode(args));
      if (exactMovie) {
        await deliverMovie(chatId, exactMovie);
        return;
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
        command === "/genre" ||
        command === "/setstart" ||
        command === "/delete" ||
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
      await sendText(
        chatId,
        "Start videosi saqlandi. Endi foydalanuvchi /start yuborganda shu video chiqadi.",
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

      await sendText(
        chatId,
        deleteMovie(code)
          ? `${code} kodi o‘chirildi.`
          : `${code} kodi topilmadi.`,
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
      await sendText(chatId, `${movie.code} — ${movie.title} bazaga saqlandi.`);
      return;
    }

    return;
  }

  const code = normalizeCode(text);
  const movie = findMovie(code);
  if (movie) {
    await deliverMovie(chatId, movie);
    return;
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
  logger.info({ username: bot.username }, "Telegram bot connected");
  void poll();
}