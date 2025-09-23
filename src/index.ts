/**
 * Cloudflare Worker → OpenAI Responses API (SSE passthrough with adaptation)
 *
 * - GET  /api/chat?q=hello
 * - POST /api/chat {messages:[...]}
 * - GET  /api/ping
 * - GET  /api/debug
 *
 * 兼容点：
 * - /responses 流式
 * - 非 thinking 模型：支持 temperature/top_p
 * - thinking 模型：不传 temperature/top_p，支持 reasoning.effort
 * - 400 自动回退（去掉不支持的参数重试）
 * - SSE 错误透传到前端
 */

// ===== 常量 =====
const DEFAULT_API_BASE = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5-chat-latest";
const DEFAULT_SYSTEM_PROMPT =
  "You are a senior bilingual (中英双语) analyst and writer. When the user asks for explanations, think step-by-step but keep the final answer concise, structured, and actionable. Prefer clear headings and short lists. Add quick checks or caveats when needed. If you are unsure, say so and state your assumptions. Use simple, precise wording; avoid purple prose. 默认用用户的语言回答；如果用户用中文，你用中文并保留必要的英文术语。";

const te = new TextEncoder();

// ===== 小工具 =====
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
function sseEncode(o: unknown): Uint8Array {
  return te.encode(`data: ${JSON.stringify(o)}\n\n`);
}
function sseDone(): Uint8Array {
  return te.encode(`data: [DONE]\n\n`);
}
function sseErrorResponse(status: number, detail: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        sseEncode({
          id: "cmpl-error",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                content: `⚠️ Upstream error ${status}: ${String(detail).slice(0, 1000)}`,
              },
              finish_reason: null,
            },
          ],
        })
      );
      controller.enqueue(
        sseEncode({
          id: "cmpl-stop",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })
      );
      controller.enqueue(sseDone());
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ===== 主处理器 =====
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    try {
      const url = new URL(request.url);
      const apiBase = (env.OPENAI_API_BASE || DEFAULT_API_BASE).trim();
      const model = (env.OPENAI_MODEL || DEFAULT_MODEL).trim();
      const SYSTEM_PROMPT = env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;

      // 根/静态兜底
      if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
        const html = `<!doctype html><meta charset="utf-8">
<title>LLM Chat</title>
<body style="font-family:system-ui;margin:40px">
<h2>LLM Chat App</h2>
<ul>
  <li><code>/api/ping</code></li>
  <li><code>/api/chat?q=hello</code></li>
  <li><code>/api/debug</code></li>
</ul>
</body>`;
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // CORS 预检
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

      // /api/debug
      if (url.pathname === "/api/debug") {
        return json({
          OPENAI_API_KEY: env.OPENAI_API_KEY ? "set" : "not set",
          OPENAI_MODEL: env.OPENAI_MODEL || "not set",
          OPENAI_API_BASE: env.OPENAI_API_BASE || "not set",
          effective_model: model,
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
            headers: {
              "content-type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        } catch (e) {
          return json({ error: String(e) }, 500);
        }
      }

      // /api/chat
      if (url.pathname === "/api/chat") {
        // 1) 组装 messages
        type Msg = { role: "system" | "user" | "assistant"; content: string };
        let messages: Msg[];

        if (request.method === "GET") {
          const q = url.searchParams.get("q") || "Hello";
          messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: q },
          ];
        } else if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const userMsgs = Array.isArray((body as any)?.messages)
            ? (body as any).messages
            : [];
          messages = userMsgs.length
            ? userMsgs
            : [{ role: "user", content: "Hello" }];
          if (!messages.some((m) => m.role === "system")) {
            messages.unshift({ role: "system", content: SYSTEM_PROMPT });
          }
        } else {
          return json({ error: "Method not allowed" }, 405);
        }

        // 2) 参数（query/env）
        const qMax = url.searchParams.get("max_tokens") ?? url.searchParams.get("max_output_tokens");
        const qSeed = url.searchParams.get("seed");
        const qT = url.searchParams.get("temperature");
        const qTP = url.searchParams.get("top_p");

        const max_output_tokens =
          qMax !== null
            ? Number(qMax)
            : env.OPENAI_MAX_TOKENS
            ? Number(env.OPENAI_MAX_TOKENS)
            : 1024;

        const seed =
          qSeed !== null
            ? Number(qSeed)
            : env.OPENAI_SEED
            ? Number(env.OPENAI_SEED)
            : undefined;

        const isThinking = /thinking/i.test(model);
        const supportsSampling = !isThinking;

        const temperature =
          qT !== null
            ? Number(qT)
            : env.OPENAI_TEMPERATURE
            ? Number(env.OPENAI_TEMPERATURE)
            : 0.7;

        const top_p =
          qTP !== null
            ? Number(qTP)
            : env.OPENAI_TOP_P
            ? Number(env.OPENAI_TOP_P)
            : 1.0;

        // 3) 组织 payload（根据模型类型传递不同字段）
        const payload: Record<string, unknown> = {
          model,
          input: messages,
          stream: true,
          max_output_tokens,
        };
        if (seed !== undefined && !Number.isNaN(seed)) {
          payload.seed = seed;
        }
        if (supportsSampling) {
          payload.temperature = temperature;
          payload.top_p = top_p;
        } else {
          // thinking 模型：只传 reasoning，不传采样参数
          payload.reasoning = { effort: "medium" };
        }

        // 4) 请求 /responses（带一次自动回退）
        const headers = {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "OpenAI-Beta": env.OPENAI_BETA || "responses-2024-12-17",
        };

        let upstream = await fetch(`${apiBase}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        if (!upstream.ok) {
          const firstDetail = await upstream.text().catch(() => "");
          const badSampling =
            upstream.status === 400 &&
            /Unsupported parameter.*(temperature|top_p)/i.test(firstDetail);
          const badReasoning =
            upstream.status === 400 &&
            /Unsupported parameter.*reasoning\.effort/i.test(firstDetail);

          if (badSampling || badReasoning) {
            delete (payload as any).temperature;
            delete (payload as any).top_p;
            delete (payload as any).reasoning;

            upstream = await fetch(`${apiBase}/responses`, {
              method: "POST",
              headers,
              body: JSON.stringify(payload),
            });
          } else {
            return sseErrorResponse(upstream.status, firstDetail);
          }
        }

        if (!upstream.ok || !upstream.body) {
          const detail = await upstream.text().catch(() => "");
          return sseErrorResponse(upstream.status, detail);
        }

        // 5) 适配 SSE → chat-completions 风格
        const readable = upstream.body;
        const out = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              sseEncode({
                id: "cmpl-start",
                object: "chat.completion.chunk",
                choices: [
                  { index: 0, delta: { role: "assistant" }, finish_reason: null },
                ],
              })
            );

            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let closed = false;
            let lastEvent = "";

            const pushDelta = (text: string) => {
              if (!text) return;
              controller.enqueue(
                sseEncode({
                  id: "cmpl-chunk",
                  object: "chat.completion.chunk",
                  choices: [
                    { index: 0, delta: { content: text }, finish_reason: null },
                  ],
                })
              );
            };

            const pushStop = (reason = "stop") => {
              controller.enqueue(
                sseEncode({
                  id: "cmpl-stop",
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: {}, finish_reason: reason }],
                })
              );
              controller.enqueue(sseDone());
            };

            const reader = readable.getReader();

            (async () => {
              try {
                while (true) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  buffer += decoder.decode(value, { stream: true });

                  const lines = buffer.split("\n");
                  buffer = lines.pop() || "";

                  for (const raw of lines) {
                    const line = raw.trim();
                    if (!line) continue;

                    if (line.startsWith("event:")) {
                      lastEvent = line.slice(6).trim();
                      continue;
                    }
                    if (line.startsWith("data:")) {
                      const dataStr = line.slice(5).trim();

                      if (dataStr === "[DONE]") {
                        pushStop("stop");
                        closed = true;
                        break;
                      }

                      try {
                        const obj: any = JSON.parse(dataStr);
                        const type = obj?.type || lastEvent || obj?.event || "";

                        if (
                          type.endsWith(".delta") ||
                          type === "response.delta" ||
                          typeof obj.delta === "string"
                        ) {
                          const t =
                            typeof obj.delta === "string"
                              ? obj.delta
                              : typeof obj.text === "string"
                              ? obj.text
                              : typeof obj.content === "string"
                              ? obj.content
                              : (obj?.output_text?.content?.[0]?.text || "");
                          if (t) pushDelta(t);
                          continue;
                        }

                        if (
                          type.endsWith(".done") ||
                          type === "response.completed" ||
                          obj?.done === true ||
                          obj?.status === "completed"
                        ) {
                          pushStop("stop");
                          closed = true;
                          break;
                        }

                        if (typeof obj.text === "string") pushDelta(obj.text);
                        else if (typeof obj.content === "string")
                          pushDelta(obj.content);
                      } catch {
                        // 非 JSON data（心跳等）忽略
                      }
                    }
                  }

                  if (closed) break;
                }
              } catch {
              } finally {
                if (!closed) pushStop("stop");
                controller.close();
              }
            })();
          },
        });

        return new Response(out, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      return json({ error: "Not found" }, 404);
    } catch (e: any) {
      return json({ error: "Worker exception", detail: String(e) }, 500);
    }
  },
};
