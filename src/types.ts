/**
 * Type definitions for the LLM chat application.
 */

export interface Env {
  /**
   * Binding for the Workers AI API.
   * （保留即可，虽然我们当前不再使用它）
   */
  AI: Ai;

  /**
   * Binding for static assets.
   */
  ASSETS: { fetch: (request: Request) => Promise<Response> };

  /**
   * 🔑 OpenAI API key from Secrets (Settings → Variables → Secrets)
   *   Name: OPENAI_API_KEY
   */
  OPENAI_API_KEY: string;

  /**
   * （可选）在 Environment Variables 里覆盖模型名
   *   Name: OPENAI_MODEL  e.g. "gpt-4o" / "gpt-5-mini"
   */
  OPENAI_MODEL?: string;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
