import { getTranslator } from "../i18n";

export type AiProvider = "openai" | "anthropic";

export type AiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
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
};

export type AiStreamHandler = (delta: string) => void;

const normalizeBaseUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
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

  if (settings.provider === "openai") {
    const baseUrl = normalizeBaseUrl(settings.openai.baseUrl);
    if (!baseUrl) throw new Error(t("ai.error.openaiUrl"));
    if (!settings.openai.apiKey) throw new Error(t("ai.error.openaiKey"));

    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.openai.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text || t("ai.error.openaiRequestFail"));
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error(t("ai.error.openaiEmpty"));
    }

    return content;
  }

  const baseUrl = normalizeBaseUrl(settings.anthropic.baseUrl);
  if (!baseUrl) throw new Error(t("ai.error.anthropicUrl"));
  if (!settings.anthropic.apiKey) throw new Error(t("ai.error.anthropicKey"));

  const resp = await fetch(`${baseUrl}/v1/messages`, {
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
        .map((m) => ({ role: m.role, content: m.content })),
      system: messages.find((m) => m.role === "system")?.content,
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
) {
  const t = await getTranslator();
  if (!settings.enabled) {
    throw new Error(t("ai.error.disabled"));
  }

  const model = settings.model?.trim();
  if (!model) {
    throw new Error(t("ai.error.modelMissing"));
  }

  if (settings.provider === "openai") {
    const baseUrl = normalizeBaseUrl(settings.openai.baseUrl);
    if (!baseUrl) throw new Error(t("ai.error.openaiUrl"));
    if (!settings.openai.apiKey) throw new Error(t("ai.error.openaiKey"));

    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.openai.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        stream: true,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text || t("ai.error.openaiRequestFail"));
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
      throw new Error(t("ai.error.openaiEmpty"));
    }
    return final;
  }

  const baseUrl = normalizeBaseUrl(settings.anthropic.baseUrl);
  if (!baseUrl) throw new Error(t("ai.error.anthropicUrl"));
  if (!settings.anthropic.apiKey) throw new Error(t("ai.error.anthropicKey"));

  const resp = await fetch(`${baseUrl}/v1/messages`, {
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
        .map((m) => ({ role: m.role, content: m.content })),
      system: messages.find((m) => m.role === "system")?.content,
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
