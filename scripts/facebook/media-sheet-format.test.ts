import assert from "node:assert/strict";
import { test } from "node:test";
import { commentCountShortfallRequests } from "../../src/server/services/facebook/media-sheet-format";

test("only a scraped count below the Newest-panel count is highlighted, excluding headers and covering future rows", () => {
  const requests = commentCountShortfallRequests(12, ["Post ID", "Comments Count (Reported)", "Reported Delta Count", "Comments Scraped Count", "Comments JSON"]);
  assert.equal(requests.length, 1);
  const rule = requests[0].addConditionalFormatRule!.rule!;
  assert.deepEqual(rule.ranges, [
    { sheetId: 12, startRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 },
  ]);
  assert.equal(rule.booleanRule!.format!.backgroundColor!.red, 1);
  assert.equal(rule.booleanRule!.condition!.values![0].userEnteredValue,
    '=IFERROR(AND(N("MediaHub comment count mismatch v1")=0,LEN(TRIM($D2))>0,VALUE($D2)>=0,IF(LEN(TRIM($C2))>0,VALUE($C2),IF(LEN(TRIM($B2))>0,VALUE($B2),-1))>=0,VALUE($D2)<IF(LEN(TRIM($C2))>0,VALUE($C2),IF(LEN(TRIM($B2))>0,VALUE($B2),-1))),FALSE)');
});

test("moved columns use fixed column references and relative row references", () => {
  const columns = [...Array.from({ length: 26 }, (_, i) => `Field ${i}`), "Comments Scraped Count", "Other", "Comments Count (Reported)", "Reported Delta Count"];
  const rule = commentCountShortfallRequests(7, columns)[0].addConditionalFormatRule!.rule!;
  assert.ok(rule.booleanRule!.condition!.values![0].userEnteredValue!.includes("VALUE($AA2)<IF(LEN(TRIM($AD2))>0,VALUE($AD2),IF(LEN(TRIM($AC2))>0,VALUE($AC2),-1))"));
  assert.deepEqual(rule.ranges!.map((r) => r.startColumnIndex), [26]);
});

test("repeated saves replace only owned rules in reverse index order", () => {
  const columns = ["Comments Count (Reported)", "Reported Delta Count", "Comments Scraped Count"];
  const own = commentCountShortfallRequests(5, columns)[0].addConditionalFormatRule!.rule!;
  const userRule = { booleanRule: { condition: { type: "NUMBER_GREATER", values: [{ userEnteredValue: "50" }] } } };
  const existing = [userRule, own, userRule, own];
  const before = structuredClone(existing);
  const requests = commentCountShortfallRequests(5, columns, existing);
  assert.deepEqual(requests.slice(0, 2), [
    { deleteConditionalFormatRule: { sheetId: 5, index: 3 } },
    { deleteConditionalFormatRule: { sheetId: 5, index: 1 } },
  ]);
  assert.equal(requests.filter((r) => r.addConditionalFormatRule).length, 1);
  assert.deepEqual(existing, before);
});

test("missing count columns are rejected before constructing an invalid range", () => {
  assert.throws(() => commentCountShortfallRequests(1, ["Post ID", "Comments Scraped Count"]), /count.*columns/i);
});
