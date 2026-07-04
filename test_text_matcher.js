const assert = require("assert");
const matcher = require("./siflow_text_matcher");

assert.strictEqual(
  matcher.normalizeText("高温 烘干， 会导致 “碳化”。"),
  matcher.normalizeText("高温烘干会导致\"碳化\"")
);

assert.ok(
  matcher.scoreCandidate(
    "羽绒的主要成分是羽毛蛋白（角蛋白），长期或高温干燥会导致蛋白质发生热降解、变性、交联甚至碳化。",
    "羽绒的主要成分是羽毛蛋白(角蛋白), 长期或高温干燥 会导致蛋白质发生热降解、变性、交联甚至碳化"
  ) >= 80
);

assert.ok(
  matcher.scoreCandidate(
    "这里有一些前文。正确做法是低温烘干，并加入网球或烘干球，帮助恢复蓬松度。",
    "正确做法是低温烘干，并加入网球或烘干球"
  ) >= 80
);

assert.strictEqual(
  matcher.scoreCandidate("完全无关的一句话", "正确做法是低温烘干，并加入网球或烘干球"),
  0
);

assert.strictEqual(
  matcher.findScoreOptionText(["0", "1", "2", "3", "4"], "3分"),
  "3"
);

assert.strictEqual(
  matcher.findScoreOptionText(["0", "1", "2", "3", "4"], "３"),
  "3"
);

assert.strictEqual(
  matcher.findScoreOptionText(["0", "1", "2", "3", "4"], "A"),
  null
);

assert.ok(
  matcher.formatScoreOptionError("A", "A", ["0", "1", "2", "3", "4"])
    .includes("页面可选：0 / 1 / 2 / 3 / 4")
);

assert.strictEqual(matcher.pickDirectScoreInputIndex(2, true), 0);
assert.strictEqual(matcher.pickDirectScoreInputIndex(1, false), 0);
assert.strictEqual(matcher.pickDirectScoreInputIndex(1, true), null);

console.log("text matcher tests OK");
