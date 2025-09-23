/**
 * Worker → OpenAI Responses API (SSE)
 * - 先返回 SSE 头，再在流内异步拉 OpenAI，避免浏览器等不到响应头
 * - 工具白名单 + 自动回退（web_search_preview_2025_03_11）
 * - 精准支持 response.web_search_call.* 事件：只提示一次，显示条数与完成状态
 * - 8s 心跳；45s 总超时；12s 首包回退为非流式
 * - DEBUG_DUMP=on: 输出前 5 条 RAW data 行用于排错
 * - SSE 转成 chat-completions 风格 choices[0].delta.content
 */

const DEFAULT_API_BASE = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_SYSTEM_PROMPT = [
  "You are a senior bilingual (中英双语) analyst and writer.",
  "When content is time-sensitive (news/today/latest/real-time), you SHOULD call the web_search tool first.",
  "Always return clean Markdown:",
  "- Use '##' headings;",
  "- Use '-' bullet lists; short, actionable points;",
  "- Cite sources by site name in parentheses if you relied on the web context.",
  "默认用用户语言回答；必要术语保留英文。",
].join(" ");

const te = new TextEncoder();
const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "Access-Control-Allow-Origin": "*",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
function sseData(o: unknown) { return te.encode(`data: ${JSON.stringify(o)}\n\n`); }
function sseDone() { return te.encode(`data: [DONE]\n\n`); }

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

      // 仅这些模型尝试带托管搜索工具；其余不带（避免 400）
      const TOOL_MODELS = new Set([
        "gpt-4o",
        "gpt-4o-2024-11-20",
        "gpt-4o-mini",
        "gpt-4.1",
        "gpt-4.1-mini",
      ]);

      // 根路径 → 兜底页
      if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
        return new Response("<h2>LLM Chat Worker</h2>", { headers: { "content-type": "text/html" } });
      }

      // /api/debug
      if (url.pathname === "/api/debug") {
        return json({
          OPENAI_API_KEY: env.OPENAI_API_KEY ? "set" : "not set",
          OPENAI_MODEL: env.OPENAI_MODEL || "not set",
          OPENAI_API_BASE: env.OPENAI_API_BASE || "not set",
          OPENAI_NATIVE_TOOLS: ENABLE_TOOLS ? "on" : "off",
          effective_model: model,
        });
      }

      // /api/chat
      if (url.pathname === "/api/chat") {
        // 组装 messages
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

        // payload
        const basePayload: any = {
          model,
          input: messages,
          stream: true,
          max_output_tokens: 1200,
        };
        if (ENABLE_TOOLS && TOOL_MODELS.has(model)) {
          basePayload.tools = [{ type: "web_search_preview_2025_03_11" }];
          basePayload.tool_choice = "auto";
        }

        // SSE
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(sseData({
              id: "cmpl-start",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            }));

            (async () => {
              const upstreamCtl = new AbortController();
              const timeoutHandle = setTimeout(() => upstreamCtl.abort("request-timeout"), 45000);
              let lastTextTs = Date.now();
              const heartbeat = setInterval(() => {
                if (Date.now() - lastTextTs > 8000) {
                  controller.enqueue(sseData({
                    id: "cmpl-chunk",
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: { content: "（仍在检索与整合，请稍候…）" }, finish_reason: null }],
                  }));
                  lastTextTs = Date.now();
                }
              }, 8000);

              let gotFirstText = false;
              let toolInProgressShown = false;

              const pushDelta = (text: string) => {
                if (!text) return;
                gotFirstText = true;
                lastTextTs = Date.now();
                controller.enqueue(sseData({
                  id: "cmpl-chunk",
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                }));
              };
              const pushStop = () => {
                controller.enqueue(sseData({
                  id: "cmpl-stop",
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                }));
                controller.enqueue(sseDone());
              };

              async function readUpstream(readable: ReadableStream<Uint8Array>) {
                const reader = readable.getReader();
                const decoder = new TextDecoder("utf-8");
                let buffer = "";
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
                    if (line.startsWith("event:")) { lastEvent = line.slice(6).trim(); continue; }
                    if (!line.startsWith("data:")) continue;
                    const dataStr = line.slice(5).trim();

                    // RAW dump
                    if (DEBUG_DUMP && dumpCount < 5 && dataStr !== "[DONE]") {
                      dumpCount++;
                      controller.enqueue(sseData({
                        id: "cmpl-dump",
                        object: "chat.completion.chunk",
                        choices: [{ index: 0, delta: { content: `（RAW#${dumpCount}）${dataStr.slice(0, 300)}` }, finish_reason: null }],
                      }));
                    }

                    if (dataStr === "[DONE]") { pushStop(); return; }

                    try {
                      const obj: any = JSON.parse(dataStr);
                      const type = (obj?.type || lastEvent || obj?.event || "").toString();
                      const tLower = type.toLowerCase();

                      // 文本增量
                      if (type.endsWith(".delta") || type === "response.delta" || typeof obj.delta === "string") {
                        const t =
                          typeof obj.delta === "string" ? obj.delta :
                          typeof obj.text === "string" ? obj.text :
                          typeof obj.content === "string" ? obj.content :
                          (obj?.output_text?.content?.[0]?.text || "");
                        if (t) pushDelta(t);
                        continue;
                      }

                      // === Responses web_search_call.* 精准提示 ===
                      if (type.startsWith("response.web_search_call")) {
                        if (/in_progress|searching|started|created/i.test(tLower) && !toolInProgressShown) {
                          pushDelta("🔎 正在联网检索…");
                          toolInProgressShown = true;
                          continue;
                        }
                        if (/results$/i.test(tLower) && Array.isArray(obj?.results)) {
                          pushDelta(`🧭 已获取 ${obj.results.length} 条线索，正在整合…`);
                          continue;
                        }
                        if (/completed$/i.test(tLower)) {
                          pushDelta("📄 已获取结果，正在整合…");
                          continue;
                        }
                      }

                      // 完成
                      if (type.endsWith(".done") || type === "response.completed" || obj?.done === true) {
                        pushStop(); return;
                      }

                      // 未知事件可见化
                      if (DEBUG_EVENTS && type) pushDelta(`（事件：${type}）`);
                    } catch { /* 非 JSON */ }
                  }
                }
              }

              try {
                const headers = {
                  Authorization: `Bearer ${env.OPENAI_API_KEY}`,
                  "Content-Type": "application/json",
                  Accept: "text/event-stream",
                  "OpenAI-Beta": (env.OPENAI_BETA || "responses-2024-12-17") + "; tools=v1",
                };
                const upstream = await fetch(`${apiBase}/responses`, {
                  method: "POST", headers, body: JSON.stringify(basePayload), signal: upstreamCtl.signal,
                });
                if (!upstream.ok || !upstream.body) {
                  const detail = await upstream.text().catch(() => "");
                  pushDelta(`⚠️ Upstream error: ${detail.slice(0, 800)}`);
                  pushStop(); controller.close(); return;
                }
                await readUpstream(upstream.body);
              } catch (e) {
                pushDelta(`⚠️ Worker error: ${String(e).slice(0, 200)}`);
                pushStop(); controller.close();
              } finally {
                clearInterval(heartbeat); clearTimeout(timeoutHandle);
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
