import { findMovie, getSetting, listMovies, setSetting, deleteMovie, upsertMovie } from "./database";
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
};

type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminIds = new Set(
  (process.env.TELEGRAM_ADMIN_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

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
  return adminIds.has(String(userId));
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

async function handleMessage(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = message.text?.trim();

  if (!text) {
    return;
  }

  if (text.startsWith("/")) {
    const { command, args } = commandParts(text);

    if (command === "/start" || command === "/help") {
      await sendText(
        chatId,
        [
          "Kino botga xush kelibsiz.",
          "",
          "Kino kodini yuboring — bot kanal postidagi videoni shu yerga yuboradi.",
          "",
          "Buyruqlar:",
          "/id — Telegram ID raqamingizni ko‘rsatish",
          "/help — yordam",
          ...(userId && isAdmin(userId)
            ? [
                "",
                "Admin buyruqlari:",
                "/add KOD | Nomi | Kanal ID | Post ID",
                "/delete KOD",
                "/list",
              ]
            : []),
        ].join("\n"),
      );
      return;
    }

    if (command === "/id") {
      await sendText(chatId, `Sizning Telegram ID raqamingiz: ${userId ?? "noma’lum"}`);
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
      const channelChatId = rawChatId ?? "";
      const channelMessageId = Number(rawMessageId);

      if (
        !code ||
        !title ||
        !channelChatId ||
        !Number.isInteger(channelMessageId) ||
        channelMessageId <= 0
      ) {
        await sendText(
          chatId,
          [
            "Format noto‘g‘ri.",
            "Misol:",
            "/add 101 | Interstellar | -1001234567890 | 42",
            "",
            "Kanal ID va post ID kanal postining manzili yoki Telegram admin logidan olinadi.",
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
    logger.error({ err, code: movie.code }, "Failed to copy movie message");
    await sendText(
      chatId,
      "Kino topildi, lekin kanal postini yuborib bo‘lmadi. Kanal ID va botning kanalga qo‘shilganini tekshiring.",
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
  logger.info({ username: bot.username }, "Telegram bot connected");
  void poll();
}