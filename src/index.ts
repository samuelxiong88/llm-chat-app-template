/**
 * Cloudflare Worker → OpenAI Responses API (SSE passthrough with adaptation)
 *
 * - GET  /api/chat?q=hello          单轮调试（自动补 system）
 * - POST /api/chat {messages:[...]} 标准调用（带完整历史；后端自动补 system）
 * - GET  /api/ping                   上游连通性自检
 * - GET  /api/debug                  环境变量自检
 * - GET  /                           静态资源兜底（ASSETS 未绑定时返回说明页）
 *
 * 特性：
 * 1) 使用 /responses，兼容 gpt-5-thinking（不传 temperature/top_p）
 * 2) 将 Responses 的 SSE 事件适配为 chat-completions 的增量格式：
 *    {"choices":[{"delta":{"role":"assistant" | "content":"..."}, "index":0, "finish_reason":null}]}
 *    最后发 {"finish_reason":"stop"} 与 [DONE]
 * 3) 上游报错（4xx/5xx）也以 SSE 形式向前端输出详细原因
 */

import type { Env } from "./types";

const DEFAULT_API_BASE = "https://api.openai.com/v1";

// 兜底系统提示（可用 env.SYSTEM_PROMPT 覆盖）
const DEFAULT_SYSTEM_PROMPT =
  "You are a senior bilingual (中英双语) analyst and writer. When the user asks for explanations, think step-by-step but keep the final answer concise, structured, and actionable. Prefer clear headings and short lists. Add quick checks or caveats when needed. If you are unsure, say so and state your assumptions. Use simple, precise wording; avoid purple prose. 默认用用户的语言回答；如果用户用中文，你用中文并保留必要的英文术语。";

// ——— 工具函数 ———
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

const te = new TextEncoder();
function sseEncode(o: unknown) {
  return te.encode(`data: ${JSON.stringify(o)}\n\n`);
}
function sseDone() {
  return te.encode(`data: [DONE]\n\n`);
}

// 将上游错误透传为 SSE，方便前端直接显示错误详情
function sseErrorResponse(status: number, detail: string) {
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
                content: `⚠️ Upstream error ${status}: ${detail.slice(0, 1000)}`,
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
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
    status: 200, // SSE 正常返回，内容里描述错误
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const apiBase = env.OPENAI_API_BASE || DEFAULT_API_BASE;
      const model = env.OPENAI_MODEL || "gpt-5-thinking"; // 默认对齐 gpt-5-thinking
      const SYSTEM_PROMPT = env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;

      // ==== 静态资源（兜底）====
      if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
        try {
          if (env.ASSETS && typeof (env.ASSETS as any).fetch === "function") {
            return (env.ASSETS as any).fetch(request);
          }
        } catch {}
        const html = `<!doctype html><meta charset="utf-8">
<title>LLM Chat</title>
<body style="font-family:system-ui;margin:40px">
<h2>LLM Chat App</h2>
<p>Assets not configured. Test endpoints:</p>
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

      // ==== CORS 预检 ====
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

      // ==== /api/debug ====
      if (url.pathname === "/api/debug") {
        return json({
          OPENAI_API_KEY: env.OPENAI_API_KEY ? "set" : "not set",
          OPENAI_MODEL: env.OPENAI_MODEL || "not set",
          OPENAI_API_BASE: env.OPENAI_API_BASE || "not set",
        });
      }

      // ==== /api/ping ====
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

      // ==== /api/chat ====
      if (url.pathname === "/api/chat") {
        // 1) 组装 messages（GET 单轮；POST 带历史）
        type Msg = { role: "system" | "user" | "assistant"; content: string };
        let messages: Msg[];

        if (request.method === "GET") {
          const q = url.searchParams.get("q") || "Hello";
          messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: q },
          ];
        } else if (request.method === "POST") {
          try {
            const body = await request.json();
            const userMsgs = Array.isArray(body?.messages) ? body.messages : [];
            messages = userMsgs.length
              ? userMsgs
              : [{ role: "user", content: "Hello" }];
            if (!messages.some((m) => m.role === "system")) {
              messages.unshift({ role: "system", content: SYSTEM_PROMPT });
            }
          } catch {
            return json({ error: "Invalid JSON body" }, 400);
          }
        } else {
          return json({ error: "Method not allowed" }, 405);
        }

        // 2) 参数：gpt-5-thinking 不支持 temperature/top_p
        //    兼容 max_tokens / max_output_tokens 的 query 名
        const queryMax =
          url.searchParams.get("max_tokens") ??
          url.searchParams.get("max_output_tokens");
        const querySeed = url.searchParams.get("seed");

        const max_output_tokens =
          queryMax !== null
            ? Number(queryMax)
            : env.OPENAI_MAX_TOKENS
            ? Number(env.OPENAI_MAX_TOKENS as any)
            : 1024;

        const seed =
          querySeed !== null
            ? Number(querySeed)
            : env.OPENAI_SEED
            ? Number(env.OPENAI_SEED as any)
            : undefined;

        // 3) 组织 Responses API payload（仅传支持的字段）
        const payload: Record<string, unknown> = {
          model,
          input: messages, // Responses API 支持 role/content 数组
          stream: true,
          max_output_tokens,
          reasoning: { effort: "medium" }, // 可调 small/medium/large
        };
        if (seed !== undefined && !Number.isNaN(seed)) {
          (payload as any).seed = seed;
        }

        // 4) 请求 Responses（SSE）
        const upstream = await fetch(`${apiBase}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            // 很多租户需要 Beta 头；可用环境变量覆盖版本字符串
            "OpenAI-Beta": env.OPENAI_BETA || "responses-2024-12-17",
          },
          body: JSON.stringify(payload),
        });

        if (!upstream.ok || !upstream.body) {
          const detail = await upstream.text().catch(() => "");
          // 用 SSE 透传错误，前端能直接看到原因
          return sseErrorResponse(upstream.status, detail);
        }

        // 5) 将 Responses 的 SSE 适配为 chat-completions 风格（前端无需改）
        const readable = upstream.body;

        const out = new ReadableStream<Uint8Array>({
          start(controller) {
            // 先推送一次 role=assistant（很多前端会忽略它，不影响）
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
            let lastEvent = ""; // 记录 upstream 的 event 名

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

            const pushStop = (reason: string = "stop") => {
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

            const pump = async () => {
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

                      // 解析每条 data
                      try {
                        const obj: any = JSON.parse(dataStr);
                        const type =
                          obj?.type || lastEvent || obj?.event || "";

                        // 常见增量：*.delta，或直接有 delta/text/content
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
                              : typeof obj?.output_text?.content?.[0]?.text ===
                                "string"
                              ? obj.output_text.content[0].text
                              : "";
                          if (t) pushDelta(t);
                          continue;
                        }

                        // 完成事件：*.done / response.completed / done=true
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

                        // 其他可能含文本的字段，尽量兜底
                        if (typeof obj.text === "string") pushDelta(obj.text);
                        else if (typeof obj.content === "string")
                          pushDelta(obj.content);
                      } catch {
                        // 非 JSON data（如心跳）忽略
                      }
                    }
                  }

                  if (closed) break;
                }
              } catch {
                // 读取中断/网络错误，下面 finally 里统一收尾
              } finally {
                if (!closed) pushStop("stop");
                controller.close();
              }
            };

            pump();
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
    } catch (e) {
      // 任何 Worker 侧异常，返回 JSON，便于 Cloudflare Logs 看到栈
      return json({ error: "Worker exception", detail: String(e) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
