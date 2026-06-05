import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getTranslator } from "../i18n";

export type AiProvider = "openai" | "anthropic" | "volcengine";

export type AiMessagePart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      mediaType: string;
      dataUrl: string;
    };

export type AiMessage = {
  role: "system" | "user" | "assistant";
  content: string | AiMessagePart[];
};

export type AiSettings = {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  openai: {
    baseUrl: string;
    apiKey: string;
  };
  anthropic: {
    baseUrl: string;
    apiKey: string;
  };
  volcengine: {
    baseUrl: string;
    apiKey: string;
  };
};

export type AiStreamHandler = (delta: string) => void;

const normalizeBaseUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

const isOpenAiCompatibleProvider = (
  provider: AiProvider,
): provider is "openai" | "volcengine" =>
  provider === "openai" || provider === "volcengine";

const getOpenAiCompatibleConfig = (
  settings: AiSettings,
  provider: "openai" | "volcengine",
) =>
  provider === "openai"
    ? settings.openai
    : settings.volcengine;

const getOpenAiCompatibleErrorKey = (
  provider: "openai" | "volcengine",
  type: "url" | "key" | "requestFail" | "empty",
) => {
  const prefix = provider === "openai" ? "openai" : "volcengine";
  return `ai.error.${prefix}${type[0].toUpperCase()}${type.slice(1)}`;
};

const getOpenAiCompatibleChatUrl = (
  provider: "openai" | "volcengine",
  baseUrl: string,
) =>
  provider === "openai"
    ? `${baseUrl}/v1/chat/completions`
    : `${baseUrl}/chat/completions`;

const extractBase64Payload = (dataUrl: string) => {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mediaType: match[1],
    data: match[2],
  };
};

const toOpenAiCompatibleContent = (content: AiMessage["content"]) => {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image_url", image_url: { url: part.dataUrl } },
  );
};

const toAnthropicContent = (content: AiMessage["content"]) => {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    const extracted = extractBase64Payload(part.dataUrl);
    if (!extracted) {
      return { type: "text", text: "[Image attachment could not be encoded]" };
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: extracted.mediaType,
        data: extracted.data,
      },
    };
  });
};

type SseEvent = {
  event: string;
  data: string;
};

const parseSseEvents = (
  chunk: string,
  bufferRef: { value: string },
  onEvent: (event: SseEvent) => void,
) => {
  bufferRef.value += chunk;
  let boundary = bufferRef.value.indexOf("\n\n");
  while (boundary !== -1) {
    const raw = bufferRef.value.slice(0, boundary);
    bufferRef.value = bufferRef.value.slice(boundary + 2);
    boundary = bufferRef.value.indexOf("\n\n");
    if (!raw.trim()) continue;
    const lines = raw.split(/\r?\n/);
    let event = "";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    onEvent({ event, data: dataLines.join("\n") });
  }
};

const readSseStream = async (
  resp: Response,
  onEvent: (event: SseEvent) => void,
) => {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("Stream is not readable");
  const decoder = new TextDecoder();
  const bufferRef = { value: "" };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parseSseEvents(decoder.decode(value, { stream: true }), bufferRef, onEvent);
  }
  parseSseEvents(decoder.decode(), bufferRef, onEvent);
};

export async function sendAiChat(settings: AiSettings, messages: AiMessage[]) {
  const t = await getTranslator();
  if (!settings.enabled) {
    throw new Error(t("ai.error.disabled"));
  }

  const model = settings.model?.trim();
  if (!model) {
    throw new Error(t("ai.error.modelMissing"));
  }

  if (isOpenAiCompatibleProvider(settings.provider)) {
    const provider = settings.provider;
    const config = getOpenAiCompatibleConfig(settings, provider);
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    if (!baseUrl) throw new Error(t(getOpenAiCompatibleErrorKey(provider, "url")));
    if (!config.apiKey) throw new Error(t(getOpenAiCompatibleErrorKey(provider, "key")));

    const resp = await tauriFetch(getOpenAiCompatibleChatUrl(provider, baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: messages.map((message) => ({
          role: message.role,
          content: toOpenAiCompatibleContent(message.content),
        })),
        temperature: 0.2,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text || t(getOpenAiCompatibleErrorKey(provider, "requestFail")));
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error(t(getOpenAiCompatibleErrorKey(provider, "empty")));
    }

    return content;
  }

  const baseUrl = normalizeBaseUrl(settings.anthropic.baseUrl);
  if (!baseUrl) throw new Error(t("ai.error.anthropicUrl"));
  if (!settings.anthropic.apiKey) throw new Error(t("ai.error.anthropicKey"));

  const resp = await tauriFetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.anthropic.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
      system:
        typeof messages.find((m) => m.role === "system")?.content === "string"
          ? (messages.find((m) => m.role === "system")?.content as string)
          : undefined,
      temperature: 0.2,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || t("ai.error.anthropicRequestFail"));
  }

  const data = (await resp.json()) as {
    content?: Array<{ text?: string }>;
  };

  const content = data.content?.[0]?.text?.trim();
  if (!content) {
    throw new Error(t("ai.error.anthropicEmpty"));
  }

  return content;
}

export async function sendAiChatStream(
  settings: AiSettings,
  messages: AiMessage[],
  onDelta: AiStreamHandler,
  options?: {
    signal?: AbortSignal;
  },
) {
  const t = await getTranslator();
  if (!settings.enabled) {
    throw new Error(t("ai.error.disabled"));
  }

  const model = settings.model?.trim();
  if (!model) {
    throw new Error(t("ai.error.modelMissing"));
  }

  if (isOpenAiCompatibleProvider(settings.provider)) {
    const provider = settings.provider;
    const config = getOpenAiCompatibleConfig(settings, provider);
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    if (!baseUrl) throw new Error(t(getOpenAiCompatibleErrorKey(provider, "url")));
    if (!config.apiKey) throw new Error(t(getOpenAiCompatibleErrorKey(provider, "key")));

    const resp = await tauriFetch(getOpenAiCompatibleChatUrl(provider, baseUrl), {
      method: "POST",
      signal: options?.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: messages.map((message) => ({
          role: message.role,
          content: toOpenAiCompatibleContent(message.content),
        })),
        temperature: 0.2,
        stream: true,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text || t(getOpenAiCompatibleErrorKey(provider, "requestFail")));
    }

    let final = "";
    await readSseStream(resp, (event) => {
      if (!event.data) return;
      if (event.data === "[DONE]") return;
      try {
        const data = JSON.parse(event.data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const chunk = data.choices?.[0]?.delta?.content;
        if (chunk) {
          final += chunk;
          onDelta(chunk);
        }
      } catch {
        /* ignore parse errors */
      }
    });

    if (!final.trim()) {
      throw new Error(t(getOpenAiCompatibleErrorKey(provider, "empty")));
    }
    return final;
  }

  const baseUrl = normalizeBaseUrl(settings.anthropic.baseUrl);
  if (!baseUrl) throw new Error(t("ai.error.anthropicUrl"));
  if (!settings.anthropic.apiKey) throw new Error(t("ai.error.anthropicKey"));

  const resp = await tauriFetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    signal: options?.signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.anthropic.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
      system:
        typeof messages.find((m) => m.role === "system")?.content === "string"
          ? (messages.find((m) => m.role === "system")?.content as string)
          : undefined,
      temperature: 0.2,
      stream: true,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || t("ai.error.anthropicRequestFail"));
  }

  let final = "";
  await readSseStream(resp, (event) => {
    if (!event.data) return;
    try {
      const data = JSON.parse(event.data) as {
        type?: string;
        delta?: { text?: string };
        content_block?: { text?: string };
      };
      const type = data.type || event.event;
      if (type === "content_block_start") {
        const chunk = data.content_block?.text;
        if (chunk) {
          final += chunk;
          onDelta(chunk);
        }
        return;
      }
      if (type === "content_block_delta") {
        const chunk = data.delta?.text;
        if (chunk) {
          final += chunk;
          onDelta(chunk);
        }
      }
    } catch {
      /* ignore parse errors */
    }
  });

  if (!final.trim()) {
    throw new Error(t("ai.error.anthropicEmpty"));
  }
  return final;
}
