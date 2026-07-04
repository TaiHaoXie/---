(function (root) {
  "use strict";

  function compact(value, maxLength = 120) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + "...";
  }

  function formatDetail(details) {
    const parts = [];
    if (details?.field) parts.push("字段：" + details.field);
    if (details?.tag) parts.push("标签：" + details.tag);
    if (details?.target) parts.push("原句：" + compact(details.target));
    if (details?.message) parts.push("原因：" + compact(details.message));
    return parts.join("；");
  }

  function createBackfillLog(rowNumber) {
    const entries = [];
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
      }
      return entry;
    }

    function failureMessage(error) {
      const lines = [
        "F10 回填失败",
        rowNumber ? "表格行：第 " + rowNumber + " 行" : "",
        failedStep ? "失败步骤：" + failedStep : "",
        formatDetail(failedDetails),
        error?.message ? "错误：" + error.message : "",
        "",
        "最近步骤：",
      ].filter(Boolean);

      for (const entry of entries.slice(-8)) {
        const detail = formatDetail(entry.details);
        lines.push("- " + entry.time + " [" + entry.status + "] " + entry.name + (detail ? "；" + detail : ""));
      }

      return lines.join("\n");
    }

    return {
      entries,
      step,
      failureMessage,
    };
  }

  const api = {
    createBackfillLog,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.SiflowBackfillLogger = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
