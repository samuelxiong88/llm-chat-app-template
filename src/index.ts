/**
 * LLM Chat App (OpenAI GPT-5, stream adapted to template SSE schema)
 *
 * 前端仍使用模板自带的 SSE 客户端，不需要改动。
 * 这里把 OpenAI 的流式增量 (choices[0].delta.content) 映射为：
 *   data: {"response":"<chunk>","done":false}
 * 结尾发送：
 *   data: {"done":true}
 */

import { Env, ChatMessage } from "./types";

const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 静态资源
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // API：聊天
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
      if (request.method === "POST") return handleChatRequest(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * 将 OpenAI Chat Completions 的 SSE 转成模板期望的 SSE 事件
 */
async function handleChatRequest(request: Request, env: Env): Promise<Response> {
  try {
    const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };

    if (!messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    // 拉起 OpenAI 流
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5",   // 可改 gpt-5-mini / gpt-5-nano
        messages,
        stream: true,
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

    // 读取 OpenAI 的 SSE 文本流，并转换成模板的事件格式
    const encoder = new TextEncoder();
    const reader = upstream.body.getReader();

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await reader.read();
        if (done) {
          // 结束事件
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
          controller.close();
          return;
        }

        // value 是一块文本（OpenAI 的 SSE 是 "data: {...}\n\n" 多行）
        const chunkText = new TextDecoder().decode(value);

        // 逐行解析，每一行以 "data: " 开头
        const lines = chunkText.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim(); // 去掉 "data:"

          if (payload === "[DONE]") {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
            controller.close();
            return;
          }

          try {
            const json = JSON.parse(payload);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              // 按模板要求发送 {"response":"<增量>","done":false}
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ response: delta, done: false })}\n\n`)
              );
            }
          } catch {
            // 忽略无法解析的行
          }
        }
      },
    });

    return new Response(stream, {
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
