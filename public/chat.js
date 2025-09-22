/**
 * LLM Chat App Frontend  (EventSource + OpenAI raw SSE)
 *
 * Handles the chat UI interactions and communication with the backend API.
 * 后端返回 OpenAI 原始事件（choices[0].delta.content），
 * 这里用 EventSource(GET) 读取，并把增量文本累积后渲染。
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// Chat state（仍然保留历史，方便你以后切回 POST）
let chatHistory = [
  {
    role: "assistant",
    content:
      "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
  },
];
let isProcessing = false;
let esRef = null; // 当前 EventSource 连接

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);

/**
 * Sends a message to the chat API (EventSource GET) and processes the response
 * 方案 A：把用户输入放进 ?q=，后端会转为对 OpenAI 的 POST，并原样转发 SSE。
 */
async function sendMessage() {
  const message = userInput.value.trim();
  if (message === "" || isProcessing) return;

  // Disable input while processing
  isProcessing = true;
  userInput.disabled = true;
  sendButton.disabled = true;

  // Add user message to chat
  addMessageToChat("user", message);

  // Clear input
  userInput.value = "";
  userInput.style.height = "auto";

  // Show typing indicator
  typingIndicator.classList.add("visible");

  // Add message to local history（仅用于展示/以后扩展）
  chatHistory.push({ role: "user", content: message });

  // 如有旧连接，先关闭
  if (esRef && typeof esRef.close === "function") {
    try { esRef.close(); } catch {}
  }

  // Create new assistant response element（渲染增量到同一个气泡）
  const assistantMessageEl = document.createElement("div");
  assistantMessageEl.className = "message assistant-message";
  assistantMessageEl.innerHTML = "<p></p>";
  chatMessages.appendChild(assistantMessageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // ---- EventSource(GET) 建立连接 ----
  // 说明：如果你的 Worker 同时兼容 /chat 与 /api/chat，任选其一即可。
  // 这里统一用 /api/chat
  const es = new EventSource(`/api/chat?q=${encodeURIComponent(message)}`);
  esRef = es;

  let acc = "";       // 累计文本
  let closed = false; // 防止多次 close

  es.onmessage = (e) => {
    // OpenAI 的流以 "[DONE]" 收尾
    if (e.data === "[DONE]") {
      safeClose();
      return;
    }

    // 个别事件不是 JSON（心跳等），用 try/catch 保护
    try {
      const obj = JSON.parse(e.data);
      const delta = obj?.choices?.[0]?.delta || {};

      // 第一包常常只有 role（没有 content），忽略即可
      if (typeof delta.content === "string") {
        acc += delta.content;
        assistantMessageEl.querySelector("p").textContent = acc;

        // 滚动到底部
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    } catch {
      // 非 JSON 事件忽略
    }
  };

  es.onerror = () => {
    // 连接或网络错误
    safeClose("Sorry, there was a connection error.");
  };

  function safeClose(errorText) {
    if (closed) return;
    closed = true;
    try { es.close(); } catch {}

    // 隐藏 typing
    typingIndicator.classList.remove("visible");

    // 把累计的回答写入历史；若异常且没有任何内容，显示错误
    if (acc && acc.trim().length > 0) {
      chatHistory.push({ role: "assistant", content: acc });
    } else if (errorText) {
      assistantMessageEl.querySelector("p").textContent = errorText;
    }

    // Re-enable input
    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
    userInput.focus();
  }
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content) {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}-message`;
  messageEl.innerHTML = `<p>${content}</p>`;
  chatMessages.appendChild(messageEl);

  // Scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
