import {
  deleteMovie,
  findMovie,
  getSetting,
  listMovies,
  setSetting,
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

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

const token = process.env.TELEGRAM_BOT_TOKEN;
const pendingForwardedPosts = new Map<
  string,
  { channelChatId: string; channelMessageId: number }
>();

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

async function sendText(chatId: number, text: string): Promise<void> {
  await telegramApi("sendMessage", { chat_id: chatId, text });
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

async function configureBotCommands(): Promise<void> {
  await telegramApi("setMyCommands", {
    commands: [
      { command: "start", description: "Botni boshlash" },
    ],
  });

  const adminCommands = [
    { command: "start", description: "Botni boshlash" },
    { command: "add", description: "Kanal postidan kino qo‘shish" },
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
        "",
        "Masalan: /add 101 | Interstellar",
      ].join("\n"),
    );
    return;
  }

  if (!text) {
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
          "/delete KOD",
          "/list",
        );
      }

      await sendText(
        chatId,
        welcomeLines.join("\n"),
      );
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

    if (!userId || !isAdmin(userId)) {
      if (command === "/add" || command === "/delete" || command === "/list") {
        await sendText(
          chatId,
          "Bu buyruq faqat admin uchun. Admin ID sozlanmagan bo‘lsa, TELEGRAM_ADMIN_IDS secretini kiriting.",
        );
      }
      return;
    }

    if (command === "/list") {
      await sendText(chatId, formatMovieList());
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
  if (!movie) {
    await sendText(chatId, "Bu kod bo‘yicha kino topilmadi. Kodni tekshirib qayta yuboring.");
    return;
  }

  try {
    await telegramApi("copyMessage", {
      chat_id: chatId,
      from_chat_id: movie.channelChatId,
      message_id: movie.channelMessageId,
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

    await sendText(
      chatId,
      userMessage,
    );
  }
}

async function poll(): Promise<void> {
  let offset = Number(getSetting("telegram_update_offset") ?? "0");

  while (true) {
    try {
      const updates = await telegramApi<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        setSetting("telegram_update_offset", String(offset));
        if (update.message) {
          await handleMessage(update.message);
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