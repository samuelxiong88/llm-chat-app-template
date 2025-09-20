/**
 * LLM Chat Application Template (modified for OpenAI GPT-5)
 *
 * - 静态资源依然通过 env.ASSETS.fetch 提供
 * - /api/chat 路由改为调用 OpenAI Responses API
 * - 返回 SSE 流式响应，兼容模板前端
 */

import { Env, ChatMessage } from "./types";

const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // 提供前端静态资源
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // 处理聊天 API
    if (url.pathname === "/api/chat") {
      if (request.method === "OPTIONS") {
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
 * 真正的聊天逻辑：调用 OpenAI Responses API
 */
async function handleChatRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };

    // 确保有 system prompt
    if (!messages.some(m => m.role === "system")) {
      messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    // 把 Chat 消息合并为一个 input
    const input = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n");

    // 请求 OpenAI Responses API（流式）
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5",    // 可改成 gpt-5-mini / gpt-5-nano
        input,
        stream: true,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: "OpenAI upstream error", detail: text || upstream.statusText }),
        { status: upstream.status, headers: { "content-type": "application/json" } }
      );
    }

    // 原样透传 OpenAI SSE 到前端
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
