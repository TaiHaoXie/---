const assert = require("assert");
const logger = require("./siflow_backfill_logger");

const log = logger.createBackfillLog(12);
log.step("读取飞书行", "ok");
log.step("选中文本", "fail", {
  field: "A",
  tag: "R-FACT-1",
  target: "长期或高温干燥会导致蛋白质发生热降解、变性、交联甚至碳化",
});

const message = log.failureMessage(new Error("浏览器选区为空"));

assert.ok(message.includes("F10 回填失败"));
assert.ok(message.includes("第 12 行"));
assert.ok(message.includes("失败步骤：选中文本"));
assert.ok(message.includes("字段：A"));
assert.ok(message.includes("标签：R-FACT-1"));
assert.ok(message.includes("浏览器选区为空"));
assert.ok(message.includes("最近步骤"));

console.log("backfill logger tests OK");
