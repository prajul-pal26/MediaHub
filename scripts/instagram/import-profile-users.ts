/**
 * One-time local importer for the user-authorized Google Sheet export.
 * It only reports row totals—never names, emails, or passwords—and encrypts
 * credentials before they reach Supabase.
 *
 * Usage:
 * npx tsx scripts/instagram/import-profile-users.ts <csv-path> <org-id> <sheet-id>
 */
import fs from "node:fs";
import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { encrypt } from "../../src/lib/encryption";

loadEnvConfig(process.cwd());

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value); value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(value); value = "";
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else value += char;
  }
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

async function main() {
  const [csvPath, orgId, sourceSheetId] = process.argv.slice(2);
  if (!csvPath || !orgId || !sourceSheetId) throw new Error("Expected CSV path, organization id and Google Sheet id.");

  const csv = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const headers = csv.shift()?.map((cell) => cell.trim().toLowerCase()) ?? [];
  const indexOf = (name: string) => headers.indexOf(name);
  const [districtIndex, instaIndex, emailIndex, passwordIndex, statusIndex] = [
    indexOf("district"), indexOf("insta_name"), indexOf("email"), indexOf("password"), indexOf("status"),
  ];
  if ([instaIndex, emailIndex, passwordIndex].some((index) => index < 0)) {
    throw new Error("The exported sheet must include insta_name, email and password headers.");
  }

  const parsed = csv.flatMap((cells, index) => {
    const instaName = cells[instaIndex]?.trim();
    const email = cells[emailIndex]?.trim();
    const password = cells[passwordIndex] ?? "";
    if (!instaName || !email || !password) return [];
    return [{
      org_id: orgId,
      source_sheet_id: sourceSheetId,
      source_row_number: index + 2,
      district: districtIndex >= 0 ? cells[districtIndex]?.trim() || null : null,
      insta_name: instaName,
      email_encrypted: encrypt(email),
      password_encrypted: encrypt(password),
      status: statusIndex >= 0 && cells[statusIndex]?.trim().toLowerCase() === "done" ? "done" : "pending",
      updated_at: new Date().toISOString(),
    }];
  });

  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) throw new Error("Local Supabase service credentials are unavailable.");
  const db = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: existing, error: existingError } = await db
    .from("insta_profile_users")
    .select("source_row_number, status")
    .eq("org_id", orgId)
    .eq("source_sheet_id", sourceSheetId)
    .in("source_row_number", parsed.map((row) => row.source_row_number));
  if (existingError) throw new Error(`Could not inspect existing profile rows: ${existingError.message}`);
  const existingStatus = new Map((existing ?? []).map((row) => [row.source_row_number, row.status]));
  for (const row of parsed) row.status = existingStatus.get(row.source_row_number) ?? row.status;

  const { error } = await db.from("insta_profile_users")
    .upsert(parsed, { onConflict: "org_id,source_sheet_id,source_row_number" });
  if (error) throw new Error(`Could not import profile rows: ${error.message}`);

  console.log(JSON.stringify({ imported: parsed.length, skipped: csv.length - parsed.length }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Import failed.");
  process.exitCode = 1;
});
