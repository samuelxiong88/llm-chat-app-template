/**
 * LLM Chat App on Cloudflare Workers — OpenAI backend (final fixed)
 */

import type { Env, ChatMessage } from "./types";

const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

const DEFAULT_API_BASE = "https://api.openai.com/v1";

// GPT-5/realtime/audio 不接受自定义 temperature
const modelSupportsTemperature = (m: string) => {
  const x = (m || "").toLowerCase();
  return !(x.startsWith("gpt-5") || x.includes("realtime") || x.includes("audio"));
};

const JSON = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const apiBase = env.OPENAI_API_BASE || DEFAULT_API_BASE;

    // 静态资源
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(req);
    }

    // CORS 预检
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "content-type, authorization",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // /api/debug
    if (url.pathname === "/api/debug") {
      return JSON({
        OPENAI_API_KEY: env.OPENAI_API_KEY ? "set" : "not set",
        OPENAI_MODEL: env.OPENAI_MODEL || "not set",
        OPENAI_API_BASE: env.OPENAI_API_BASE || "not set",
      });
    }

    // /api/ping
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
        return JSON({ error: String(e) }, 500);
      }
    }

    // /api/chat：支持 POST（正式）与 GET（调试用 ?q=）
    if (url.pathname === "/api/chat") {
      if (req.method === "GET") {
        // 仅调试：GET /api/chat?q=Hello
        const q = url.searchParams.get("q") || "Hello";
        const fake = new Request(req.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: q }] }),
        });
        return handleChat(fake, env);
      }
      if (req.method !== "POST") return JSON({ error: "Method not allowed" }, 405);
      return handleChat(req, env);
    }

    return JSON({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function handleChat(request: Request, env: Env): Promise<Response> {
  const apiBase = env.OPENAI_API_BASE || DEFAULT_API_BASE;
  const model = env.OPENAI_MODEL || "gpt-4o";

  // 调试开关：/api/chat?mode=json 返回非流式 JSON
  const url = new URL(request.url);
  const debugJson = url.searchParams.get("mode") === "json";

  // 读取并规范 messages
  let body: any;
  try {
    body = await request.json();
  } catch {
    return JSON({ error: "Invalid JSON body" }, 400);
  }
  const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.some((m) => m.role === "system")) {
    messages.unshift({ role: "system", content: SYSTEM_PROMPT });
  }

  // 组装 payload
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
    return JSON({ error: "OpenAI upstream error", status: upstream.status, detail }, upstream.status);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();

  let buffer = "";
  let acc = "";        // 累计到当前的完整文本
  let sentAny = false; // 首块去前导空格

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();

      if (done) {
        // 冲洗尾块：buffer 里可能还有一个未以空行结尾的事件
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
      while ((idx = buffer.indexOf("\n\n")) !== -1 || (idx = buffer.indexOf("\r\n\r\n")) !== -1) {
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

          // 解析增量
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

          // 忽略空/纯空白增量，避免空白气泡
          if (chunk.trim().length === 0) continue;

          // 累计全文 + 首块去前导空格
          acc += chunk;
          if (!sentAny && acc.length > 0) {
            acc = acc.replace(/^\s+/, "");
            sentAny = true;
          }

          // 每次都把“截至当前的完整文本”推给前端（避免拆字）
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
}
