/**
 * LLM Chat App on Cloudflare Workers — OpenAI backend (SSE final)
 * - /api/ping  自检：验证 Key/连通性（GET /v1/models）
 * - /api/chat  流式：chat/completions + SSE，适配模板前端事件格式
 */

import type { Env, ChatMessage } from "./types";

const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 前端静态资源
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // 自检：可选保留
    if (url.pathname === "/api/ping") {
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      });
      const text = await r.text();
      return new Response(text, {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }

    // 聊天
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
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleChat(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleChat(request: Request, env: Env): Promise<Response> {
  try {
    const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };

    // 保底 system
    if (!messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    // 先用 OPENAI_MODEL（如 gpt-4o / gpt-5-mini），否则默认 gpt-4o
    const model = (env as any).OPENAI_MODEL || "gpt-4o";

    // 调用 OpenAI（流式）
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: 0.2,
      }),
    });

    // 上游失败：把错误直接回给前端，便于定位
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: "OpenAI upstream error", status: upstream.status, detail }),
        { status: upstream.status, headers: { "content-type": "application/json" } }
      );
    }

    // 将 OpenAI 的 SSE 转成模板事件：{"response":"…","done":false} / {"done":true}
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    let buf = "";

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await reader.read();
        if (done) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
          controller.close();
          return;
        }

        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          for (const line of event.split("\n")) {
            const l = line.trim();
            if (!l.startsWith("data:")) continue;

            const payload = l.slice(5).trim();
            if (payload === "[DONE]") {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
              controller.close();
              return;
            }

            try {
              const json = JSON.parse(payload);
              const delta = json.choices?.[0]?.delta;
              const text = typeof delta?.content === "string" ? delta.content : "";
              if (text) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ response: text, done: false })}\n\n`)
                );
              }
            } catch {
              // 忽略非 JSON/心跳行
            }
          }
        }
      },
      cancel() {
        try { reader.cancel(); } catch {}
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
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
