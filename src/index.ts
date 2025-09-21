if (payload === "[DONE]") {interface Env {
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  OPENAI_API_BASE?: string;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

interface ChatMessage {
  role: string;
  content: string;
}
const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const apiBase = env.OPENAI_API_BASE || "https://api.openai.com/v1";
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    if (url.pathname === "/api/debug") {
      return new Response(
        JSON.stringify({
          OPENAI_API_KEY: env.OPENAI_API_KEY ? "set" : "not set",
          OPENAI_MODEL: env.OPENAI_MODEL || "not set",
          OPENAI_API_BASE: env.OPENAI_API_BASE || "not set",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
    if (url.pathname === "/api/ping") {
      try {
        const r = await fetch(`${apiBase}/models`, {
          headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        });
        const text = await r.text();
        console.log("Ping response status:", r.status);
        return new Response(text, {
          status: r.status,
          headers: {
            "content-type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        console.error("Ping error:", e);
        return new Response(JSON.stringify({ error: "Ping failed" }), {
          status: 500,
          headers: {
            "content-type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }
    if (url.pathname === "/api/chat") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "content-type, authorization",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Max-Age": "86400",
          },
        });
      }
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: {
            "content-type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      return handleChat(request, env);
    }
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: {
        "content-type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
} satisfies ExportedHandler<Env>;

async function handleChat(request: Request, env: Env): Promise<Response> {
  const apiBase = env.OPENAI_API_BASE || "https://api.openai.com/v1";
  const model = env.OPENAI_MODEL || "gpt-4o";

  // 调试开关：/api/chat?mode=json 时走非流式，原样返回 JSON，便于看错误
  const url = new URL(request.url);
  const debugJson = url.searchParams.get("mode") === "json";

  // 读取请求体
  let body: any;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // 规范 messages，并补 system
  const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.some((m) => m.role === "system")) {
    messages.unshift({ role: "system", content: SYSTEM_PROMPT });
  }

  // ---------- 调试：非流式路径 ----------
  if (debugJson) {
    const r = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, stream: false, temperature: 0.2 }),
    });
    const text = await r.text();
    console.log("CHAT(JSON) status:", r.status, "body:", text.slice(0, 400));
    return new Response(text, { status: r.status, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }

  // ---------- 正式：流式路径（SSE → 模板事件） ----------
  const upstream = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.2 }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.log("OpenAI upstream error:", upstream.status, detail.slice(0, 400));
    return new Response(JSON.stringify({ error: "OpenAI upstream error", status: upstream.status, detail }),
      { status: upstream.status, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }

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

      // 兼容 \r\n 和 \n\n 作为事件边界
      let sepIndex: number;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1 || (sepIndex = buffer.indexOf("\r\n\r\n")) !== -1) {
        const sepLen = buffer.startsWith("\r\n", sepIndex - 1) ? 4 : 2;
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + sepLen);

        // 逐行解析 data:
        const lines = rawEvent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();

          if (payload === "[DONE]") {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
            controller.close();
            return;
          }

          // 有些模型/中间层会发心跳/非 JSON 行，直接忽略
          let json: any;
          try { json = JSON.parse(payload); } catch { continue; }

          const delta = json?.choices?.[0]?.delta;
          const content = typeof delta?.content === "string" ? delta.content : "";

          // 过滤空/纯空白增量，避免前端出现“空白回复”
          if (content.trim().length === 0) continue;

          // 按模板协议发出：{"response":"<增量>","done":false}
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ response: content, done: false })}\n\n`
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

        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const reader = upstream.body.getReader();
        let buf = "";
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { value, done } = await reader.read();
              if (done) {
                console.log("Stream completed");
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
                  console.log("Parsed payload:", payload);
                  if (payload === "[DONE]" || payload.includes('"finish_reason":"stop"')) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
                    controller.close();
                    return;
                  }
                  try {
const json = JSON.parse(payload);
const delta = json.choices?.[0]?.delta;
// 仅当有真正文本增量时才推送
const content = typeof delta?.content === "string" ? delta.content : "";
if (content.trim().length === 0) {
  // 忽略空块/仅有 role 的块，避免前端渲染空白
  continue;
}

controller.enqueue(
  encoder.encode(`data: ${JSON.stringify({ response: content, done: false })}\n\n`)
);
                  } catch (e) {
                    console.error(`Failed to parse SSE payload: ${payload}, error: ${e}`);
                  }
                }
              }
            } catch (e) {
              console.error("Stream pull error:", e);
              controller.error(e);
            }
          },
          cancel() {
            try {
              reader.cancel();
            } catch (e) {
              console.error("Failed to cancel upstream reader:", e);
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
      } catch (e) {
        clearTimeout(timeoutId);
        console.error(`Fetch error (attempt ${attempt}/${maxRetries}):`, e);
        if (attempt < maxRetries) {
          console.log(`Retrying (${attempt + 1}/${maxRetries})...`);
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        throw e;
      }
    }
    throw new Error("Max retries reached");
  } catch (e) {
    console.error("HandleChat error:", e, "Stack:", e.stack);
    return new Response(JSON.stringify({ error: String(e), stack: e.stack }), {
      status: 500,
      headers: {
        "content-type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}
