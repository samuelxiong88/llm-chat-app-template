/**
 * LLM Chat Application Template (OpenAI GPT-5 via SSE)
 *
 * - 前端：保持模板自带的流式 SSE 读取逻辑不变
 * - 后端：将 Cloudflare Workers AI 调用改为 OpenAI Chat Completions (stream: true)
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

//（可留可删）原模板的标识位，不再使用 Cloudflare 内置模型
const MODEL_ID = "gpt-5";

// 默认系统提示
const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 处理静态资源（网页界面）
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // API 路由
    if (url.pathname === "/api/chat") {
      if (request.method === "OPTIONS") {
        // 允许简单 CORS 预检（有些前端环境会发）
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "content-type, authorization",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
          },
        });
      }

      if (request.method === "POST") {
        return handleChatRequest(request, env);
      }

      return new Response("Method not allowed", { status: 405 });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * 处理聊天请求：把前端传来的 messages 原样转给 OpenAI，并以 SSE 流式回传
 */
async function handleChatRequest(request: Request, env: Env): Promise<Response> {
  try {
    const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };

    // 如前端未带 system，则补一个
    if (!messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    // 调用 OpenAI Chat Completions（流式）
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5",   // 可改为 "gpt-5-mini" / "gpt-5-nano"
        messages,         // 直接使用前端传入的对话
        stream: true,     // 关键：开启流式
        temperature: 0.2,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: "OpenAI upstream error", detail: text || upstream.statusText }),
        { status: upstream.status, headers: { "content-type": "application/json" } }
      );
    }

    // 将 OpenAI 的 SSE 原样透传给前端（模板前端使用 EventSource/ReadableStream 解析）
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error("chat error:", err);
    return new Response(JSON.stringify({ error: "Failed to process request" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
