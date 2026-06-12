import type { AgentRisk, AgentStepAction } from "../types/agent";

export interface ParsedAgentResponse {
  thinking: string;
  action: AgentStepAction | null;
  done: boolean;
  finalAnswer: string;
}

/**
 * Generate a unique ID for actions.
 * Uses crypto.randomUUID() with a fallback for environments that don't support it.
 */
function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: generate a pseudo-random UUID v4
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const VALID_RISKS: AgentRisk[] = ["low", "medium", "high", "critical"];

/**
 * Parse a complete AI response text to extract thinking, action, and done signal.
 *
 * Expected formats:
 * - Thinking + Action: <thinking>...</thinking>\n<action>{"command":"...","risk":"...","reason":"..."}</action>
 * - Thinking + Done: <thinking>...</thinking>\n<done>final answer</done>
 * - Thinking + Done (legacy): <thinking>...</thinking>\n<done/>
 * - Thinking only (treated as done): <thinking>...</thinking>
 */
export function parseAgentResponse(rawText: string): ParsedAgentResponse {
  const thinking = extractThinking(rawText);
  const action = extractAction(rawText);
  const finalAnswer = extractDoneContent(rawText);
  const hasDoneTag = /<done(?:\s*\/|\s*>[\s\S]*?<\/done>)/.test(rawText);

  // If neither action nor done tag is present, treat as done (pure thinking response)
  const done = hasDoneTag || action === null;

  return {
    thinking,
    action,
    done,
    finalAnswer,
  };
}

/**
 * Extract thinking content from a potentially incomplete streaming text.
 * Handles cases where the closing </thinking> tag may not be present yet.
 */
export function extractStreamingThinking(partialText: string): string {
  const openTag = "<thinking>";
  const closeTag = "</thinking>";

  const openIdx = partialText.indexOf(openTag);
  if (openIdx === -1) {
    return "";
  }

  const contentStart = openIdx + openTag.length;
  const closeIdx = partialText.indexOf(closeTag, contentStart);

  if (closeIdx === -1) {
    // Closing tag not yet received — return everything after the open tag
    return partialText.slice(contentStart).trimStart();
  }

  return partialText.slice(contentStart, closeIdx).trim();
}

/**
 * Extract thinking content from a complete response.
 */
function extractThinking(rawText: string): string {
  const openTag = "<thinking>";
  const closeTag = "</thinking>";

  const openIdx = rawText.indexOf(openTag);
  if (openIdx === -1) {
    return "";
  }

  const contentStart = openIdx + openTag.length;
  const closeIdx = rawText.indexOf(closeTag, contentStart);

  if (closeIdx === -1) {
    // Malformed: no closing tag, take everything after open tag
    return rawText.slice(contentStart).trim();
  }

  return rawText.slice(contentStart, closeIdx).trim();
}

/**
 * Extract the user-facing final answer from <done>...</done>.
 * Supports legacy self-closing <done/> tags by returning an empty string.
 */
function extractDoneContent(rawText: string): string {
  const selfClosingDone = /<done\s*\/>/.test(rawText);
  if (selfClosingDone) {
    return "";
  }

  const match = rawText.match(/<done>([\s\S]*?)<\/done>/);
  if (!match) {
    return "";
  }

  return match[1].trim();
}

/**
 * Extract action from the response text.
 * Parses the JSON inside <action>...</action> tags.
 */
function extractAction(rawText: string): AgentStepAction | null {
  const openTag = "<action>";
  const closeTag = "</action>";

  const openIdx = rawText.indexOf(openTag);
  if (openIdx === -1) {
    return null;
  }

  const contentStart = openIdx + openTag.length;
  const closeIdx = rawText.indexOf(closeTag, contentStart);

  if (closeIdx === -1) {
    // Malformed: no closing action tag
    return null;
  }

  const jsonStr = rawText.slice(contentStart, closeIdx).trim();

  try {
    const parsed = JSON.parse(jsonStr);

    const command = typeof parsed.command === "string" ? parsed.command : "";
    if (!command) {
      return null;
    }

    const risk: AgentRisk = VALID_RISKS.includes(parsed.risk) ? parsed.risk : "medium";
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";

    return {
      id: generateId(),
      command,
      risk,
      reason,
    };
  } catch {
    // Malformed JSON inside action tag
    return null;
  }
}
