/**
 * LLM Chat App Frontend (POST + SSE via fetch) + Markdown rendering
 *
 * - 把完整 messages（含历史）POST 到 /api/chat
 * - 解析后端返回的 text/event-stream，将 choices[0].delta.content 增量渲染
 * - 助手输出按 Markdown 渲染（marked + DOMPurify 动态加载）
 * - 流式渲染节流，避免频繁回流卡顿
 */

// ===== DOM =====
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// ===== 可选：固定一些参数（gpt-5-thinking 不支持 temperature/top_p）=====
const SEED = undefined;           // 比如 7；不需要就留 undefined
const MAX_TOKENS = 1200;          // 后端会兼容 max_tokens / max_output_tokens

// ===== 动态加载 Markdown 依赖 =====
let markedRef = null;
let DOMPurifyRef = null;

async function loadMarkdownDeps() {
  if (markedRef && DOMPurifyRef) return { marked: markedRef, DOMPurify: DOMPurifyRef };
  // 动态插入 <script>，避免你修改 index.html
  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });

  // 选择稳定 CDN
  await loadScript("https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js");
  await loadScript("https://cdn.jsdelivr.net/npm/dompurify@3.1.7/dist/purify.min.js");

  // @ts-ignore
  markedRef = window.marked;
  // @ts-ignore
  DOMPurifyRef = window.DOMPurify;

  // 基础配置：允许换行、代码高亮（留空交给浏览器样式）
  markedRef.setOptions({
    breaks: true,
    gfm: true,
  });

  return { marked: markedRef, DOMPurify: DOMPurifyRef };
}

// ===== 状态 =====
let chatHistory = [
  {
    role: "assistant",
    content:
      "Hello! I'm an ChatGPT app powered by Cestoil Workers AI. How can I help you today?",
  },
];
let isProcessing = false;
let esRef = null; // { close: fn } 兼容原来关闭接口

// ===== 文本域自适应 =====
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
});

// Enter 发送（Shift+Enter 换行）
userInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// 点击发送
sendButton.addEventListener("click", sendMessage);

// ===== 发送消息（POST + SSE）=====
async function sendMessage() {
  const message = userInput.value.trim();
  if (message === "" || isProcessing) return;

  // 锁定输入
  isProcessing = true;
  userInput.disabled = true;
  sendButton.disabled = true;

  // 显示用户消息（用户的不渲染 Markdown，只做转义）
  addMessageToChat("user", message, { renderMarkdown: false });

  // 清空输入
  userInput.value = "";
  userInput.style.height = "auto";

  // 打字中
  typingIndicator.classList.add("visible");

  // 写入历史
  chatHistory.push({ role: "user", content: message });

  // 关闭旧连接
  if (esRef && typeof esRef.close === "function") {
    try { esRef.close(); } catch {}
  }

  // 新建助手消息气泡（增量渲染到同一个容器）
  const assistantMessageEl = document.createElement("div");
  assistantMessageEl.className = "message assistant-message";
  // 用一个容器承载 HTML（Markdown 渲染结果）
  assistantMessageEl.innerHTML = `<div class="message-body"></div>`;
  const bodyEl = assistantMessageEl.querySelector(".message-body");
  chatMessages.appendChild(assistantMessageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // 组装完整 messages（仅 user/assistant；system 由后端插入）
  const messages = buildMessages(chatHistory);

  // 可选参数通过 querystring 传给后端（兼容后端读取 URL）
  const qs = new URLSearchParams();
  if (typeof MAX_TOKENS === "number") qs.set("max_tokens", String(MAX_TOKENS));
  if (typeof SEED === "number") qs.set("seed", String(SEED));

  let acc = "";       // 累计文本（原始 markdown）
  let closed = false; // 防止多次 close

  // 用 AbortController 管理“关闭/取消”
  const controller = new AbortController();
  esRef = { close: () => controller.abort() };

  // 确保 Markdown 依赖已加载
  let marked, DOMPurify;
  try {
    ({ marked, DOMPurify } = await loadMarkdownDeps());
  } catch {
    // 依赖加载失败时，退化为纯文本显示
    marked = null;
    DOMPurify = null;
  }

  // 流式渲染节流（避免每个字符都重排）
  let rafPending = false;
  const renderNow = () => {
    if (marked && DOMPurify) {
      const html = marked.parse(acc);
      bodyEl.innerHTML = DOMPurify.sanitize(html, { ALLOWED_TAGS: false, ALLOWED_ATTR: false });
    } else {
      bodyEl.textContent = acc; // 退化策略
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
    rafPending = false;
  };
  const scheduleRender = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(renderNow);
  };

  try {
    const resp = await fetch(`/api/chat${qs.toString() ? "?" + qs.toString() : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ messages }),
    });

    if (!resp.ok || !resp.body) {
      safeClose("Sorry, upstream error.");
    } else {
      // 逐行解析 SSE：读取 text/event-stream，处理 data: 行
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // 按行切分
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;

          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();

            // [DONE] 结束
            if (data === "[DONE]") {
              safeClose();
              break;
            }

            // 尝试用 chat-completions 风格解析（后端已适配）
            try {
              const obj = JSON.parse(data);
              const delta = obj?.choices?.[0]?.delta || {};

              // 第一包可能只有 role，无 content
              if (typeof delta.content === "string") {
                acc += delta.content;
                scheduleRender();
              }
            } catch {
              // data 不是 JSON（如心跳），忽略
            }
          }
        }
      }

      // 某些实现读完流但未显式发 [DONE]
      safeClose();
    }
  } catch (err) {
    // 连接或网络错误
    safeClose("Sorry, there was a connection error.");
  }

  function safeClose(errorText) {
    if (closed) return;
    closed = true;

    try { controller.abort(); } catch {}

    // 关闭“打字中”
    typingIndicator.classList.remove("visible");

    // 将累计回答写入历史；若异常且没有内容，则显示错误
    if (acc && acc.trim().length > 0) {
      chatHistory.push({ role: "assistant", content: acc });
      // 最后一帧补渲染一次，确保完整 markdown 应用
      if (marked && DOMPurify) {
        const html = marked.parse(acc);
        bodyEl.innerHTML = DOMPurify.sanitize(html, { ALLOWED_TAGS: false, ALLOWED_ATTR: false });
      } else {
        bodyEl.textContent = acc;
      }
    } else if (errorText) {
      bodyEl.textContent = errorText;
    }

    // 解锁输入
    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
    userInput.focus();
  }
}

// ===== 工具：把历史转 messages =====
function buildMessages(history) {
  // history 格式：[{role: "user"|"assistant", content: string}, ...]
  // 如果你需要限制上下文长度，可在这里做裁剪（如只保留最近 N 轮）
  const msgs = [];
  for (const m of history) {
    // 只要 role 和 content；后端负责插入 system
    msgs.push({ role: m.role, content: m.content });
  }
  return msgs;
}

// ===== UI：追加消息气泡 =====
function addMessageToChat(role, content, opts = { renderMarkdown: false }) {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}-message`;
  // 用户消息：只做转义，不渲染 markdown；助手欢迎语（初始化）也走这个
  if (!opts.renderMarkdown) {
    messageEl.innerHTML = `<div class="message-body">${escapeHTML(content)}</div>`;
  } else {
    messageEl.innerHTML = `<div class="message-body">${content}</div>`;
  }
  chatMessages.appendChild(messageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// 简单防注入：转义 HTML（用于用户消息）
function escapeHTML(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
