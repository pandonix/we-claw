const composer = document.querySelector("#composer");
const textarea = document.querySelector("#prompt");
const conversation = document.querySelector(".conversation");

function setText(parent, selector, text) {
  const node = parent.querySelector(selector);
  if (node) node.textContent = text;
}

function autosize() {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textarea.value.trim();
  if (!text) return;

  const userMessage = document.createElement("article");
  userMessage.className = "message user-message";
  userMessage.innerHTML = "<p></p>";
  setText(userMessage, "p", text);

  const toolRow = document.createElement("article");
  toolRow.className = "tool-row";
  toolRow.innerHTML = `
    <span>◌</span>
    <div>
      <strong>chat.send</strong>
      <p></p>
    </div>
    <time>queued</time>
  `;
  setText(toolRow, "p", "等待托管 Gateway 接入后流式返回");

  const assistantMessage = document.createElement("article");
  assistantMessage.className = "message";
  assistantMessage.innerHTML = `
    <p></p>
    <small>local prototype</small>
  `;
  setText(assistantMessage, "p", "这条消息会在接入 OpenClaw Gateway 后替换为真实的 chat 事件流。");

  conversation.append(userMessage, toolRow, assistantMessage);
  textarea.value = "";
  autosize();
  assistantMessage.scrollIntoView({ block: "end", behavior: "smooth" });
});

textarea.addEventListener("input", autosize);
autosize();
