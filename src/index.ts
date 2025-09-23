/**
 * Minimal passthrough: Cloudflare Worker → OpenAI Chat Completions (SSE)
 * Endpoints:
 *   GET  /api/chat?q=hello        // 调试/EventSource 兼容
 *   POST /api/chat {messages:[...]}// 标准调用
 *   GET  /api/ping                // 连通性自检
 *   GET  /api/debug               // 变量自检
 *   GET  /                        // 简单兜底页（ASSETS 未绑定时）
 */

import type { Env } from "./types";

const DEFAULT_API_BASE = "https://api.openai.com/v1";
const SYSTEM_PROMPT =
   env.SYSTEM_PROMPT ||
"You are a senior bilingual (中英双语) analyst and writer. When the user asks for explanations, think step-by-step but keep the final answer concise, structured, and actionable. Prefer clear headings and short lists. Add quick checks or caveats when needed. If you are unsure, say so and state your assumptions. Use simple, precise wording; avoid purple prose. 默认用用户的语言回答；如果用户用中文，你用中文并保留必要的英文术语。";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const apiBase = env.OPENAI_API_BASE || DEFAULT_API_BASE;
      const model = env.OPENAI_MODEL || "gpt-5-thinking";

      // ==== 静态资源（兜底）====
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
<p>Assets not configured. Test endpoints:</p>
<ul>
  <li><code>/api/ping</code></li>
  <li><code>/api/chat?q=hello</code></li>
  <li><code>/api/debug</code></li>
</ul>
</body>`;
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
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
            headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        } catch (e) {
          return json({ error: String(e) }, 500);
        }
      }

      // ==== /api/chat ====
      if (url.pathname === "/api/chat") {
        // 1) 组装 messages（GET 用 q，POST 用 body）
        let messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
        if (request.method === "GET") {
          const q = url.searchParams.get("q") || "Hello";
          messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: q }
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

        // 2) 调 OpenAI（不传 temperature，避免 gpt-5* 报错）
        const queryT = url.searchParams.get("temperature");
 const queryTP = url.searchParams.get("top_p");
 const queryMax = url.searchParams.get("max_tokens");
 const querySeed = url.searchParams.get("seed");

 const temperature = queryT !== null ? Number(queryT) : (env.OPENAI_TEMPERATURE ? Number(env.OPENAI_TEMPERATURE) : 0.7);
 const top_p = queryTP !== null ? Number(queryTP) : (env.OPENAI_TOP_P ? Number(env.OPENAI_TOP_P) : 1.0);
 const max_tokens = queryMax !== null ? Number(queryMax) : (env.OPENAI_MAX_TOKENS ? Number(env.OPENAI_MAX_TOKENS) : 1024);
 const seed = querySeed !== null ? Number(querySeed) : (env.OPENAI_SEED ? Number(env.OPENAI_SEED) : undefined);

 const payload: any = {
   model,
   messages,
   stream: true,
   temperature,
   top_p,
   max_tokens,
 };
 if (seed !== undefined && !Number.isNaN(seed)) payload.seed = seed;
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        // 3) 失败时返回 JSON，便于定位
        if (!upstream.ok || !upstream.body) {
          const detail = await upstream.text().catch(() => "");
          return json(
            { error: "OpenAI upstream error", status: upstream.status, detail },
            upstream.status
          );
        }

        // 4) 直通 OpenAI 原始 SSE（最稳）
        return new Response(upstream.body, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            // 可选：有些反代需要这一行避免缓冲
            // "X-Accel-Buffering": "no",
          },
        });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      // 避免 1101，统一返回 JSON
      return json({ error: "Worker exception", detail: String(e) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
