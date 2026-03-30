import { google, type drive_v3 } from "googleapis";
import { encrypt, decrypt } from "@/lib/encryption";
import { getDb } from "@/lib/supabase/db";
import { Readable } from "stream";

const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const MEDIAHUB_FOLDER = "MediaHub";
const ORIGINALS_FOLDER = "Originals";
const PROCESSED_FOLDER = "Processed";

interface DriveConnection {
  id: string;
  brand_id: string;
  google_account_email: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  root_folder_id: string;
  folder_ids: { root?: string; originals?: string; processed?: string };
  is_active: boolean;
}

interface VerificationResult {
  success: boolean;
  errors: string[];
  checks: {
    folderCreate: boolean;
    fileUpload: boolean;
    fileRead: boolean;
  };
}

// ─── Helpers ───

async function getGoogleCredentials(orgId: string) {
  const db = getDb();

  // Try google_drive first (has its own redirect URI), fall back to youtube (same GCP project)
  const { data: driveCred } = await db
    .from("platform_credentials")
    .select("*")
    .eq("org_id", orgId)
    .eq("platform", "google_drive")
    .single();

  const cred = driveCred || (await db
    .from("platform_credentials")
    .select("*")
    .eq("org_id", orgId)
    .eq("platform", "youtube")
    .single()).data;

  if (!cred) {
    throw new Error("Google Drive credentials not configured. Set them in Settings → Platform Credentials → Google Drive.");
  }

  return {
    clientId: decrypt(cred.client_id_encrypted),
    clientSecret: decrypt(cred.client_secret_encrypted),
    redirectUri: cred.redirect_uri,
  };
}

function createOAuth2Client(clientId: string, clientSecret: string, redirectUri: string) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function getAuthenticatedDrive(brandId: string, orgId: string): Promise<drive_v3.Drive> {
  const db = getDb();
  const { data: conn, error } = await db
    .from("drive_connections")
    .select("*")
    .eq("brand_id", brandId)
    .eq("is_active", true)
    .single();

  if (error || !conn) {
    throw new Error("Google Drive not connected for this brand");
  }

  const creds = await getGoogleCredentials(orgId);
  const oauth2 = createOAuth2Client(creds.clientId, creds.clientSecret, creds.redirectUri);

  oauth2.setCredentials({
    access_token: decrypt(conn.access_token_encrypted),
    refresh_token: conn.refresh_token_encrypted ? decrypt(conn.refresh_token_encrypted) : undefined,
  });

  // Auto-refresh if close to expiry
  if (conn.token_expires_at) {
    const expiresAt = new Date(conn.token_expires_at);
    const now = new Date();
    if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
      await refreshTokenIfNeeded(brandId, orgId);
      const { data: refreshed } = await db
        .from("drive_connections")
        .select("access_token_encrypted")
        .eq("brand_id", brandId)
        .single();
      if (refreshed) {
        oauth2.setCredentials({
          ...oauth2.credentials,
          access_token: decrypt(refreshed.access_token_encrypted),
        });
      }
    }
  }

  return google.drive({ version: "v3", auth: oauth2 });
}

// ─── Get OAuth URL ───

export async function getOAuthUrl(orgId: string, brandId: string, from?: string): Promise<string> {
  const creds = await getGoogleCredentials(orgId);
  const redirectUri = creds.redirectUri || `${process.env.NEXT_PUBLIC_APP_URL!}/api/callback/google-drive`;
  const oauth2 = createOAuth2Client(creds.clientId, creds.clientSecret, redirectUri);

  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state: JSON.stringify({ brandId, orgId, from }),
  });
}

// ─── Connect Drive ───

export async function connectDrive(
  brandId: string,
  orgId: string,
  authCode: string
): Promise<{ success: boolean; email: string }> {
  const db = getDb();
  const creds = await getGoogleCredentials(orgId);
  const redirectUri = creds.redirectUri || `${process.env.NEXT_PUBLIC_APP_URL!}/api/callback/google-drive`;
  const oauth2 = createOAuth2Client(creds.clientId, creds.clientSecret, redirectUri);

  // Exchange code for tokens
  const { tokens } = await oauth2.getToken(authCode);
  oauth2.setCredentials(tokens);

  // Create Drive client
  const drive = google.drive({ version: "v3", auth: oauth2 });

  // Get user email from Drive API (doesn't need extra scopes)
  let email = "unknown";
  try {
    const about = await drive.about.get({ fields: "user" });
    email = about.data.user?.emailAddress || "unknown";
  } catch {
    // Non-critical — email is just for display
  }

  // Create MediaHub folders
  const folderIds = await createMediaHubFolders(drive);

  // Save connection
  const expiresAt = tokens.expiry_date
    ? new Date(tokens.expiry_date).toISOString()
    : null;

  await db
    .from("drive_connections")
    .upsert(
      {
        brand_id: brandId,
        google_account_email: email,
        access_token_encrypted: encrypt(tokens.access_token!),
        refresh_token_encrypted: tokens.refresh_token
          ? encrypt(tokens.refresh_token)
          : null,
        token_expires_at: expiresAt,
        root_folder_id: folderIds.root,
        folder_ids: folderIds,
        is_active: true,
      },
      { onConflict: "brand_id" }
    );

  return { success: true, email };
}

// ─── Create MediaHub Folders ───

async function createMediaHubFolders(
  drive: drive_v3.Drive
): Promise<{ root: string; originals: string; processed: string }> {
  // Check if MediaHub already exists
  const existing = await drive.files.list({
    q: `name='${MEDIAHUB_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  let rootId: string;

  if (existing.data.files && existing.data.files.length > 0) {
    rootId = existing.data.files[0].id!;
  } else {
    const root = await drive.files.create({
      requestBody: {
        name: MEDIAHUB_FOLDER,
        mimeType: "application/vnd.google-apps.folder",
      },
      fields: "id",
    });
    rootId = root.data.id!;
  }

  // Create or find Originals
  const originalsId = await findOrCreateSubfolder(drive, rootId, ORIGINALS_FOLDER);
  // Create or find Processed
  const processedId = await findOrCreateSubfolder(drive, rootId, PROCESSED_FOLDER);

  return { root: rootId, originals: originalsId, processed: processedId };
}

async function findOrCreateSubfolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string
): Promise<string> {
  const existing = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
    fields: "files(id)",
    spaces: "drive",
  });

  if (existing.data.files && existing.data.files.length > 0) {
    return existing.data.files[0].id!;
  }

  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
  });

  return folder.data.id!;
}

// ─── Verify Connection ───

export async function verifyConnection(
  brandId: string,
  orgId: string
): Promise<VerificationResult> {
  const result: VerificationResult = {
    success: false,
    errors: [],
    checks: { folderCreate: false, fileUpload: false, fileRead: false },
  };

  let drive: drive_v3.Drive;
  try {
    drive = await getAuthenticatedDrive(brandId, orgId);
  } catch (e: any) {
    result.errors.push(`Connection failed: ${e.message}`);
    return result;
  }

  const db = getDb();
  const { data: conn } = await db
    .from("drive_connections")
    .select("folder_ids")
    .eq("brand_id", brandId)
    .single();

  if (!conn?.folder_ids?.originals) {
    result.errors.push("MediaHub folder structure not found");
    return result;
  }

  // Check 1: Verify folders exist
  try {
    await drive.files.get({ fileId: conn.folder_ids.originals, fields: "id" });
    result.checks.folderCreate = true;
  } catch {
    result.errors.push("Cannot access Originals folder");
    return result;
  }

  // Check 2: Upload a test file
  let testFileId: string | null = null;
  try {
    const testContent = `MediaHub verification test - ${new Date().toISOString()}`;
    const res = await drive.files.create({
      requestBody: {
        name: ".mediahub_verify_test.txt",
        parents: [conn.folder_ids.originals],
      },
      media: {
        mimeType: "text/plain",
        body: Readable.from([testContent]),
      },
      fields: "id",
    });
    testFileId = res.data.id!;
    result.checks.fileUpload = true;
  } catch (e: any) {
    result.errors.push(`Upload test failed: ${e.message}`);
    return result;
  }

  // Check 3: Read the test file back
  try {
    const res = await drive.files.get(
      { fileId: testFileId!, alt: "media" },
      { responseType: "text" }
    );
    const content = String(res.data);
    if (content.includes("MediaHub verification test")) {
      result.checks.fileRead = true;
    } else {
      result.errors.push("Read test returned unexpected content");
      return result;
    }
  } catch (e: any) {
    result.errors.push(`Read test failed: ${e.message}`);
    return result;
  }

  // Clean up test file
  try {
    await drive.files.delete({ fileId: testFileId! });
  } catch {
    // Non-critical — test file left behind
  }

  result.success = true;
  return result;
}

// ─── Upload File ───

export async function uploadFile(
  brandId: string,
  orgId: string,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  targetFolder: "originals" | "processed" = "originals"
): Promise<string> {
  const drive = await getAuthenticatedDrive(brandId, orgId);
  const db = getDb();

  const { data: conn } = await db
    .from("drive_connections")
    .select("folder_ids")
    .eq("brand_id", brandId)
    .single();

  if (!conn?.folder_ids?.[targetFolder]) {
    throw new Error(`Target folder '${targetFolder}' not found`);
  }

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [conn.folder_ids[targetFolder]],
    },
    media: {
      mimeType,
      body: Readable.from([fileBuffer]),
    },
    fields: "id",
  });

  return res.data.id!;
}

// ─── Download File ───

export async function downloadFile(
  driveFileId: string,
  brandId: string,
  orgId: string
): Promise<Buffer> {
  const drive = await getAuthenticatedDrive(brandId, orgId);

  const res = await drive.files.get(
    { fileId: driveFileId, alt: "media" },
    { responseType: "arraybuffer" }
  );

  return Buffer.from(res.data as ArrayBuffer);
}

// ─── Delete File ───

export async function deleteFile(
  driveFileId: string,
  brandId: string,
  orgId: string
): Promise<void> {
  const drive = await getAuthenticatedDrive(brandId, orgId);
  await drive.files.delete({ fileId: driveFileId });
}

// ─── Get File Metadata ───

export async function getFileMetadata(
  driveFileId: string,
  brandId: string,
  orgId: string
): Promise<{
  name: string;
  mimeType: string;
  size: number;
  imageWidth?: number;
  imageHeight?: number;
}> {
  const drive = await getAuthenticatedDrive(brandId, orgId);

  const res = await drive.files.get({
    fileId: driveFileId,
    fields: "name, mimeType, size, imageMediaMetadata",
  });

  return {
    name: res.data.name || "",
    mimeType: res.data.mimeType || "",
    size: parseInt(res.data.size || "0", 10),
    imageWidth: res.data.imageMediaMetadata?.width ?? undefined,
    imageHeight: res.data.imageMediaMetadata?.height ?? undefined,
  };
}

// ─── List Files ───

export async function listFiles(
  brandId: string,
  orgId: string,
  folderId: string
): Promise<{ id: string; name: string; mimeType: string; size: string }[]> {
  const drive = await getAuthenticatedDrive(brandId, orgId);

  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(id, name, mimeType, size)",
    spaces: "drive",
    orderBy: "createdTime desc",
    pageSize: 100,
  });

  return (res.data.files || []).map((f) => ({
    id: f.id!,
    name: f.name || "",
    mimeType: f.mimeType || "",
    size: f.size || "0",
  }));
}

// ─── Refresh Token ───

export async function refreshTokenIfNeeded(
  brandId: string,
  orgId: string
): Promise<boolean> {
  const db = getDb();

  const { data: conn } = await db
    .from("drive_connections")
    .select("*")
    .eq("brand_id", brandId)
    .eq("is_active", true)
    .single();

  if (!conn || !conn.refresh_token_encrypted) return false;

  const creds = await getGoogleCredentials(orgId);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const redirectUri = `${appUrl}/api/callback/google-drive`;
  const oauth2 = createOAuth2Client(creds.clientId, creds.clientSecret, redirectUri);

  oauth2.setCredentials({
    refresh_token: decrypt(conn.refresh_token_encrypted),
  });

  try {
    const { credentials } = await oauth2.refreshAccessToken();

    await db
      .from("drive_connections")
      .update({
        access_token_encrypted: encrypt(credentials.access_token!),
        token_expires_at: credentials.expiry_date
          ? new Date(credentials.expiry_date).toISOString()
          : null,
      })
      .eq("brand_id", brandId);

    return true;
  } catch (e: any) {
    // Mark connection as inactive if refresh fails
    await db
      .from("drive_connections")
      .update({ is_active: false })
      .eq("brand_id", brandId);

    return false;
  }
}

// ─── Disconnect ───

export async function disconnectDrive(brandId: string): Promise<void> {
  const db = getDb();
  await db
    .from("drive_connections")
    .update({ is_active: false })
    .eq("brand_id", brandId);
}

// ─── Get Connection Status ───

export async function getDriveStatus(brandId: string): Promise<{
  connected: boolean;
  email: string | null;
  isActive: boolean;
  tokenExpiresAt: string | null;
  folderIds: { root?: string; originals?: string; processed?: string } | null;
}> {
  const db = getDb();

  const { data: conn } = await db
    .from("drive_connections")
    .select("google_account_email, is_active, token_expires_at, folder_ids")
    .eq("brand_id", brandId)
    .single();

  if (!conn) {
    return { connected: false, email: null, isActive: false, tokenExpiresAt: null, folderIds: null };
  }

  return {
    connected: true,
    email: conn.google_account_email,
    isActive: conn.is_active,
    tokenExpiresAt: conn.token_expires_at,
    folderIds: conn.folder_ids,
  };
}
