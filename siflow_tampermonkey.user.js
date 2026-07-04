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
  const BACKFILL_URL = "http://127.0.0.1:8787/api/backfill-row";
  const FIELDS = ["prompt", "A", "B", "C", "D"];
  const BUTTON_ID = "__siflow_append_sheet_btn__";
  const BACKFILL_BUTTON_ID = "__siflow_backfill_btn__";
  const DEFAULT_BUTTON_TEXT = "F8 写入表格";
  const DEFAULT_BACKFILL_BUTTON_TEXT = "F10 回填标注";

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function getText(el) {
    return (el?.innerText || el?.textContent || "").trim();
  }

  function setButton(text, color = "#1677ff", id = BUTTON_ID) {
    const button = document.getElementById(id);
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

  function findFieldItem(field) {
    const card = findMainCard();
    if (!card) return null;
    return [...card.querySelectorAll(".ant-form-item")]
      .find(candidate => getLabel(candidate) === field);
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

  function getJson(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: "GET",
          url,
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

      fetch(url)
        .then(response => response.json())
        .then(resolve)
        .catch(() => reject(new Error("连不上本机服务。先启动终端服务。")));
    });
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function findScoreRow(field) {
    const rows = [...document.querySelectorAll("tr, [role='row'], .ant-table-row")];
    return rows.find(row => {
      if (!isVisible(row)) return false;
      const rect = row.getBoundingClientRect();
      if (rect.left < innerWidth * 0.45) return false;
      const parts = getText(row).split(/\s+/);
      return parts.includes(field);
    });
  }

  async function fillScoreAndReason(field, answer) {
    if (!answer) return;
    const row = findScoreRow(field);
    if (!row) {
      console.warn("[Siflow backfill] score row not found", field);
      return;
    }

    if (answer.score) {
      const selector = row.querySelector(".ant-select-selector, [role='combobox']");
      if (selector) {
        selector.click();
        await sleep(200);
        const option = [...document.querySelectorAll(".ant-select-item-option, [role='option']")]
          .filter(isVisible)
          .find(el => getText(el) === String(answer.score));
        if (option) option.click();
      }
    }

    if (answer.reason) {
      const controls = [...row.querySelectorAll("textarea, input")]
        .filter(isVisible)
        .filter(el => el.closest(".ant-select") == null);
      const target = controls[controls.length - 1];
      if (target) setNativeValue(target, answer.reason);
    }
  }

  function findTextRange(root, targetText) {
    const target = clean(targetText);
    if (!target) return null;

    function normalizeWithMap(value) {
      let text = "";
      const map = [];
      let lastWasSpace = false;
      for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (/\s/.test(ch)) {
          if (!lastWasSpace) {
            text += " ";
            map.push(i);
            lastWasSpace = true;
          }
        } else {
          text += ch;
          map.push(i);
          lastWasSpace = false;
        }
      }
      return { text: text.trim(), map };
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue || "";
      let index = value.indexOf(target);
      let length = target.length;

      if (index < 0 && target.length > 24) {
        const shortTarget = target.slice(0, Math.min(80, target.length));
        index = value.indexOf(shortTarget);
        length = shortTarget.length;
      }

      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + length);
        return range;
      }

      const normalizedValue = normalizeWithMap(value);
      const normalizedTarget = target.replace(/\s+/g, " ").trim();
      let normalizedIndex = normalizedValue.text.indexOf(normalizedTarget);
      let normalizedLength = normalizedTarget.length;
      if (normalizedIndex < 0 && normalizedTarget.length > 24) {
        const shortTarget = normalizedTarget.slice(0, Math.min(80, normalizedTarget.length));
        normalizedIndex = normalizedValue.text.indexOf(shortTarget);
        normalizedLength = shortTarget.length;
      }
      if (normalizedIndex >= 0) {
        const rawStart = normalizedValue.map[normalizedIndex];
        const rawEnd = normalizedValue.map[Math.min(normalizedIndex + normalizedLength - 1, normalizedValue.map.length - 1)] + 1;
        const range = document.createRange();
        range.setStart(node, rawStart);
        range.setEnd(node, rawEnd);
        return range;
      }
    }
    return null;
  }

  async function selectTextInField(field, targetText) {
    const item = findFieldItem(field);
    if (!item) throw new Error("找不到文本块：" + field);

    const root = item.querySelector(".markdown-content") || item;
    const range = findTextRange(root, targetText);
    if (!range) {
      throw new Error("在 " + field + " 里找不到原句：" + targetText.slice(0, 60));
    }

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    await sleep(250);
  }

  function findTagButton(tagCode) {
    return [...document.querySelectorAll("button")]
      .filter(isVisible)
      .find(button => {
        const text = getText(button);
        return text.includes(tagCode) && (
          button.className.includes("preview-span-tag-btn") ||
          text.startsWith("【") ||
          /^R-|^C-/.test(text)
        );
      });
  }

  async function saveActiveNote(tagCode, note) {
    await sleep(300);
    const popovers = [...document.querySelectorAll(".ant-popover")]
      .filter(isVisible)
      .filter(popover => getText(popover).includes("编辑备注"));
    const popover = popovers.find(el => getText(el).includes(tagCode)) || popovers[0];
    if (!popover) return;

    const textarea = popover.querySelector("textarea");
    if (textarea && note) setNativeValue(textarea, note);

    const save = [...popover.querySelectorAll("button")]
      .find(button => getText(button).replace(/\s+/g, "") === "保存");
    if (save) {
      save.click();
      await sleep(200);
    }
  }

  async function applyAnnotation(annotation) {
    await selectTextInField(annotation.field, annotation.target_text);

    const button = findTagButton(annotation.tag_code);
    if (!button) throw new Error("找不到标签按钮：" + annotation.tag_code);
    button.click();
    await saveActiveNote(annotation.tag_code, annotation.note || "");
  }

  async function applyBackfill() {
    try {
      setButton("取数中...", "#64748b", BACKFILL_BUTTON_ID);
      const result = await getJson(BACKFILL_URL);
      if (!result.ok) throw new Error(result.error || "读取回填行失败");

      setButton("填评分...", "#f59e0b", BACKFILL_BUTTON_ID);
      for (const field of ["A", "B", "C", "D"]) {
        await fillScoreAndReason(field, result.answers?.[field]);
      }

      setButton("打标签...", "#f59e0b", BACKFILL_BUTTON_ID);
      for (const annotation of result.annotations || []) {
        await applyAnnotation(annotation);
      }

      setButton("已回填第 " + result.row_number + " 行", "#16a34a", BACKFILL_BUTTON_ID);
      console.log("[Siflow backfill]", result);
      setTimeout(() => setButton(DEFAULT_BACKFILL_BUTTON_TEXT, "#1677ff", BACKFILL_BUTTON_ID), 1800);
    } catch (error) {
      setButton("回填失败，看弹窗", "#dc2626", BACKFILL_BUTTON_ID);
      alert(error.message || String(error));
      console.error("[Siflow backfill failed]", error);
      setTimeout(() => setButton(DEFAULT_BACKFILL_BUTTON_TEXT, "#1677ff", BACKFILL_BUTTON_ID), 2500);
    }
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

    const backfillButton = document.createElement("button");
    backfillButton.id = BACKFILL_BUTTON_ID;
    backfillButton.textContent = DEFAULT_BACKFILL_BUTTON_TEXT;
    backfillButton.style.cssText = [
      "position:fixed",
      "right:24px",
      "bottom:74px",
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
    backfillButton.addEventListener("click", applyBackfill);
    document.body.appendChild(backfillButton);
  }

  document.addEventListener("keydown", event => {
    if (event.key === "F8") {
      event.preventDefault();
      appendCurrentCase(event.shiftKey);
    }
    if (event.key === "F10") {
      event.preventDefault();
      applyBackfill();
    }
  }, true);

  setInterval(installButton, 1000);
})();
