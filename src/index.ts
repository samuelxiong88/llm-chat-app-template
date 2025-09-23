/**
 * Worker → OpenAI Responses API (SSE)
 * - 先返回 SSE 头，随后在流内异步拉 OpenAI，避免浏览器等不到响应头
 * - 工具白名单 + 自动回退（web_search_preview_2025_03_11）
 * - 工具事件提示、8s 心跳、45s 总超时
 * - DEBUG_DUMP=on: 输出前 5 条 RAW data 行用于排错
 * - SSE 转成 chat-completions 风格 choices[0].delta.content
 */

const DEFAULT_API_BASE = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_SYSTEM_PROMPT =
  "You are a senior bilingual (中英双语) analyst and writer. When the user asks for explanations, think step-by-step but keep the final answer concise, structured, and actionable. Prefer clear headings and short lists. Add quick checks or caveats when needed. If you are unsure, say so and state your assumptions. Use simple, precise wording; avoid purple prose. 默认用用户的语言回答；如果用户用中文，你用中文并保留必要的英文术语。";

const te = new TextEncoder();
const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
function sseData(o: unknown) {
  return te.encode(`data: ${JSON.stringify(o)}\n\n`);
}
function sseDone() {
  return te.encode(`data: [DONE]\n\n`);
}
function sseErrorStream(detail: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        sseData({
          id: "cmpl-error",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: detail }, finish_reason: null }],
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
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    try {
      const url = new URL(request.url);
      const apiBase = (env.OPENAI_API_BASE || DEFAULT_API_BASE).trim();
      const model = (env.OPENAI_MODEL || DEFAULT_MODEL).trim();
      const SYSTEM_PROMPT = env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;

      const ENABLE_TOOLS = String(env.OPENAI_NATIVE_TOOLS || "").toLowerCase() === "on";
      const DEBUG_EVENTS = String(env.DEBUG_EVENTS || "").toLowerCase() === "on";
      const DEBUG_DUMP = String(env.DEBUG_DUMP || "").toLowerCase() === "on";

      // 仅以下模型尝试带托管搜索工具；其余不带（避免 400）
      const TOOL_MODELS = new Set([
        "gpt-4o",
        "gpt-4o-2024-11-20",
        "gpt-4o-mini",
        "gpt-4.1",
        "gpt-4.1-mini",
      ]);

      // 兜底页
      if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
        const html = `<!doctype html><meta charset="utf-8"><title>LLM Chat</title>
<body style="font-family:system-ui;margin:40px">
<h2>LLM Chat App</h2>
<ul>
  <li><code>/api/ping</code></li>
  <li><code>/api/chat?q=hello</code></li>
  <li><code>/api/debug</code></li>
  <li><code>/api/health</code></li>
</ul>
</body>`;
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
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

      // 调试
      if (url.pathname === "/api/debug") {
        return json({
          OPENAI_API_KEY: env.OPENAI_API_KEY ? "set" : "not set",
          OPENAI_MODEL: env.OPENAI_MODEL || "not set",
          OPENAI_API_BASE: env.OPENAI_API_BASE || "not set",
          OPENAI_NATIVE_TOOLS: ENABLE_TOOLS ? "on" : "off",
          effective_model: model,
        });
      }

      // 健康检查（非流式，1-2s 应返回 OK）
      if (url.pathname === "/api/health") {
        const payload = {
          model,
          input: [
            { role: "system", content: "Reply with 'OK' only." },
            { role: "user", content: "ping" },
          ],
          stream: false,
          max_output_tokens: 16,
        };
        const r = await fetch(`${apiBase}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "OpenAI-Beta": env.OPENAI_BETA || "responses-2024-12-17",
          },
          body: JSON.stringify(payload),
        });
        const t = await r.text().catch(() => "");
        return new Response(t || "no-body", {
          status: r.status,
          headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      // ping
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
          return json({ error: String(e) }, 500);
        }
      }

      // chat
      if (url.pathname === "/api/chat") {
        // 1) 组装 messages
        type Msg = { role: "system" | "user" | "assistant"; content: string };
        let messages: Msg[] = [];
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

        // 2) 参数
        const qMax = url.searchParams.get("max_tokens") ?? url.searchParams.get("max_output_tokens");
        const qSeed = url.searchParams.get("seed");
        const qT = url.searchParams.get("temperature");
        const qTP = url.searchParams.get("top_p");

        const isThinking = /thinking/i.test(model);
        const supportsSampling = !isThinking;

        const max_output_tokens =
          qMax !== null ? Number(qMax) : env.OPENAI_MAX_TOKENS ? Number(env.OPENAI_MAX_TOKENS) : 1024;

        const seed =
          qSeed !== null ? Number(qSeed) : env.OPENAI_SEED ? Number(env.OPENAI_SEED) : undefined;

        const temperature =
          qT !== null ? Number(qT) : env.OPENAI_TEMPERATURE ? Number(env.OPENAI_TEMPERATURE) : 0.7;

        const top_p =
          qTP !== null ? Number(qTP) : env.OPENAI_TOP_P ? Number(env.OPENAI_TOP_P) : 1.0;

        // 3) 构造基本 payload（暂不请求上游）
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
          basePayload.reasoning = { effort: "medium" };
        }
        if (ENABLE_TOOLS && TOOL_MODELS.has(model)) {
          basePayload.tools = [{ type: "web_search_preview_2025_03_11" }];
          basePayload.tool_choice = "auto";
        }

        // 4) 立即返回一个 SSE 流；在流内异步拉 OpenAI
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // 起始：仅发送 role（不再发送“正在连接上游”那句）
            controller.enqueue(
              sseData({
                id: "cmpl-start",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              })
            );

            (async () => {
              // 总超时
              const upstreamCtl = new AbortController();
              const REQUEST_TIMEOUT_MS = 45000;
              const timeoutHandle = setTimeout(() => upstreamCtl.abort("request-timeout"), REQUEST_TIMEOUT_MS);

              // 心跳：8s 无增量 → 友好提示
              let lastTextTs = Date.now();
              const HEARTBEAT_MS = 8000;
              const heartbeat = setInterval(() => {
                if (Date.now() - lastTextTs > HEARTBEAT_MS) {
                  controller.enqueue(
                    sseData({
                      id: "cmpl-chunk",
                      object: "chat.completion.chunk",
                      choices: [
                        {
                          index: 0,
                          delta: { content: "（仍在检索与整合，请稍候…）" },
                          finish_reason: null,
                        },
                      ],
                    })
                  );
                  lastTextTs = Date.now();
                }
              }, HEARTBEAT_MS);

              let gotFirstText = false; // 首个正文是否已到

              const pushDelta = (text: string) => {
                if (!text) return;
                gotFirstText = true;
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

              // 读取并转译上游流
              async function readUpstream(readable: ReadableStream<Uint8Array>) {
                const reader = readable.getReader();
                const decoder = new TextDecoder("utf-8");
                let buffer = "";
                let closed = false;
                let lastEvent = "";
                let dumpCount = 0;

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
                    if (!line.startsWith("data:")) continue;

                    const dataStr = line.slice(5).trim();

                    // DEBUG_DUMP: 把前 5 条 RAW data 显示出来
                    if (DEBUG_DUMP && dumpCount < 5 && dataStr !== "[DONE]") {
                      dumpCount++;
                      controller.enqueue(
                        sseData({
                          id: "cmpl-dump",
                          object: "chat.completion.chunk",
                          choices: [
                            {
                              index: 0,
                              delta: { content: `（RAW#${dumpCount}）${dataStr.slice(0, 300)}` },
                              finish_reason: null,
                            },
                          ],
                        })
                      );
                    }

                    if (dataStr === "[DONE]") {
                      pushStop("stop");
                      closed = true;
                      break;
                    }

                    try {
                      const obj: any = JSON.parse(dataStr);
                      const type = (obj?.type || lastEvent || obj?.event || "").toString();
                      const tLower = type.toLowerCase();

                      // 文本增量
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

                      // 工具事件提示（更宽匹配）
                      if (
                        /(tool_call|tool)\.(started|created)/i.test(tLower) ||
                        /web_search/.test(JSON.stringify(obj || {}))
                      ) {
                        pushDelta("🔎 正在联网检索…");
                        continue;
                      }
                      if (/(tool_call|tool)\.(completed|finish|finished)/i.test(tLower)) {
                        pushDelta("📄 已获取结果，正在整合…");
                        continue;
                      }
                      if (/progress|working|searching|retrieving/i.test(tLower)) {
                        pushDelta("（检索进行中…）");
                        continue;
                      }

                      // 完成
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

                      // 未知事件可见化（调试/兜底）
                      if (DEBUG_EVENTS && type) {
                        pushDelta(`（事件：${type}）`);
                      }
                    } catch {
                      // 非 JSON 行忽略（或依靠 DEBUG_DUMP 已显示）
                    }
                  }
                  if (closed) break;
                }
              }

              try {
                const headers = {
                  Authorization: `Bearer ${env.OPENAI_API_KEY}`,
                  "Content-Type": "application/json",
                  Accept: "text/event-stream",
                  "OpenAI-Beta":
                    (env.OPENAI_BETA ? String(env.OPENAI_BETA) : "responses-2024-12-17") + "; tools=v1",
                };

                // 第一次（可能带工具）
                let payload = basePayload;
                let upstream = await fetch(`${apiBase}/responses`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify(payload),
                  signal: upstreamCtl.signal,
                });

                // 400 → 自动回退（tools/参数不被支持）
                if (!upstream.ok) {
                  const firstDetail = await upstream.text().catch(() => "");
                  const lower = firstDetail.toLowerCase();
                  const toolsProblem =
                    upstream.status === 400 &&
                    ((/invalid_value/.test(lower) && /tools/.test(lower)) ||
                      (/not supported with/.test(lower) && /tool/.test(lower)) ||
                      (/unsupported/.test(lower) && /tool/.test(lower)) ||
                      /unknown tool/.test(lower) ||
                      (/param/.test(lower) && /tools/.test(lower)));
                  const badSampling =
                    upstream.status === 400 &&
                    /unsupported/.test(lower) &&
                    /(temperature|top_p)/i.test(lower);
                  const badReasoning =
                    upstream.status === 400 &&
                    /unsupported/.test(lower) &&
                    /reasoning\.effort/i.test(lower);

                  if (toolsProblem || badSampling || badReasoning) {
                    payload = { model, input: messages, stream: true, max_output_tokens };
                    if (seed !== undefined && !Number.isNaN(seed)) (payload as any).seed = seed;
                    upstream = await fetch(`${apiBase}/responses`, {
                      method: "POST",
                      headers,
                      body: JSON.stringify(payload),
                      signal: upstreamCtl.signal,
                    });
                  } else {
                    controller.enqueue(
                      sseData({
                        id: "cmpl-error",
                        object: "chat.completion.chunk",
                        choices: [
                          {
                            index: 0,
                            delta: { content: `⚠️ Upstream ${upstream.status}: ${firstDetail.slice(0, 800)}` },
                            finish_reason: null,
                          },
                        ],
                      })
                    );
                    pushStop("stop");
                    clearInterval(heartbeat);
                    clearTimeout(timeoutHandle);
                    controller.close();
                    return;
                  }
                }

                if (!upstream.ok || !upstream.body) {
                  const detail = await upstream.text().catch(() => "");
                  controller.enqueue(
                    sseData({
                      id: "cmpl-error",
                      object: "chat.completion.chunk",
                      choices: [
                        {
                          index: 0,
                          delta: { content: `⚠️ Upstream error: ${detail.slice(0, 800)}` },
                          finish_reason: null,
                        },
                      ],
                    })
                  );
                  pushStop("stop");
                  clearInterval(heartbeat);
                  clearTimeout(timeoutHandle);
                  controller.close();
                  return;
                }

                // 首包看门狗：12s 内没有正文 → 回退为非流式
                const FIRST_PACKET_MS = 12000;
                const firstPacketTimer = setTimeout(async () => {
                  if (gotFirstText) return;
                  try { upstreamCtl.abort(); } catch {}

                  const fallback: any = {
                    model,
                    input: messages,
                    stream: false,
                    max_output_tokens,
                  };
                  if (seed !== undefined && !Number.isNaN(seed)) fallback.seed = seed;

                  const r = await fetch(`${apiBase}/responses`, {
                    method: "POST",
                    headers: {
                      ...headers,
                      Accept: "application/json",
                      "OpenAI-Beta": env.OPENAI_BETA || "responses-2024-12-17",
                    },
                    body: JSON.stringify(fallback),
                  });

                  const txt = await r.text().catch(() => "");
                  if (!r.ok || !txt) {
                    controller.enqueue(
                      sseData({
                        id: "cmpl-error",
                        object: "chat.completion.chunk",
                        choices: [
                          {
                            index: 0,
                            delta: { content: `（非流式回退失败）${txt.slice(0, 600)}` },
                            finish_reason: null,
                          },
                        ],
                      })
                    );
                    pushStop("stop");
                    clearInterval(heartbeat);
                    clearTimeout(timeoutHandle);
                    controller.close();
                    return;
                  }

                  let out = "";
                  try {
                    const j = JSON.parse(txt);
                    out =
                      j?.output_text?.[0]?.content?.[0]?.text ||
                      j?.output?.[0]?.content?.[0]?.text ||
                      j?.choices?.[0]?.message?.content ||
                      "";
                  } catch {}
                  if (!out) out = txt.slice(0, 2000);

                  controller.enqueue(
                    sseData({
                      id: "cmpl-chunk",
                      object: "chat.completion.chunk",
                      choices: [{ index: 0, delta: { content: out }, finish_reason: null }],
                    })
                  );
                  pushStop("stop");
                  clearInterval(heartbeat);
                  clearTimeout(timeoutHandle);
                  controller.close();
                }, FIRST_PACKET_MS);

                // 读取首次上游流
                await readUpstream(upstream.body);
                clearTimeout(firstPacketTimer);

                clearInterval(heartbeat);
                clearTimeout(timeoutHandle);
                if (!gotFirstText) {
                  // 没正文但流结束了，也做个收尾
                  pushStop("stop");
                }
                controller.close();
              } catch (e: any) {
                clearInterval(heartbeat);
                if (e?.name === "AbortError" || String(e).includes("request-timeout")) {
                  controller.enqueue(
                    sseData({
                      id: "cmpl-error",
                      object: "chat.completion.chunk",
                      choices: [
                        {
                          index: 0,
                          delta: { content: "⌛ 后端连接超时（可能在调起联网检索或网络受限）。" },
                          finish_reason: null,
                        },
                      ],
                    })
                  );
                  pushStop("stop");
                  controller.close();
                  return;
                }
                controller.enqueue(
                  sseData({
                    id: "cmpl-error",
                    object: "chat.completion.chunk",
                    choices: [
                      { index: 0, delta: { content: `⚠️ Worker error: ${String(e).slice(0, 800)}` }, finish_reason: null },
                    ],
                  })
                );
                pushStop("stop");
                controller.close();
              }
            })();
          },
        });

        return new Response(stream, { headers: SSE_HEADERS });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "Worker exception", detail: String(e) }, 500);
    }
  },
};
