import { google } from "googleapis";
import { decrypt } from "@/lib/encryption";
import { getAuthenticatedDrive } from "@/server/services/drive/client";

type Profile = {
  id: string;
  source_sheet_id: string;
  source_row_number: number;
  district: string | null;
  insta_name: string;
  email_encrypted: string;
  password_encrypted: string;
  status: "pending" | "done";
};

type SyncContext = { orgId: string; db: any };

const expectedHeaders = ["id", "district", "insta_name", "email", "password", "status"];

function escapedTab(tab: string) {
  return `'${tab.replace(/'/g, "''")}'`;
}

function visibleValues(row: Profile) {
  return [row.district ?? "", row.insta_name, decrypt(row.email_encrypted), decrypt(row.password_encrypted), row.status];
}

/**
 * Writes the account-directory cache back to the single user-provided Sheet.
 * Imported rows retain their original Sheet row and ID. Manually created rows
 * are appended once, then attached to that same Sheet row in Supabase.
 */
export async function syncInstagramProfileUsersSheet(ctx: SyncContext, brandId: string) {
  const { data, error } = await ctx.db
    .from("insta_profile_users")
    .select("id,source_sheet_id,source_row_number,district,insta_name,email_encrypted,password_encrypted,status")
    .eq("org_id", ctx.orgId)
    .order("source_sheet_id", { ascending: true })
    .order("source_row_number", { ascending: true });
  if (error) throw new Error("Could not load Instagram profile rows for Sheet sync.");
  const rows = (data ?? []) as Profile[];
  if (!rows.length) throw new Error("There are no Instagram profile rows to sync.");

  const importedSheetIds = [...new Set(rows.map((row) => row.source_sheet_id).filter((id) => id !== "manual"))];
  if (importedSheetIds.length !== 1) {
    throw new Error("This profile directory has no single imported Google Sheet destination.");
  }
  const spreadsheetId = importedSheetIds[0];
  const drive = await getAuthenticatedDrive(brandId, ctx.orgId);
  const sheets = google.sheets({ version: "v4", auth: (drive as any).context._options.auth });
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))",
  });
  const sheet = (metadata.data.sheets ?? []).find((item) => item.properties?.sheetId != null);
  const tab = sheet?.properties?.title;
  if (!tab) throw new Error("The imported Google Sheet has no writable tab.");

  const headerRead = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${escapedTab(tab)}!A1:F1`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const headers = (headerRead.data.values?.[0] ?? []).map((value) => String(value ?? "").trim().toLowerCase());
  if (expectedHeaders.some((header, index) => headers[index] !== header)) {
    throw new Error("The Google Sheet headers must be: id, district, insta_name, email, password, status.");
  }

  const imported = rows.filter((row) => row.source_sheet_id === spreadsheetId);
  const manual = rows.filter((row) => row.source_sheet_id === "manual");
  const updates = imported.map((row) => ({
    range: `${escapedTab(tab)}!B${row.source_row_number}:F${row.source_row_number}`,
    values: [visibleValues(row)],
  }));
  if (updates.length) {
    const response = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: updates },
    });
    if ((response.data.totalUpdatedRows ?? 0) !== imported.length) {
      throw new Error("Google Sheet did not confirm every existing profile row update.");
    }
  }

  let appended = 0;
  if (manual.length) {
    const lastImportedRow = Math.max(...imported.map((row) => row.source_row_number), 1);
    const idsRead = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${escapedTab(tab)}!A2:A${lastImportedRow}`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const maxId = Math.max(0, ...(idsRead.data.values ?? []).map((row) => Number(row[0])).filter(Number.isFinite));
    for (let index = 0; index < manual.length; index += 1) {
      const profile = manual[index];
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${escapedTab(tab)}!A:F`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [[maxId + index + 1, ...visibleValues(profile)]] },
      });
      const match = response.data.updates?.updatedRange?.match(/![A-Z]+(\d+):/);
      const sourceRowNumber = Number(match?.[1]);
      if (!Number.isInteger(sourceRowNumber) || sourceRowNumber < 2) throw new Error("Google Sheet did not return the appended profile row.");
      const { error: mappingError } = await ctx.db.from("insta_profile_users").update({
        source_sheet_id: spreadsheetId,
        source_row_number: sourceRowNumber,
        updated_at: new Date().toISOString(),
      }).eq("id", profile.id).eq("org_id", ctx.orgId).eq("source_sheet_id", "manual");
      if (mappingError) throw new Error("The profile was added to the Sheet but its local sync mapping could not be saved.");
      appended += 1;
    }
  }

  const verification = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${escapedTab(tab)}!A1:F${Math.max(...imported.map((row) => row.source_row_number), 1)}`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  if ((verification.data.values?.[0] ?? []).map((value) => String(value ?? "").trim().toLowerCase()).join("|") !== expectedHeaders.join("|")) {
    throw new Error("Google Sheet verification failed; local data was preserved.");
  }
  return { spreadsheetId, tab, updated: imported.length, appended };
}
