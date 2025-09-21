/**
 * LLM Chat App on Cloudflare Workers — OpenAI (Chat Completions) backend
 * 将 OpenAI 的 SSE（delta.content）映射成模板前端需要的事件：
 *   data: {"response":"<chunk>","done":false}\n\n
 * 结束：
 *   data: {"done":true}\n\n
 */

import type { Env, ChatMessage } from "./types";

const DEFAULT_MODEL = "gpt-4o-mini"; // 可在 Settings→Variables 里设 OPENAI_MODEL 覆盖

const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 前端静态资源
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // 聊天 API
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

async function handleChatRequest(request: Request, env: Env): Promise<Response> {
  try {
    const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };

    // 保底 system
    if (!messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    const model = env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,                 // 例如 gpt-4o, gpt-4o-mini，或你账户开通的 gpt-5 / gpt-5-mini
        messages,
        stream: true,          // 开启流式
        temperature: 0.2,
      }),
    });

    // 上游错误直接返回，便于定位
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: "Upstream error", status: upstream.status, detail }),
        { status: upstream.status, headers: { "content-type": "application/json" } }
      );
    }

    // 解析 OpenAI 的 SSE，并转成模板前端需要的事件
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    let buffer = "";

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await reader.read();
        if (done) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });

        // OpenAI 的 SSE 事件以 \n\n 分隔；每个事件可能多行 "data: ..."
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const lines = rawEvent.split("\n").map((l) => l.trim()).filter(Boolean);
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();

            if (payload === "[DONE]") {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
              controller.close();
              return;
            }

            try {
              const json = JSON.parse(payload);
              const delta = json.choices?.[0]?.delta;
              const content = typeof delta?.content === "string" ? delta.content : "";

              // 只把文本增量发给前端（工具调用/role 变更忽略）
              if (content) {
                const evt = { response: content, done: false };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
              }
            } catch {
              // 非 JSON（比如心跳行）忽略
            }
          }
        }
      },
      cancel() {
        try {
          reader.cancel();
        } catch {}
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
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
