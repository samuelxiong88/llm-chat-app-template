/**
 * LLM Chat Application Template (DEBUG build for OpenAI via Chat Completions)
 * - 前端静态资源仍由 env.ASSETS.fetch 提供
 * - /api/chat 调 OpenAI Chat Completions（非流式），原样返回 JSON（便于排错）
 * - 部署前请在 Settings → Variables → Secrets 配置：
 *     OPENAI_API_KEY = sk-xxxx
 */

import { Env, ChatMessage } from "./types";

const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 静态资源：模板自带网页
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // API 路由
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
 * 非流式调试版：把 OpenAI 的原始返回（成功或错误）直接回给前端
 */
async function handleChatRequest(request: Request, env: Env): Promise<Response> {
  try {
    const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };

    // 保底 system 提示
    if (!messages.some(m => m.role === "system")) {
      messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    // 直接调用 OpenAI Chat Completions（非流式）
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // 先用 mini 验证权限与端点；确认可用后可改为 "gpt-5"
        model: "gpt-5-mini",
        messages,
        stream: false,
        temperature: 0.2,
      }),
    });

    const text = await upstream.text(); // 读取上游原始响应文本
    // 打到日志里，便于在 Workers Logs → Live 查看
    console.log("upstream status:", upstream.status, "body:", text);

    // 原样回给前端；若失败，status 也会保留上游状态码（如 400/401/404/429）
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });

  } catch (err) {
    console.error("chat error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
