// ==UserScript==
// @name         Siflow append prompt ABCD to Lark Sheet
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Press F8 on a Siflow case page to append prompt/A/B/C/D to the configured Lark sheet.
// @match        https://siflow-auriga.siflow.cn/*
// @match        https://*.siflow.cn/*
// @match        http://127.0.0.1:*/*
// @match        http://localhost:*/*
// @match        file:///*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  "use strict";

  const SERVICE_URL = "http://127.0.0.1:8787/append";
  const FIELDS = ["prompt", "A", "B", "C", "D"];
  const BUTTON_ID = "__siflow_append_sheet_btn__";
  const DEFAULT_BUTTON_TEXT = "F8 写入表格";

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function getText(el) {
    return (el?.innerText || el?.textContent || "").trim();
  }

  function setButton(text, color = "#1677ff") {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    button.textContent = text;
    button.style.background = color;
  }

  function findMainCard() {
    return [...document.querySelectorAll(".ant-card")].find(card =>
      getText(card.querySelector(".ant-card-head-title")) === "主内容区"
    );
  }

  async function expandAll(card) {
    [...card.querySelectorAll("button")]
      .filter(button => getText(button) === "展开")
      .forEach(button => button.click());
    await sleep(500);
  }

  function getLabel(item) {
    const label = item.querySelector(".ant-form-item-label label");
    if (!label) return "";
    const clone = label.cloneNode(true);
    clone.querySelectorAll("button").forEach(button => button.remove());
    return getText(clone);
  }

  function clean(value) {
    return String(value || "")
      .replace(/\r/g, "")
      .replace(/(?:^|\n)\s*\d+\s*字\s*$/g, "")
      .replace(/\s+\d+\s*字\s*$/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getBlock(card, field) {
    const item = [...card.querySelectorAll(".ant-form-item")]
      .find(candidate => getLabel(candidate) === field);
    if (!item) return "";

    const markdown = item.querySelector(".markdown-content");
    const box = item.querySelector('[class*="collapsible-content-box"]');
    const source = markdown || box;
    if (!source) return "";

    const clone = source.cloneNode(true);
    clone.querySelectorAll('[class*="char-count"], button').forEach(el => el.remove());
    return clean(getText(clone));
  }

  async function extractCase() {
    const card = findMainCard();
    if (!card) {
      throw new Error("没找到主内容区。确认当前是在真实标注详情页。");
    }

    await expandAll(card);

    const data = {};
    for (const field of FIELDS) {
      data[field] = getBlock(card, field);
    }

    const missing = FIELDS.filter(field => !data[field]);
    if (missing.length) {
      throw new Error("没提取到：" + missing.join("、") + "。如果 D 在下面，先滚到 D 加载出来再按 F8。");
    }

    data.page_url = location.href.split("#", 1)[0];
    return data;
  }

  function postJson(url, payload) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: "POST",
          url,
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify(payload),
          timeout: 30000,
          onload: response => {
            try {
              resolve(JSON.parse(response.responseText || "{}"));
            } catch (error) {
              reject(new Error("本机服务返回的不是 JSON：" + response.responseText));
            }
          },
          onerror: () => reject(new Error("连不上本机服务。先启动终端服务。")),
          ontimeout: () => reject(new Error("本机服务超时。看一下终端里有没有报错。")),
        });
        return;
      }

      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(response => response.json())
        .then(resolve)
        .catch(() => reject(new Error("连不上本机服务。先启动终端服务。")));
    });
  }

  async function appendCurrentCase(force = false) {
    try {
      setButton("提取中...", "#64748b");
      const payload = await extractCase();
      payload.force = force;

      setButton("写入中...", "#f59e0b");
      const result = await postJson(SERVICE_URL, payload);

      if (!result.ok) {
        throw new Error(result.error || "写入失败");
      }

      if (result.status === "dry_run") {
        setButton("测试成功，未写表", "#16a34a");
      } else {
        setButton("已写入第 " + result.row_number + " 行", "#16a34a");
      }

      console.log("[Siflow append]", result);
      setTimeout(() => setButton(DEFAULT_BUTTON_TEXT), 1500);
    } catch (error) {
      setButton("写入失败，看弹窗", "#dc2626");
      alert(error.message || String(error));
      console.error("[Siflow append failed]", error);
      setTimeout(() => setButton(DEFAULT_BUTTON_TEXT), 2000);
    }
  }

  function installButton() {
    if (document.getElementById(BUTTON_ID)) return;
    if (!findMainCard()) return;

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.textContent = DEFAULT_BUTTON_TEXT;
    button.style.cssText = [
      "position:fixed",
      "right:24px",
      "bottom:24px",
      "z-index:999999",
      "padding:10px 14px",
      "border:0",
      "border-radius:8px",
      "background:#1677ff",
      "color:white",
      "font-size:14px",
      "font-weight:600",
      "cursor:pointer",
      "box-shadow:0 4px 16px rgba(0,0,0,.2)",
    ].join(";");
    button.addEventListener("click", () => appendCurrentCase(false));
    document.body.appendChild(button);
  }

  document.addEventListener("keydown", event => {
    if (event.key === "F8") {
      event.preventDefault();
      appendCurrentCase(event.shiftKey);
    }
  }, true);

  setInterval(installButton, 1000);
})();
