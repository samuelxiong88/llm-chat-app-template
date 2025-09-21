/**
 * LLM Chat App on Cloudflare Workers — OpenAI backend (final unified)
 * - /api/debug  查看环境变量
 * - /api/ping   GET /v1/models 验证 KEY/网络
 * - /api/chat   GET → 直通 OpenAI SSE；POST → 解析为 {response,done}
 */

import type { Env, ChatMessage } from "./types";

const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";
const DEFAULT_API_BASE = "https://api.openai.com/v1";

// GPT-5 / realtime / audio 不接受自定义 temperature
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
    try {
      const url = new URL(request.url);
      const apiBase = env.OPENAI_API_BASE || DEFAULT_API_BASE;

      // ===== 静态资源（前端）兜底 =====
      if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
        try {
          if (env.ASSETS && typeof (env.ASSETS as any).fetch === "function") {
            return env.ASSETS.fetch(request);
          }
        } catch {}
        const html = `<!doctype html><meta charset="utf-8">
<title>LLM Chat</title>
<body style="font-family:system-ui;margin:40px">
<h2>LLM Chat App</h2>
<p>Assets binding <code>ASSETS</code> not configured. API endpoints:</p>
<ul><li><code>/api/ping</code></li><li><code>/api/chat</code></li><li><code>/api/debug</code></li></ul>
</body>`;
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      // ===== CORS 预检 =====
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "content-type, authorization",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Max-Age": "86400",
          },
        });
      }

      // ===== /api/debug =====
      if (url.pathname === "/api/debug") {
        return jsonResponse({
          OPENAI_API_KEY: env.OPENAI_API_KEY ? "set" : "not set",
          OPENAI_MODEL: env.OPENAI_MODEL || "not set",
          OPENAI_API_BASE: env.OPENAI_API_BASE || "not set",
        });
      }

      // ===== /api/ping =====
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

      // ===== /api/chat =====
      if (url.pathname === "/api/chat") {
        // GET: 直通 OpenAI SSE
        if (request.method === "GET") {
          const q = url.searchParams.get("q") || "Hello";
          const model = env.OPENAI_MODEL || "gpt-4o";
          const supportsTemp = modelSupportsTemperature(model);
          const payload: any = {
            model,
            stream: true,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: q },
            ],
          };
          if (supportsTemp) payload.temperature = 0.2;

          const upstream = await fetch(`${apiBase}/chat/completions`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });

          if (!upstream.ok || !upstream.body) {
            const detail = await upstream.text().catch(() => "");
            return jsonResponse(
              { error: "OpenAI upstream error (GET passthrough)", status: upstream.status, detail },
              upstream.status
            );
          }

          return new Response(upstream.body, {
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // POST: 解析累积输出
        if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
        return handleChat(request, env);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (e) {
      return jsonResponse({ error: "Worker exception", detail: String(e) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleChat(request: Request, env: Env): Promise<Response> {
  try {
    const apiBase = env.OPENAI_API_BASE || DEFAULT_API_BASE;
    const model = env.OPENAI_MODEL || "gpt-4o";

    const url = new URL(request.url);
    const debugJson = url.searchParams.get("mode") === "json";

    let body: any;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
    if (!messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    const payload: any = { model, messages, stream: !debugJson };
    if (modelSupportsTemperature(model)) payload.temperature = 0.2;

    if (debugJson) {
      const r = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      return new Response(text, {
        status: r.status,
        headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const upstream = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return jsonResponse({ error: "OpenAI upstream error", status: upstream.status, detail }, upstream.status);
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();

    let buffer = "";
    let acc = "";
    let sentAny = false;

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await reader.read();

        if (done) {
          const tail = buffer.trim();
          if (tail.startsWith("data:")) {
            const payload = tail.slice(5).trim();
            if (payload !== "[DONE]") {
              try {
                const j = JSON.parse(payload);
                const chunk =
                  typeof j?.choices?.[0]?.delta?.content === "string"
                    ? j.choices[0].delta.content
                    : "";
                if (chunk.trim().length > 0) acc += chunk;
              } catch {}
            }
          }
          if (!sentAny && acc.length > 0) {
            acc = acc.replace(/^\s+/, "");
            sentAny = true;
          }
          if (acc.length > 0) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ response: acc, done: false })}\n\n`)
            );
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while (
          (idx = buffer.indexOf("\n\n")) !== -1 ||
          (idx = buffer.indexOf("\r\n\r\n")) !== -1
        ) {
          const useCRLF =
            buffer.indexOf("\r\n\r\n") !== -1 && idx === buffer.indexOf("\r\n\r\n");
          const sepLen = useCRLF ? 4 : 2;

          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + sepLen);

          for (const line of block.split(/\r?\n/)) {
            const l = line.trim();
            if (!l.startsWith("data:")) continue;
            const payload = l.slice(5).trim();

            if (payload === "[DONE]") {
              if (!sentAny && acc.length > 0) {
                acc = acc.replace(/^\s+/, "");
                sentAny = true;
              }
              if (acc.length > 0) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ response: acc, done: false })}\n\n`)
                );
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
              controller.close();
              return;
            }

            let j: any;
            try { j = JSON.parse(payload); } catch { continue; }

            const delta = j?.choices?.[0]?.delta;
            const chunk = typeof delta?.content === "string" ? delta.content : "";
            const hasRoleOnly = delta?.role && !chunk;

            if (hasRoleOnly) continue;
            if (!chunk || !chunk.trim()) continue;

            acc += chunk;
            if (!sentAny && acc.length > 0) {
              acc = acc.replace(/^\s+/, "");
              sentAny = true;
            }

            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ response: acc, done: false })}\n\n`)
            );
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
    return jsonResponse({ error: "handleChat exception", detail: String(e) }, 500);
  }
}
