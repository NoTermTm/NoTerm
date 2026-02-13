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

const normalizeBaseUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
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
