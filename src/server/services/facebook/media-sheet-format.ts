import type { sheets_v4 } from "googleapis";

const RULE_MARKER = "MediaHub comment count mismatch v1";

function columnName(index: number): string {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
}

/** Counts are saved as RAW strings. VALUE compares their numeric values, while
 * explicit blank checks keep an unknown count distinct from an observed zero.
 * Replace only our own rule; preserve unrelated user formatting rules. */
export function commentCountShortfallRequests(
  sheetId: number,
  columns: readonly string[],
  existing: sheets_v4.Schema$ConditionalFormatRule[] = [],
): sheets_v4.Schema$Request[] {
  const rawReported = columns.indexOf("Comments Count (Reported)");
  const reported = columns.indexOf("Reported Delta Count");
  const scraped = columns.indexOf("Comments Scraped Count");
  if (rawReported < 0 || reported < 0 || scraped < 0) throw new Error("The comment count columns are required for mismatch highlighting.");
  const scope = columns.indexOf("Comments Content Scope");
  // Prefer a Newest-panel count, with the raw Facebook badge as the fallback
  // for legacy or not-yet-scanned rows so their shortfalls remain visible.
  const raw = `$${columnName(rawReported)}2`;
  const left = `$${columnName(reported)}2`;
  const right = `$${columnName(scraped)}2`;
  const comparable = scope < 0 ? "" : `,$${columnName(scope)}2=\"observed_nodes\"`;
  const basis = `IF(LEN(TRIM(${left}))>0,VALUE(${left}),IF(LEN(TRIM(${raw}))>0,VALUE(${raw}),-1))`;
  const formula = `=IFERROR(AND(N("${RULE_MARKER}")=0${comparable},LEN(TRIM(${right}))>0,VALUE(${right})>=0,${basis}>=0,VALUE(${right})<${basis}),FALSE)`;
  const rule: sheets_v4.Schema$ConditionalFormatRule = {
    ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: scraped, endColumnIndex: scraped + 1 }],
    booleanRule: {
      condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: formula }] },
      format: { backgroundColor: { red: 1, green: 0.8, blue: 0.8 }, textFormat: { foregroundColor: { red: 0.65, green: 0, blue: 0 } } },
    },
  };
  const owned = existing.flatMap((value, index) => value.booleanRule?.condition?.type === "CUSTOM_FORMULA" &&
    value.booleanRule.condition.values?.some((entry) => entry.userEnteredValue?.includes(`N("${RULE_MARKER}")`)) ? [index] : []);
  return [
    ...owned.reverse().map((index) => ({ deleteConditionalFormatRule: { sheetId, index } })),
    { addConditionalFormatRule: { index: 0, rule } },
  ];
}
