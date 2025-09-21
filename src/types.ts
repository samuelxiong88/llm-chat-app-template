/**
 * Type definitions for the LLM chat application.
 */

export interface Env {
  /**
   * Binding for the Workers AI API.
   * 可选：当前代码未使用，可不绑定。
   */
  AI?: Ai;

  /**
   * Binding for static assets (R2/Pages Assets/Worker Site).
   */
  ASSETS: Fetcher;

  /**
   * 🔑 OpenAI API key from Secrets (Settings → Variables → Secrets)
   * Name: OPENAI_API_KEY
   */
  OPENAI_API_KEY: string;

  /**
   * （可选）覆盖默认模型
   * Name: OPENAI_MODEL  e.g. "gpt-4o" / "gpt-5-mini"
   */
  OPENAI_MODEL?: string;

  /**
   * （可选）自定义 API 基址（代理 / Azure 等）
   * 不设置时默认使用 https://api.openai.com/v1
   * Name: OPENAI_API_BASE
   */
  OPENAI_API_BASE?: string;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
