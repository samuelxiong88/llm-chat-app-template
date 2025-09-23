/**
 * LLM Chat App Frontend (POST + SSE via fetch)
 *
 * - 把完整 messages（含历史）POST 到 /api/chat
 * - 解析后端返回的 text/event-stream，将 choices[0].delta.content 增量渲染
 * - 保留原 UI/状态管理接口，并支持中途取消
 */

// ===== DOM =====
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// ===== 可选：固定一些参数（gpt-5-thinking 不支持 temperature/top_p）=====
const SEED = undefined;           // 比如 7；不需要就留 undefined
const MAX_TOKENS = 1200;          // 后端会兼容 max_tokens / max_output_tokens

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

  // 显示用户消息
  addMessageToChat("user", message);

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

  // 新建助手消息气泡（增量渲染到同一个 <p>）
  const assistantMessageEl = document.createElement("div");
  assistantMessageEl.className = "message assistant-message";
  assistantMessageEl.innerHTML = "<p></p>";
  chatMessages.appendChild(assistantMessageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // 组装完整 messages（仅 user/assistant；system 由后端插入）
  const messages = buildMessages(chatHistory);

  // 可选参数通过 querystring 传给后端（兼容后端读取 URL）
  const qs = new URLSearchParams();
  if (typeof MAX_TOKENS === "number") qs.set("max_tokens", String(MAX_TOKENS));
  if (typeof SEED === "number") qs.set("seed", String(SEED));

  let acc = "";       // 累计文本
  let closed = false; // 防止多次 close

  // 用 AbortController 管理“关闭/取消”
  const controller = new AbortController();
  esRef = { close: () => controller.abort() };

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
                assistantMessageEl.querySelector("p").textContent = acc;
                chatMessages.scrollTop = chatMessages.scrollHeight;
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
    } else if (errorText) {
      assistantMessageEl.querySelector("p").textContent = errorText;
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
function addMessageToChat(role, content) {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}-message`;
  messageEl.innerHTML = `<p>${escapeHTML(content)}</p>`;
  chatMessages.appendChild(messageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// 简单防注入：转义 HTML（可选）
function escapeHTML(str) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
