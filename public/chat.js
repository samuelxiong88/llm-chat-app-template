/**
 * LLM Chat App Frontend (POST + SSE via fetch) + Markdown rendering + Heartbeat + Lenient SSE
 */

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

const SEED = undefined;
const MAX_TOKENS = 1200;

let markedRef = null;
let DOMPurifyRef = null;

async function loadMarkdownDeps() {
  if (markedRef && DOMPurifyRef) return { marked: markedRef, DOMPurify: DOMPurifyRef };
  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });

  await loadScript("https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js");
  await loadScript("https://cdn.jsdelivr.net/npm/dompurify@3.1.7/dist/purify.min.js");
  // @ts-ignore
  markedRef = window.marked;
  // @ts-ignore
  DOMPurifyRef = window.DOMPurify;
  markedRef.setOptions({ breaks: true, gfm: true });
  return { marked: markedRef, DOMPurify: DOMPurifyRef };
}

let chatHistory = [
  {
    role: "assistant",
    content:
      "Hello! I'm an ChatGPT app powered by Cestoil Workers AI. How can I help you today?",
  },
];
let isProcessing = false;
let esRef = null;

userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
});
userInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
sendButton.addEventListener("click", sendMessage);

async function sendMessage() {
  const message = userInput.value.trim();
  if (message === "" || isProcessing) return;

  isProcessing = true;
  userInput.disabled = true;
  sendButton.disabled = true;

  addMessageToChat("user", message, { renderMarkdown: false });

  userInput.value = "";
  userInput.style.height = "auto";
  typingIndicator.classList.add("visible");

  chatHistory.push({ role: "user", content: message });

  if (esRef && typeof esRef.close === "function") {
    try { esRef.close(); } catch {}
  }

  const assistantMessageEl = document.createElement("div");
  assistantMessageEl.className = "message assistant-message";
  assistantMessageEl.innerHTML = `<div class="message-body"></div>`;
  const bodyEl = assistantMessageEl.querySelector(".message-body");
  chatMessages.appendChild(assistantMessageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // ——给个起始占位，避免空白——
  bodyEl.textContent = "… 正在处理你的请求";

  const messages = buildMessages(chatHistory);

  const qs = new URLSearchParams();
  if (typeof MAX_TOKENS === "number") qs.set("max_tokens", String(MAX_TOKENS));
  if (typeof SEED === "number") qs.set("seed", String(SEED));

  let acc = "";
  let closed = false;

  const controller = new AbortController();
  esRef = { close: () => controller.abort() };

  let marked, DOMPurify;
  try {
    ({ marked, DOMPurify } = await loadMarkdownDeps());
  } catch {
    marked = null;
    DOMPurify = null;
  }

  // ——节流渲染——
  let rafPending = false;
  const renderNow = () => {
    if (marked && DOMPurify) {
      const html = marked.parse(acc);
      bodyEl.innerHTML = DOMPurify.sanitize(html, { ALLOWED_TAGS: false, ALLOWED_ATTR: false });
    } else {
      bodyEl.textContent = acc;
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
    rafPending = false;
  };
  const scheduleRender = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(renderNow);
  };

  // ——心跳：7s 无增量就提示还在检索——
  let lastChunkTs = Date.now();
  const HEARTBEAT_MS = 7000;
  const heartbeat = setInterval(() => {
    if (!closed && Date.now() - lastChunkTs > HEARTBEAT_MS) {
      acc += (acc ? "\n\n" : "") + "（仍在检索与整合，请稍候…）";
      scheduleRender();
      lastChunkTs = Date.now();
    }
  }, HEARTBEAT_MS);

  try {
    const resp = await fetch(`/api/chat${qs.toString() ? "?" + qs.toString() : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ messages }),
    });

    // 如果不是 SSE，直接把文本显示出来（错误/说明）
    const ct = resp.headers.get("content-type") || "";
    if (!resp.ok || !resp.body || !/text\/event-stream/i.test(ct)) {
      const errText = await resp.text().catch(() => "");
      safeClose(errText || "Sorry, upstream error.");
      return;
    }

    // SSE 解析
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();

        if (data === "[DONE]") {
          safeClose();
          break;
        }

        // ——宽松解析：先尝试 JSON；失败则当作纯文本提示——
        let handled = false;
        try {
          const obj = JSON.parse(data);
          const delta = obj?.choices?.[0]?.delta || {};

          // 正常文本增量
          if (typeof delta.content === "string") {
            acc = acc ? acc + delta.content : delta.content;
            lastChunkTs = Date.now();
            scheduleRender();
            handled = true;
          }
        } catch {
          // 非 JSON data：有些后端会直接推提示文本，这里也显示
          if (data && data !== "[DONE]") {
            acc = acc ? acc + "\n" + data : data;
            lastChunkTs = Date.now();
            scheduleRender();
            handled = true;
          }
        }

        // 如果既不是 JSON 文本增量，也不是纯文本，就忽略（可能是心跳等）
        if (!handled) {
          // no-op
        }
      }
    }

    safeClose();
  } catch (err) {
    safeClose("Sorry, there was a connection error.");
  }

  function safeClose(errorText) {
    if (closed) return;
    closed = true;

    clearInterval(heartbeat);
    try { controller.abort(); } catch {}
    typingIndicator.classList.remove("visible");

    if (acc && acc.trim().length > 0) {
      chatHistory.push({ role: "assistant", content: acc });
      // 最后一帧补渲染一次
      if (marked && DOMPurify) {
        const html = marked.parse(acc);
        bodyEl.innerHTML = DOMPurify.sanitize(html, { ALLOWED_TAGS: false, ALLOWED_ATTR: false });
      } else {
        bodyEl.textContent = acc;
      }
    } else if (errorText) {
      bodyEl.textContent = errorText;
    }

    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
    userInput.focus();
  }
}

function buildMessages(history) {
  const msgs = [];
  for (const m of history) {
    msgs.push({ role: m.role, content: m.content });
  }
  return msgs;
}

function addMessageToChat(role, content, opts = { renderMarkdown: false }) {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}-message`;
  if (!opts.renderMarkdown) {
    messageEl.innerHTML = `<div class="message-body">${escapeHTML(content)}</div>`;
  } else {
    messageEl.innerHTML = `<div class="message-body">${content}</div>`;
  }
  chatMessages.appendChild(messageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHTML(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
