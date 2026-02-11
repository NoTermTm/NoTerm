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
  if (!settings.enabled) {
    throw new Error("AI 未启用");
  }

  const model = settings.model?.trim();
  if (!model) {
    throw new Error("未配置模型");
  }

  if (settings.provider === "openai") {
    const baseUrl = normalizeBaseUrl(settings.openai.baseUrl);
    if (!baseUrl) throw new Error("未配置 OpenAI API 地址");
    if (!settings.openai.apiKey) throw new Error("未配置 OpenAI API 密钥");

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
      throw new Error(text || "OpenAI 请求失败");
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("OpenAI 返回内容为空");
    }

    return content;
  }

  const baseUrl = normalizeBaseUrl(settings.anthropic.baseUrl);
  if (!baseUrl) throw new Error("未配置 Anthropic API 地址");
  if (!settings.anthropic.apiKey) throw new Error("未配置 Anthropic API 密钥");

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
    throw new Error(text || "Anthropic 请求失败");
  }

  const data = (await resp.json()) as {
    content?: Array<{ text?: string }>;
  };

  const content = data.content?.[0]?.text?.trim();
  if (!content) {
    throw new Error("Anthropic 返回内容为空");
  }

  return content;
}
