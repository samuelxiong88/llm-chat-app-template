/**
 * Worker → OpenAI Responses API with native web search + SSE
 * - 仅启用 web_search_preview（自动联网搜索）
 * - 工具/参数不被支持时自动回退为“无工具”回答
 * - 加入“工具进度提示 + 心跳”避免长时间静默
 * - SSE 以 chat-completions 风格 (choices[0].delta.content) 输出，前端无需改
 */

const DEFAULT_API_BASE = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_SYSTEM_PROMPT =
  "You are a senior bilingual (中英双语) analyst and writer. When the user asks for explanations, think step-by-step but keep the final answer concise, structured, and actionable. Prefer clear headings and short lists. Add quick checks or caveats when needed. If you are unsure, say so and state your assumptions. Use simple, precise wording; avoid purple prose. 默认用用户的语言回答；如果用户用中文，你用中文并保留必要的英文术语。";

const te = new TextEncoder();

/* ---------- helpers ---------- */
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
function sseData(o: unknown) { return te.encode(`data: ${JSON.stringify(o)}\n\n`); }
function sseDone() { return te.encode(`data: [DONE]\n\n`); }
function sseErrorResponse(status: number, detail: string) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        sseData({
          id: "cmpl-error",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: `⚠️ Upstream error ${status}: ${String(detail).slice(0, 1000)}` }, finish_reason: null }],
        })
      );
      controller.enqueue(
        sseData({
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
    status: 200,
  });
}

/* ---------- main ---------- */
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    try {
      const url = new URL(request.url);
      const apiBase = (env.OPENAI_API_BASE || DEFAULT_API_BASE).trim();
      const model = (env.OPENAI_MODEL || DEFAULT_MODEL).trim();
      const SYSTEM_PROMPT = env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
      const enableNativeTools = String(env.OPENAI_NATIVE_TOOLS || "").toLowerCase() === "on";

      // 工具白名单：只给这些模型附带 web_search
      const TOOL_MODELS = new Set([
        "gpt-4o",
        "gpt-4o-2024-11-20",
        "gpt-4o-mini",
        "gpt-4.1",
        "gpt-4.1-mini",
      ]);

      // root / static
      if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
        const html = `<!doctype html><meta charset="utf-8"><title>LLM Chat</title>
<body style="font-family:system-ui;margin:40px">
<h2>LLM Chat App</h2>
<ul>
  <li><code>/api/ping</code></li>
  <li><code>/api/chat?q=hello</code></li>
  <li><code>/api/debug</code></li>
</ul>
</body>`;
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      // CORS
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
          OPENAI_NATIVE_TOOLS: enableNativeTools ? "on" : "off",
          effective_model: model,
        });
      }

      // /api/ping
      if (url.pathname === "/api/ping") {
        try {
          const r = await fetch(`${apiBase}/models`, { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } });
          const text = await r.text();
          return new Response(text, {
            status: r.status,
            headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        } catch (e) {
          return json({ error: String(e) }, 500);
        }
      }

      // /api/chat
      if (url.pathname === "/api/chat") {
        // assemble messages
        type Msg = { role: "system" | "user" | "assistant"; content: string };
        let messages: Msg[];
        if (request.method === "GET") {
          const q = url.searchParams.get("q") || "Hello";
          messages = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: q }];
        } else if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const userMsgs = Array.isArray((body as any)?.messages) ? (body as any).messages : [];
          messages = userMsgs.length ? userMsgs : [{ role: "user", content: "Hello" }];
          if (!messages.some((m) => m.role === "system")) {
            messages.unshift({ role: "system", content: SYSTEM_PROMPT });
          }
        } else {
          return json({ error: "Method not allowed" }, 405);
        }

        // params
        const qMax = url.searchParams.get("max_tokens") ?? url.searchParams.get("max_output_tokens");
        const qSeed = url.searchParams.get("seed");
        const qT = url.searchParams.get("temperature");
        const qTP = url.searchParams.get("top_p");

        const isThinking = /thinking/i.test(model);
        const supportsSampling = !isThinking;

        const max_output_tokens =
          qMax !== null ? Number(qMax) :
          env.OPENAI_MAX_TOKENS ? Number(env.OPENAI_MAX_TOKENS) : 1024;

        const seed =
          qSeed !== null ? Number(qSeed) :
          env.OPENAI_SEED ? Number(env.OPENAI_SEED) : undefined;

        const temperature =
          qT !== null ? Number(qT) :
          env.OPENAI_TEMPERATURE ? Number(env.OPENAI_TEMPERATURE) : 0.7;

        const top_p =
          qTP !== null ? Number(qTP) :
          env.OPENAI_TOP_P ? Number(env.OPENAI_TOP_P) : 1.0;

        // payload base
        const basePayload: any = {
          model,
          input: messages,
          stream: true,
          max_output_tokens,
        };
        if (seed !== undefined && !Number.isNaN(seed)) basePayload.seed = seed;
        if (supportsSampling) {
          basePayload.temperature = temperature;
          basePayload.top_p = top_p;
        } else {
          basePayload.reasoning = { effort: "medium" }; // only for thinking models
        }

        // 原生工具：仅 web_search_preview（模型白名单 + 环境开关）
        if (enableNativeTools && TOOL_MODELS.has(model)) {
          basePayload.tools = [{ type: "web_search_preview" }]; // 或 "web_search_preview_2025_03_11"
          basePayload.tool_choice = "auto";
        }

        const headers = {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "OpenAI-Beta": env.OPENAI_BETA || "responses-2024-12-17",
        };

        let payload = basePayload;
        let upstream = await fetch(`${apiBase}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        // 若 400 因 tools/参数不被支持，自动回退
        if (!upstream.ok) {
          const firstDetail = await upstream.text().catch(() => "");
          const lower = firstDetail.toLowerCase();

          const toolsProblem = upstream.status === 400 && (
            /invalid_value/.test(lower) && /tools/.test(lower) ||
            /not supported with/.test(lower) && /tool/.test(lower) ||
            /unsupported/.test(lower) && /tool/.test(lower) ||
            /unknown tool/.test(lower) ||
            (/param/.test(lower) && /tools/.test(lower))
          );

          const badSampling = upstream.status === 400 && /unsupported/.test(lower) && /(temperature|top_p)/i.test(lower);
          const badReasoning = upstream.status === 400 && /unsupported/.test(lower) && /reasoning\.effort/i.test(lower);

          if (toolsProblem || badSampling || badReasoning) {
            payload = {
              model,
              input: messages,
              stream: true,
              max_output_tokens,
            };
            if (seed !== undefined && !Number.isNaN(seed)) (payload as any).seed = seed;
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

        // === passthrough Responses SSE → chat-completions 风格（含“工具进度提示 + 心跳”）===
        const readable = upstream.body;

        const out = new ReadableStream<Uint8Array>({
          start(controller) {
            // 起始：role=assistant
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
            let lastEvent = "";

            // 心跳：超过 N 秒无文本就提示“仍在检索…”
            let lastTextTs = Date.now();
            const HEARTBEAT_MS = 8000;
            const heartbeat = setInterval(() => {
              if (Date.now() - lastTextTs > HEARTBEAT_MS) {
                controller.enqueue(
                  sseData({
                    id: "cmpl-chunk",
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: { content: "（仍在检索与整合，请稍候…）" }, finish_reason: null }],
                  })
                );
                lastTextTs = Date.now();
              }
            }, HEARTBEAT_MS);

            const pushDelta = (text: string) => {
              if (!text) return;
              lastTextTs = Date.now();
              controller.enqueue(
                sseData({
                  id: "cmpl-chunk",
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                })
              );
            };
            const pushStop = (reason = "stop") => {
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
                        const type = (obj?.type || lastEvent || obj?.event || "").toString();

                        // ① 文本增量
                        if (
                          type.endsWith(".delta") ||
                          type === "response.delta" ||
                          typeof obj.delta === "string"
                        ) {
                          const t =
                            typeof obj.delta === "string" ? obj.delta :
                            typeof obj.text === "string" ? obj.text :
                            typeof obj.content === "string" ? obj.content :
                            (obj?.output_text?.content?.[0]?.text || "");
                          if (t) pushDelta(t);
                          continue;
                        }

                        // ② 工具事件 → 可见提示（避免“深度检索”时静默）
                        if (/tool_call\.created$/.test(type)) { pushDelta("🔎 正在联网检索…"); continue; }
                        if (/tool_call\.completed$/.test(type)) { pushDelta("📄 已获取结果，正在整合…"); continue; }

                        // ③ 完成事件
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

                        // 其他事件（心跳/状态），忽略
                      } catch {
                        // 非 JSON 行（如心跳）忽略
                      }
                    }
                  }
                  if (closed) break;
                }
              } catch {
              } finally {
                clearInterval(heartbeat);
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
    } catch (e) {
      return json({ error: "Worker exception", detail: String(e) }, 500);
    }
  },
};
