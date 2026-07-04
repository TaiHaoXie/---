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

  const PUNCT_MAP = new Map([
    ["“", "\""], ["”", "\""], ["‘", "'"], ["’", "'"],
    ["（", "("], ["）", ")"], ["【", "["], ["】", "]"],
    ["：", ":"], ["；", ";"], ["，", ","], ["。", "."],
    ["！", "!"], ["？", "?"],
  ]);

  function normalizeChar(ch) {
    const code = ch.charCodeAt(0);
    if (code === 12288) return " ";
    if (code >= 65281 && code <= 65374) return String.fromCharCode(code - 65248);
    return PUNCT_MAP.get(ch) || ch;
  }

  function normalizeForMatch(value) {
    return String(value || "")
      .replace(/\r/g, "")
      .split("")
      .map(normalizeChar)
      .join("")
      .replace(/[`*_~#>\-]+/g, "")
      .replace(/\s+/g, "")
      .replace(/[.,;:!?，。；：！？、]/g, "")
      .toLowerCase()
      .trim();
  }

  function makeAnchors(targetText, size = 14) {
    const normalized = normalizeForMatch(targetText);
    if (!normalized) return [];
    if (normalized.length <= size * 2) return [normalized];
    return [normalized.slice(0, size), normalized.slice(-size)];
  }

  function scoreCandidate(candidateText, targetText) {
    const candidate = normalizeForMatch(candidateText);
    const target = normalizeForMatch(targetText);
    if (!candidate || !target) return 0;
    if (candidate.includes(target) || target.includes(candidate)) return 100;

    const anchors = makeAnchors(target);
    const anchorHits = anchors.filter(anchor => anchor && candidate.includes(anchor)).length;
    if (anchorHits === anchors.length && anchors.length > 0) return 80;
    if (anchorHits > 0) return 45;

    const prefix = target.length > 80 ? target.slice(0, 80) : target;
    return prefix.length >= 20 && candidate.includes(prefix) ? 60 : 0;
  }

  function normalizeScoreText(value) {
    const text = String(value || "")
      .replace(/\r/g, "")
      .split("")
      .map(normalizeChar)
      .join("")
      .replace(/\s+/g, "")
      .trim();
    const exact = text.match(/^[0-9]$/);
    if (exact) return exact[0];
    const withSuffix = text.match(/^([0-9])分?$/);
    if (withSuffix) return withSuffix[1];
    return text;
  }

  function findScoreOption(optionElements, score) {
    const target = normalizeScoreText(score);
    if (!target) return null;
    return optionElements.find(option => normalizeScoreText(getText(option)) === target) || null;
  }

  function formatScoreOptionError(field, score, optionElements) {
    const optionTexts = optionElements.map(getText).filter(Boolean);
    const options = optionTexts.length ? optionTexts.join(" / ") : "未检测到可见选项";
    return "评分选项不存在：" + field + " = " + score + "；页面可选：" + options;
  }

  function pickDirectScoreInputIndex(controlCount, hasReason) {
    if (controlCount <= 0) return null;
    if (hasReason && controlCount < 2) return null;
    return 0;
  }

  function getDirectInputControls(row) {
    return [...row.querySelectorAll("textarea, input")]
      .filter(isVisible)
      .filter(el => el.closest(".ant-select") == null)
      .filter(el => el.getAttribute("aria-hidden") !== "true")
      .filter(el => el.name !== "hiddenTextarea");
  }

  function compactLogText(value, maxLength = 120) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + "...";
  }

  function formatLogDetail(details) {
    const parts = [];
    if (details?.field) parts.push("字段：" + details.field);
    if (details?.tag) parts.push("标签：" + details.tag);
    if (details?.target) parts.push("原句：" + compactLogText(details.target));
    if (details?.message) parts.push("原因：" + compactLogText(details.message));
    return parts.join("；");
  }

  function createBackfillLog(rowNumber = "") {
    const entries = [];
    let currentRowNumber = rowNumber;
    let failedStep = "";
    let failedDetails = {};

    function step(name, status = "ok", details = {}) {
      const entry = {
        time: new Date().toLocaleTimeString(),
        name,
        status,
        details,
      };
      entries.push(entry);

      if (status === "fail") {
        failedStep = name;
        failedDetails = details || {};
        console.error("[Siflow F10]", name, details);
      } else {
        console.log("[Siflow F10]", status, name, details);
      }

      return entry;
    }

    function setRowNumber(value) {
      currentRowNumber = value;
    }

    function failureMessage(error) {
      const lines = [
        "F10 回填失败",
        currentRowNumber ? "表格行：第 " + currentRowNumber + " 行" : "",
        failedStep ? "失败步骤：" + failedStep : "",
        formatLogDetail(failedDetails),
        error?.message ? "错误：" + error.message : "",
        "",
        "最近步骤：",
      ].filter(Boolean);

      for (const entry of entries.slice(-8)) {
        const detail = formatLogDetail(entry.details);
        lines.push("- " + entry.time + " [" + entry.status + "] " + entry.name + (detail ? "；" + detail : ""));
      }

      return lines.join("\n");
    }

    return {
      entries,
      setRowNumber,
      step,
      failureMessage,
    };
  }

  async function runBackfillStep(log, name, details, task) {
    log.step(name, "start", details);
    try {
      const result = await task();
      log.step(name, "ok", details);
      return result;
    } catch (error) {
      log.step(name, "fail", {
        ...details,
        message: error?.message || String(error),
      });
      throw error;
    }
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
    if (!answer || (!answer.score && !answer.reason)) return "skip";

    const row = findScoreRow(field);
    if (!row) {
      throw new Error("找不到评分/理由行：" + field);
    }

    const directControls = getDirectInputControls(row);
    let scoreControl = null;

    if (answer.score) {
      const selector = row.querySelector(".ant-select-selector, [role='combobox']");
      let handledBySelect = false;
      let selectOptions = [];

      if (selector) {
        selector.click();
        await sleep(200);
        selectOptions = [...document.querySelectorAll(".ant-select-item-option, [role='option']")]
          .filter(isVisible);
        const option = findScoreOption(selectOptions, answer.score);
        if (option) {
          option.click();
          handledBySelect = true;
        }
      }

      if (!handledBySelect) {
        const scoreInputIndex = pickDirectScoreInputIndex(directControls.length, Boolean(answer.reason));
        if (scoreInputIndex == null) {
          if (selectOptions.length) throw new Error(formatScoreOptionError(field, answer.score, selectOptions));
          throw new Error("找不到评分输入框：" + field + "；可见输入框数量：" + directControls.length);
        }
        scoreControl = directControls[scoreInputIndex];
        setNativeValue(scoreControl, normalizeScoreText(answer.score));
      }
    }

    if (answer.reason) {
      const reasonControls = directControls.filter(control => control !== scoreControl);
      const target = reasonControls[reasonControls.length - 1];
      if (!target) throw new Error("找不到理由输入框：" + field);
      setNativeValue(target, answer.reason);
    }

    return "ok";
  }

  function findTextRange(root, targetText) {
    const target = clean(targetText);
    if (!target) return null;

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
    }

    const flat = flattenText(root);
    const normalizedTarget = normalizeForMatch(target);
    let match = findNormalizedRange(flat, normalizedTarget);
    if (match) return match;

    if (normalizedTarget.length > 24) {
      match = findNormalizedRange(flat, normalizedTarget.slice(0, Math.min(90, normalizedTarget.length)));
      if (match) return match;
    }

    const anchors = makeAnchors(target);
    if (anchors.length === 2) {
      const start = flat.text.indexOf(anchors[0]);
      const end = flat.text.indexOf(anchors[1], Math.max(0, start));
      if (start >= 0 && end >= start) {
        return rangeFromFlatMap(flat.map, start, end + anchors[1].length);
      }
    }

    return null;
  }

  function flattenText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const map = [];
    let text = "";
    let node;

    while ((node = walker.nextNode())) {
      const raw = node.nodeValue || "";
      for (let offset = 0; offset < raw.length; offset++) {
        const normalized = normalizeForMatch(raw[offset]);
        if (!normalized) continue;
        for (const ch of normalized) {
          text += ch;
          map.push({ node, offset });
        }
      }
    }
    return { text, map };
  }

  function rangeFromFlatMap(map, start, end) {
    if (!map[start] || !map[end - 1]) return null;
    const range = document.createRange();
    range.setStart(map[start].node, map[start].offset);
    range.setEnd(map[end - 1].node, map[end - 1].offset + 1);
    return range;
  }

  function findNormalizedRange(flat, normalizedTarget) {
    if (!normalizedTarget) return null;
    const index = flat.text.indexOf(normalizedTarget);
    if (index < 0) return null;
    return rangeFromFlatMap(flat.map, index, index + normalizedTarget.length);
  }

  function collectCandidateRanges(root, targetText) {
    const candidates = [];
    const textNodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if ((node.nodeValue || "").trim()) textNodes.push(node);
    }

    for (const node of textNodes) {
      const raw = node.nodeValue || "";
      const regex = /[^。！？.!?\n]{8,}[。！？.!?]?/g;
      let match;
      while ((match = regex.exec(raw))) {
        const snippet = clean(match[0]);
        if (snippet.length < 8) continue;
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        candidates.push({ text: snippet, range, score: scoreCandidate(snippet, targetText) });
      }
    }

    const elementCandidates = [...root.querySelectorAll("p, li")]
      .map(el => ({ el, text: clean(getText(el)) }))
      .filter(item => item.text.length >= 8)
      .map(item => {
        const range = document.createRange();
        range.selectNodeContents(item.el);
        return { text: item.text, range, score: scoreCandidate(item.text, targetText) };
      });

    return [...candidates, ...elementCandidates]
      .sort((a, b) => b.score - a.score || a.text.length - b.text.length)
      .filter((item, index, arr) => arr.findIndex(x => x.text === item.text) === index)
      .slice(0, 8);
  }

  function chooseCandidateRange(field, root, targetText) {
    const candidates = collectCandidateRanges(root, targetText);
    return new Promise((resolve, reject) => {
      const overlay = document.createElement("div");
      overlay.id = "__siflow_candidate_overlay__";
      overlay.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:1000000",
        "background:rgba(15,23,42,.35)",
        "display:flex",
        "align-items:center",
        "justify-content:center",
      ].join(";");

      const panel = document.createElement("div");
      panel.style.cssText = [
        "width:760px",
        "max-height:80vh",
        "overflow:auto",
        "background:#fff",
        "border-radius:12px",
        "box-shadow:0 12px 36px rgba(0,0,0,.24)",
        "padding:18px",
        "font-size:14px",
        "color:#0f172a",
      ].join(";");

      panel.innerHTML = `
        <h3 style="margin:0 0 8px;">没自动找到原句：${field}</h3>
        <div style="margin-bottom:10px;color:#64748b;">目标原句：</div>
        <div style="padding:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:12px;white-space:pre-wrap;">${escapeHtml(targetText)}</div>
        <div style="margin-bottom:8px;color:#64748b;">请选择页面里的对应候选，选中后会继续打标签：</div>
      `;

      const list = document.createElement("div");
      if (!candidates.length) {
        list.innerHTML = `<div style="color:#dc2626;">没有候选。请手动检查这句是否还在页面里。</div>`;
      }

      candidates.forEach((candidate, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.style.cssText = [
          "display:block",
          "width:100%",
          "text-align:left",
          "margin:8px 0",
          "padding:10px",
          "border:1px solid #cbd5e1",
          "border-radius:8px",
          "background:#fff",
          "cursor:pointer",
          "color:#0f172a",
        ].join(";");
        button.innerHTML = `<strong>#${index + 1} 匹配分 ${candidate.score}</strong><br>${escapeHtml(candidate.text.slice(0, 220))}`;
        button.onclick = () => {
          overlay.remove();
          resolve(candidate.range);
        };
        list.appendChild(button);
      });

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "取消这条";
      cancel.style.cssText = "margin-top:12px;padding:8px 12px;border:0;border-radius:8px;background:#64748b;color:white;cursor:pointer;";
      cancel.onclick = () => {
        overlay.remove();
        reject(new Error("已取消候选选择：" + targetText.slice(0, 40)));
      };

      panel.appendChild(list);
      panel.appendChild(cancel);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
    });
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function selectTextInField(field, targetText) {
    const item = findFieldItem(field);
    if (!item) throw new Error("找不到文本块：" + field);

    const root = item.querySelector(".markdown-content") || item;
    const range = findTextRange(root, targetText) || await chooseCandidateRange(field, root, targetText);

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    await sleep(250);

    if (!selection.rangeCount || selection.isCollapsed || !clean(selection.toString())) {
      throw new Error("浏览器选区为空，页面没有接受脚本划选");
    }

    return clean(selection.toString());
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

  function findActiveNotePopover(tagCode) {
    const popovers = [...document.querySelectorAll(".ant-popover")]
      .filter(isVisible)
      .filter(popover => getText(popover).includes("编辑备注"));
    return popovers.find(el => getText(el).includes(tagCode)) || popovers[0] || null;
  }

  async function waitForActiveNotePopover(tagCode, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const popover = findActiveNotePopover(tagCode);
      if (popover) return popover;
      await sleep(150);
    }
    throw new Error("点击标签后没有出现备注弹窗：" + tagCode);
  }

  async function saveActiveNote(tagCode, note) {
    const popover = await waitForActiveNotePopover(tagCode);

    const textarea = popover.querySelector("textarea");
    if (!textarea) throw new Error("备注弹窗里没有输入框：" + tagCode);
    if (textarea && note) setNativeValue(textarea, note);

    const save = [...popover.querySelectorAll("button")]
      .find(button => getText(button).replace(/\s+/g, "") === "保存");
    if (!save) throw new Error("备注弹窗里没有保存按钮：" + tagCode);

    save.click();
    await sleep(250);
    return true;
  }

  async function applyAnnotation(annotation, log, index, total) {
    const details = {
      field: annotation.field,
      tag: annotation.tag_code,
      target: annotation.target_text,
      message: index + "/" + total,
    };

    await runBackfillStep(log, "选中文本", details, () =>
      selectTextInField(annotation.field, annotation.target_text)
    );

    const button = await runBackfillStep(log, "查找标签按钮", details, async () => {
      const found = findTagButton(annotation.tag_code);
      if (!found) throw new Error("找不到标签按钮：" + annotation.tag_code);
      return found;
    });

    await runBackfillStep(log, "点击标签按钮", details, async () => {
      button.click();
      await sleep(200);
    });

    await runBackfillStep(log, "填写备注并保存", details, () =>
      saveActiveNote(annotation.tag_code, annotation.note || "")
    );
  }

  async function applyBackfill() {
    const log = createBackfillLog();
    window.__siflowBackfillLastLog = log;

    try {
      setButton("取数中...", "#64748b", BACKFILL_BUTTON_ID);
      const result = await runBackfillStep(log, "读取飞书行", {}, async () => {
        const response = await getJson(BACKFILL_URL);
        if (!response.ok) throw new Error(response.error || "读取回填行失败");
        return response;
      });
      log.setRowNumber(result.row_number);

      setButton("填评分...", "#f59e0b", BACKFILL_BUTTON_ID);
      for (const field of ["A", "B", "C", "D"]) {
        const answer = result.answers?.[field];
        if (!answer || (!answer.score && !answer.reason)) {
          log.step("跳过评分/理由", "skip", { field, message: "表格里没有评分或理由" });
          continue;
        }
        await runBackfillStep(log, "填写评分/理由", { field }, () =>
          fillScoreAndReason(field, answer)
        );
      }

      setButton("打标签...", "#f59e0b", BACKFILL_BUTTON_ID);
      const annotations = result.annotations || [];
      if (!annotations.length) {
        log.step("跳过标签", "skip", { message: "本行没有解析到标签" });
      }

      for (let index = 0; index < annotations.length; index++) {
        await applyAnnotation(annotations[index], log, index + 1, annotations.length);
      }

      setButton("已回填第 " + result.row_number + " 行", "#16a34a", BACKFILL_BUTTON_ID);
      console.log("[Siflow backfill]", result);
      console.table(log.entries.map(entry => ({
        time: entry.time,
        status: entry.status,
        step: entry.name,
        detail: formatLogDetail(entry.details),
      })));
      setTimeout(() => setButton(DEFAULT_BACKFILL_BUTTON_TEXT, "#1677ff", BACKFILL_BUTTON_ID), 1800);
    } catch (error) {
      const message = log.failureMessage(error);
      setButton("回填失败，看日志", "#dc2626", BACKFILL_BUTTON_ID);
      alert(message);
      console.error("[Siflow backfill failed]", message, error);
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
