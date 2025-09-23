/**
 * Passthrough (Cloudflare Worker) → OpenAI Responses API (SSE)
 * - GET  /api/chat?q=hello        // 简单调试（单轮）
 * - POST /api/chat {messages:[...]} // 标准（带完整历史）
 * - GET  /api/ping
 * - GET  /api/debug
 * - GET  /                        // 兜底页（未绑定 ASSETS 时）
 */

import type { Env } from "./types";

const DEFAULT_API_BASE = "https://api.openai.com/v1";

// 兜底系统提示（可用 env.SYSTEM_PROMPT 覆盖）
const DEFAULT_SYSTEM_PROMPT =
  "You are a senior bilingual (中英双语) analyst and writer. When the user asks for explanations, think step-by-step but keep the final answer concise, structured, and actionable. Prefer clear headings and short lists. Add quick checks or caveats when needed. If you are unsure, say so and state your assumptions. Use simple, precise wording; avoid purple prose. 默认用用户的语言回答；如果用户用中文，你用中文并保留必要的英文术语。";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// --- 简易 SSE 编码 ---
const te = new TextEncoder();
function sseLine(data: string) {
  // data 已经是 “data: ...\n\n” 结构的主体；这里只做统一编码
  return te.encode(data);
}
function sseData(payload: unknown) {
  return sseLine(`data: ${JSON.stringify(payload)}\n\n`);
}
function sseDone() {
  return sseLine(`data: [DONE]\n\n`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const apiBase = env.OPENAI_API_BASE || DEFAULT_API_BASE;
      const model = env.OPENAI_MODEL || "gpt-5-thinking";
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

        // 2) 采样/长度（Responses API 字段名稍有不同）
        const queryT = url.searchParams.get("temperature");
        const queryTP = url.searchParams.get("top_p");
        const queryMax = url.searchParams.get("max_tokens") ?? url.searchParams.get("max_output_tokens");
        const querySeed = url.searchParams.get("seed");

        const temperature =
          queryT !== null
            ? Number(queryT)
            : env.OPENAI_TEMPERATURE
            ? Number(env.OPENAI_TEMPERATURE as any)
            : 0.7;

        const top_p =
          queryTP !== null
            ? Number(queryTP)
            : env.OPENAI_TOP_P
            ? Number(env.OPENAI_TOP_P as any)
            : 1.0;

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

        // 3) 组织 Responses API payload
        const payload: Record<string, unknown> = {
          model,
          input: messages, // Responses API 接受 role/content 结构
          stream: true,
          temperature,
          top_p,
          max_output_tokens,
          reasoning: { effort: "medium" }, // 可按需调 small/medium/large
        };
        if (seed !== undefined && !Number.isNaN(seed)) {
          (payload as any).seed = seed;
        }

        // 4) 请求 Responses API（SSE）
        const upstream = await fetch(`${apiBase}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
            // 一般不需要额外 Beta 头；若你的账号要求，可在此加：
            // "OpenAI-Beta": "responses-2024-12-17",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(payload),
        });

        if (!upstream.ok || !upstream.body) {
          const detail = await upstream.text().catch(() => "");
          return json(
            {
              error: "OpenAI upstream error",
              status: upstream.status,
              detail,
            },
            upstream.status
          );
        }

        // 5) 适配 SSE：把 Responses 流转换成 chat-completions 风格
        //    - 前端仍然按 choices[0].delta.content 增量解析
        const readable = upstream.body;

        const out = new ReadableStream<Uint8Array>({
          start(controller) {
            // 先发一条带 role 的增量（很多前端忽略它，也没关系）
            controller.enqueue(
              sseData({
                id: "cmpl-start",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              })
            );

            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let closed = false;
            let lastEvent = ""; // 记录 upstream 的 event 名称（有些实现会有 event: xxx）

            const pushDelta = (text: string) => {
              if (!text) return;
              controller.enqueue(
                sseData({
                  id: "cmpl-chunk",
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                })
              );
            };

            const pushStop = (reason: string = "stop") => {
              controller.enqueue(
                sseData({
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

                  // 按行拆分
                  const lines = buffer.split("\n");
                  buffer = lines.pop() || "";

                  for (const raw of lines) {
                    const line = raw.trim();
                    if (!line) continue;

                    // 处理 Responses API 的 SSE 结构
                    if (line.startsWith("event:")) {
                      lastEvent = line.slice(6).trim();
                      continue;
                    }
                    if (line.startsWith("data:")) {
                      const dataStr = line.slice(5).trim();

                      // 个别实现可能用 [DONE]
                      if (dataStr === "[DONE]") {
                        pushStop("stop");
                        closed = true;
                        break;
                      }

                      // 解析 JSON
                      try {
                        const obj: any = JSON.parse(dataStr);

                        // 适配几种常见字段（尽量健壮）：
                        // 1) Responses API 常见：event: response.output_text.delta => { delta: "..." }
                        // 2) 或 { type: "response.output_text.delta", delta: "..." }
                        // 3) 某些实现：{ text: "..." } 或 { content: "..." }
                        // 4) 可能存在 { type: "response.completed" } / { event: "...done" }
                        const type =
                          obj?.type ||
                          lastEvent ||
                          obj?.event ||
                          "";

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
                              : typeof obj?.output_text?.content?.[0]?.text === "string"
                              ? obj.output_text.content[0].text
                              : "";
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

                        // 某些模型还会发思考/工具事件，可以忽略或自定义处理
                        // 如果 obj 里有直接可用的文本也推一下
                        if (typeof obj.text === "string") {
                          pushDelta(obj.text);
                        } else if (typeof obj.content === "string") {
                          pushDelta(obj.content);
                        }
                      } catch {
                        // data 不是 JSON —— 忽略
                      }
                    }
                  }

                  if (closed) break;
                }
              } catch (err) {
                // 读取中断/网络错误
              } finally {
                if (!closed) {
                  pushStop("stop");
                }
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
            // "X-Accel-Buffering": "no",
          },
        });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "Worker exception", detail: String(e) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
