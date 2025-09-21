/**
 * LLM Chat App on Cloudflare Workers — OpenAI backend (final)
 * - /api/debug  查看环境变量
 * - /api/ping   GET /v1/models 验证 KEY/网络
 * - /api/chat   /v1/chat/completions（支持 POST 正式 + GET 调试 ?q=）
 *   将 OpenAI 的 SSE 解析并转为前端协议：
 *     data: {"response":"<累计全文>","done":false}\n\n
 *     data: {"done":true}\n\n
 */

import type { Env, ChatMessage } from "./types";

const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

const DEFAULT_API_BASE = "https://api.openai.com/v1";

// GPT-5 / realtime / audio 系列不接受自定义 temperature
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

      // ===== 静态资源（前端）— 带兜底，避免 ASSETS 未绑定抛 1101 =====
      if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
        try {
          if (env.ASSETS && typeof (env.ASSETS as any).fetch === "function") {
            return env.ASSETS.fetch(request);
          }
        } catch (e) {
          // fall through to fallback html
        }
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

      // ===== /api/debug：查看变量是否读到 =====
      if (url.pathname === "/api/debug") {
        return jsonResponse({
          OPENAI_API_KEY: env.OPENAI_API_KEY ? "set" : "not set",
          OPENAI_MODEL: env.OPENAI_MODEL || "not set",
          OPENAI_API_BASE: env.OPENAI_API_BASE || "not set",
        });
      }

      // ===== /api/ping：验证 KEY/网络 =====
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

      // ===== /api/chat：支持 POST（正式）与 GET（调试 ?q=）=====
      if (url.pathname === "/api/chat") {
        if (request.method === "GET") {
          // 仅调试：GET /api/chat?q=Hello
          const q = url.searchParams.get("q") || "Hello";
          const fake = new Request(request.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [{ role: "user", content: q }] }),
          });
          return handleChat(fake, env);
        }
        if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
        return handleChat(request, env);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (e) {
      // 顶层兜底，避免 1101 HTML
      return jsonResponse({ error: "Worker exception", detail: String(e) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleChat(request: Request, env: Env): Promise<Response> {
  try {
    const apiBase = env.OPENAI_API_BASE || DEFAULT_API_BASE;
    const model = env.OPENAI_MODEL || "gpt-4o";

    // 调试开关：/api/chat?mode=json → 非流式 JSON
    const url = new URL(request.url);
    const debugJson = url.searchParams.get("mode") === "json";

    // 读取并规范 messages
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

    // 组装 payload（gpt-5* 不发 temperature）
    const payload: any = { model, messages, stream: !debugJson };
    if (modelSupportsTemperature(model)) payload.temperature = 0.2;

    // 非流式（调试）
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

    // 流式
    let upstream: Response;
    try {
      upstream = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return jsonResponse({ error: "OpenAI fetch failed", detail: String(e) }, 500);
    }

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return jsonResponse({ error: "OpenAI upstream error", status: upstream.status, detail }, upstream.status);
    }

    // 解析 OpenAI SSE → 转为前端协议（累计推送 + 必发 done:true + 冲洗尾块）
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();

    let buffer = "";
    let acc = "";        // 累计到当前完整文本
    let sentAny = false; // 首块去前导空格

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await reader.read();

        if (done) {
          // 冲洗尾块：buffer 里可能残留一个未以空行结尾的事件
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

        // 兼容 \n\n / \r\n\r\n 事件边界
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
            try {
              j = JSON.parse(payload);
            } catch {
              continue; // 心跳或非 JSON 行
            }

            const chunk =
              typeof j?.choices?.[0]?.delta?.content === "string"
                ? j.choices[0].delta.content
                : "";

            // 忽略空/空白增量
            if (chunk.trim().length === 0) continue;

            // 累积全文 + 首块去前导空格
            acc += chunk;
            if (!sentAny && acc.length > 0) {
              acc = acc.replace(/^\s+/, "");
              sentAny = true;
            }

            // 每次把截至当前的“完整文本”推给前端（避免 H e low / 空白）
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ response: acc, done: false })}\n\n`)
            );
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
  } catch (e) {
    return jsonResponse({ error: "handleChat exception", detail: String(e) }, 500);
  }
}
