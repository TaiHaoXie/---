(function (root) {
  "use strict";

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

  function normalizeText(value) {
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
    const normalized = normalizeText(targetText);
    if (!normalized) return [];
    if (normalized.length <= size * 2) return [normalized];
    return [
      normalized.slice(0, size),
      normalized.slice(-size),
    ];
  }

  function scoreCandidate(candidateText, targetText) {
    const candidate = normalizeText(candidateText);
    const target = normalizeText(targetText);
    if (!candidate || !target) return 0;
    if (candidate.includes(target) || target.includes(candidate)) return 100;

    const anchors = makeAnchors(target);
    const anchorHits = anchors.filter(anchor => anchor && candidate.includes(anchor)).length;
    if (anchorHits === anchors.length && anchors.length > 0) return 80;
    if (anchorHits > 0) return 45;

    const window = target.length > 80 ? target.slice(0, 80) : target;
    if (window.length >= 20 && candidate.includes(window)) return 60;
    return 0;
  }

  const api = {
    normalizeText,
    makeAnchors,
    scoreCandidate,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.SiflowTextMatcher = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
