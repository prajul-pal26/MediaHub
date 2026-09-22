import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { google } from "googleapis";
import { readFile } from "node:fs/promises";

const SHEET_ID = "1thhHOTKGC7LFByeh2sSu9wDBAqCOTxZMcQUv885arL4";
const SHEET_RANGE = "Sheet1!A1:F200";
const CREDENTIALS_PATH = "/Users/pranjul/workspace/governance_report/credentials/token.json";
const DESKTOP = "/Users/pranjul/Desktop";
const OUTPUT = `${DESKTOP}/instagram-username-password-import-2026-09-19.csv`;
const OLD_EMAIL_IMPORT = `${DESKTOP}/instagram-password-manager-import-2026-09-19.csv`;
const EXPECTED_HEADERS = ["id", "district", "insta_name", "email", "password", "status"];

function csv(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function main() {
  const token = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8"));
  const auth = new google.auth.OAuth2(token.client_id, token.client_secret);
  auth.setCredentials({ refresh_token: token.refresh_token });

  const sheets = google.sheets({ version: "v4", auth });
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
  });
  const values = result.data.values ?? [];
  const headers = (values.shift() ?? []).map((value) => String(value).trim().toLowerCase());
  if (headers.join("|") !== EXPECTED_HEADERS.join("|")) {
    throw new Error("The connected Sheet no longer has the expected profile columns.");
  }

  const profiles = values.map((row, index) => ({
    sourceRow: index + 2,
    username: String(row[2] ?? "").trim(),
    password: String(row[4] ?? ""),
  }));
  if (profiles.length !== 75 || profiles.some((profile) => !profile.username || !profile.password)) {
    throw new Error("The connected Sheet must contain exactly 75 complete profile rows.");
  }
  const uniqueUsernames = new Set(profiles.map((profile) => profile.username.toLocaleLowerCase()));
  if (uniqueUsernames.size !== profiles.length) {
    throw new Error("The connected Sheet contains duplicate Instagram usernames.");
  }

  const content = [
    "url,username,password",
    ...profiles.map((profile) => ["https://www.instagram.com/", profile.username, profile.password].map(csv).join(",")),
    "",
  ].join("\n");
  const temporaryOutput = `${OUTPUT}.tmp-${process.pid}`;
  await writeFile(temporaryOutput, content, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryOutput, 0o600);
  await rename(temporaryOutput, OUTPUT);
  await chmod(OUTPUT, 0o600);
  await rm(OLD_EMAIL_IMPORT, { force: true });

  console.log(JSON.stringify({ profiles: profiles.length, outputRebuilt: true, oldEmailImportRemoved: true }));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Profile import export failed.");
  process.exitCode = 1;
});
