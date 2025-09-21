/**
 * LLM Chat App on Cloudflare Workers — OpenAI backend (final, with accumulator)
 * - /api/debug  查看环境变量
 * - /api/ping   GET /v1/models 验证 KEY/网络
 * - /api/chat   /v1/chat/completions 流式；将 OpenAI SSE 转为前端协议：
 *   data: {"response":"<全文到当前>","done":false}\n\n
 *   data: {"done":true}\n\n
 */

import type { Env, ChatMessage } from "./types";

const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

function modelSupportsTemperature(model: string): boolean {
  const m = (model || "").toLowerCase();
  return !(m.startsWith("gpt-5") || m.includes("realtime") || m.includes("audio"));
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const apiBase = env.OPENAI_API_BASE || "https://api.openai.com/v1";

    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "content-type, authorization",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (url.pathname === "/api/debug") {
      return jsonResponse({
        OPENAI_API_KEY: env.OPENAI_API_KEY ? "set" : "not set",
        OPENAI_MODEL: env.OPENAI_MODEL || "not set",
        OPENAI_API_BASE: env.OPENAI_API_BASE || "not set",
      });
    }

    if (url.pathname === "/api/ping") {
      try {
        const r = await fetch(`${apiBase}/models`, {
          headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        });
        const text = await r.text();
        return new Response(text, {
          status: r.status,
          headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (e) {
        return jsonResponse({ error: String(e) }, 500);
      }
    }

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
      return handleChat(request, env);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function handleChat(request: Request, env: Env): Promise<Response> {
  const apiBase = env.OPENAI_API_BASE || "https://api.openai.com/v1";
  const model   = env.OPENAI_MODEL || "gpt-4o";

  const url = new URL(request.url);
  const debugJson = url.searchParams.get("mode") === "json";

  // 读取并规范 messages
  let body: any;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.some((m) => m.role === "system")) {
    messages.unshift({ role: "system", content: SYSTEM_PROMPT });
  }

  // 组装请求体（gpt-5* 不发 temperature 字段）
  const payload: any = { model, messages, stream: !debugJson };
  if (modelSupportsTemperature(model)) payload.temperature = 0.2;

  // 非流式调试：原样返回 JSON 便于排错
  if (debugJson) {
    const r = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // ===== 流式：SSE -> 前端协议（累计后推送） =====
  const upstream = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return jsonResponse({ error: "OpenAI upstream error", status: upstream.status, detail }, upstream.status);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader  = upstream.body.getReader();

  let buffer = "";
  let acc    = "";      // 累计到当前完整文本
  let sentAny = false;  // 首块去前导空格

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();

      if (done) {
        // —— 冲洗尾块：buffer 里可能还有未以空行结尾的一条事件 ——
        const tail = buffer.trim();
        if (tail.startsWith("data:")) {
          const payload = tail.slice(5).trim();
          if (payload !== "[DONE]") {
            try {
              const j = JSON.parse(payload);
              const chunk = typeof j?.choices?.[0]?.delta?.content === "string" ? j.choices[0].delta.content : "";
              if (chunk.trim().length > 0) acc += chunk;
            } catch {}
          }
        }
        if (!sentAny && acc.length > 0) { acc = acc.replace(/^\s+/, ""); sentAny = true; }
        if (acc.length > 0) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: acc, done: false })}\n\n`));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
        controller.close();
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      // 支持 \n\n 或 \r\n\r\n 作为事件边界
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1 || (idx = buffer.indexOf("\r\n\r\n")) !== -1) {
        const useCRLF = buffer.indexOf("\r\n\r\n") !== -1 && (idx === buffer.indexOf("\r\n\r\n"));
        const sepLen  = useCRLF ? 4 : 2;
        const block   = buffer.slice(0, idx);
        buffer        = buffer.slice(idx + sepLen);

        for (const line of block.split(/\r?\n/)) {
          const l = line.trim();
          if (!l.startsWith("data:")) continue;
          const payload = l.slice(5).trim();

          if (payload === "[DONE]") {
            if (!sentAny && acc.length > 0) { acc = acc.replace(/^\s+/, ""); sentAny = true; }
            if (acc.length > 0) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: acc, done: false })}\n\n`));
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
            controller.close();
            return;
          }

          let j: any;
          try { j = JSON.parse(payload); } catch { continue; }

          const chunk = typeof j?.choices?.[0]?.delta?.content === "string" ? j.choices[0].delta.content : "";
          if (chunk.trim().length === 0) continue;           // 忽略空白块

          acc += chunk;                                      // 累加全文
          if (!sentAny && acc.length > 0) {                  // 首块去前导空格
            acc = acc.replace(/^\s+/, ""); sentAny = true;
          }

          // 每次把“到目前为止的完整文本”推给前端（避免 H e low / 空白）
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ response: acc, done: false })}\n\n`
          ));
        }
      }
    },
    cancel() { try { reader.cancel(); } catch {} },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
