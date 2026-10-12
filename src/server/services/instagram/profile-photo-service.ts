import fs from "node:fs";
import path from "node:path";

export const DISTRICTS_ROSTER: Array<[string, string]> = [
  ["Badalta_Agra", "आगरा"], ["Badalta_Aligarh", "अलीगढ़"], ["Badalta_Ambedkar_Nagar", "अंबेडकर नगर"],
  ["Badalta_Amethi", "अमेठी"], ["Apna_Amrohaa", "अमरोहा"], ["Apna_Auraiyaaa", "औरैया"],
  ["Apna_Ayodhyaaa", "अयोध्या"], ["Apnaaa_Azamgarh", "आज़मगढ़"], ["Apnaa_Baghpat", "बागपत"],
  ["Apnaa_Bahraich", "बहराइच"], ["Apna_Balliaa", "बलिया"], ["Apna._.Balrampur", "बलरामपुर"],
  ["Apna_.Banda", "बांदा"], ["Apnaa_Barabanki", "बाराबंकी"], ["Apna._Bareilly", "बरेली"],
  ["Apna_Bastii", "बस्ती"], ["Apna._Bhadohi", "भदोही"], ["Badalta_Bijnor", "बिजनौर"],
  ["Apnaa_Budaun", "बदायूँ"], ["Apnaa_Bulandshahar", "बुलंदशहर"], ["Apna_Chandauliii", "चंदौली"],
  ["Apnaa_Chitrakoot", "चित्रकूट"], ["apna._deoria", "देवरिया"], ["Apnaa_Etah", "एटा"],
  ["Apnaa_Etawah", "इटावा"], ["Apnaaa_Farrukhabad", "फ़र्रुख़ाबाद"], ["Apnaa_Fatehpur", "फतेहपुर"],
  ["Apnaa_Firozabad", "फिरोज़ाबाद"], ["Apnaa_Gautam_Buddha_Nagar", "गौतम बुद्ध नगर"], ["Apnaa_Ghaziabad", "गाज़ियाबाद"],
  ["Apnaa_Ghazipur", "गाज़ीपुर"], ["Apnaa_Gonda", "गोंडा"], ["Apnaa._Gorakhpur", "गोरखपुर"],
  ["Apnaa_Hamirpur", "हमीरपुर"], ["Apnaa_Hapur", "हापुड़"], ["Apna_Hardoii", "हरदोई"],
  ["Apnaa_Hathras", "हाथरस"], ["Apnaa_Jalaun", "जालौन"], ["Apnaa_Jaunpur", "जौनपुर"],
  ["Apnaa_Jhansi", "झाँसी"], ["Apnaa_Kannauj", "कन्नौज"], ["Apnaa_Kanpur_Dehat", "कानपुर देहात"],
  ["Apnaa_Kanpur_Nagar", "कानपुर नगर"], ["Apnaa._Kasganj", "कासगंज"], ["Apnaa._Kaushambi", "कौशाम्बी"],
  ["Apna._Kushinagar", "कुशीनगर"], ["Apnaa_Lakhimpur_Kheri", "लखीमपुर खीरी"], ["Apnaa_Lalitpur", "ललितपुर"],
  ["Apnaa._Lucknow", "लखनऊ"], ["Apnaa._Maharajganj", "महाराजगंज"], ["Apnaa_Mahoba", "महोबा"],
  ["Apnaa_Mainpuri", "मैनपुरी"], ["Apna._Mathura", "मथुरा"], ["Apnaa_Mau", "मऊ"],
  ["Apnaa._Meerut", "मेरठ"], ["Apnaa_Mirzapur", "मिर्ज़ापुर"], ["Badalta_Moradabad", "मुरादाबाद"],
  ["Badalta_Muzaffarnagar", "मुज़फ्फरनगर"], ["Apnaa_Pilibhit", "पीलीभीत"], ["Apnaa_Pratapgarh", "प्रतापगढ़"],
  ["Apnaa._Prayagraj", "प्रयागराज"], ["Apnaa_Raebareli", "रायबरेली"], ["Apna._Rampur", "रामपुर"],
  ["Badalta_Saharanpur", "सहारनपुर"], ["Apnaa_Sambhal", "संभल"], ["Apnaa_Sant_Kabir_Nagar", "संत कबीर नगर"],
  ["Apna._Shahjahanpur", "शाहजहाँपुर"], ["Badalta_Shamli", "शामली"], ["Apnaa_Shravasti", "श्रावस्ती"],
  ["Apnaa_Siddharthnagar", "सिद्धार्थनगर"], ["Apnaa_Sitapur", "सीतापुर"], ["Apnaa_Sonbhadra", "सोनभद्र"],
  ["Apna._.Sultanpur", "सुल्तानपुर"], ["Apnaa_Unnao", "उन्नाव"], ["Apna_Varanasii", "वाराणसी"],
];

export interface DistrictProfileItem {
  id: string;
  district: string;
  instaName: string;
  logoFileName: string;
  logoUrl: string;
  hasLogo: boolean;
  hasSafariSession: boolean;
  safariUuid?: string;
  safariUsername?: string;
  status: "pending" | "synced";
  photoSyncedAt?: string | null;
  sourceRowNumber?: number;
  updatedAt?: string;
}

const LOCAL_STATUS_FILE = path.resolve(
  process.cwd(),
  "public/generated/instagram-district-logos/photo-sync-status.json"
);

function readLocalStatusMap(): Record<string, { status: "pending" | "synced"; syncedAt?: string }> {
  try {
    if (fs.existsSync(LOCAL_STATUS_FILE)) {
      const raw = fs.readFileSync(LOCAL_STATUS_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch {}
  return {};
}

function writeLocalStatusMap(map: Record<string, { status: "pending" | "synced"; syncedAt?: string }>) {
  try {
    const dir = path.dirname(LOCAL_STATUS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(LOCAL_STATUS_FILE, JSON.stringify(map, null, 2), "utf-8");
  } catch {}
}

const SAFARI_CACHE_FILE = path.resolve(
  process.cwd(),
  "src/server/services/instagram/safari-profiles-cache.json"
);

const SAFARI_OVERRIDE_FILE = path.resolve(
  process.cwd(),
  "public/generated/instagram-district-logos/safari-sessions-override.json"
);

export function getSafariCache(): Record<string, any> {
  let base: Record<string, any> = {};
  try {
    if (fs.existsSync(SAFARI_CACHE_FILE)) {
      base = JSON.parse(fs.readFileSync(SAFARI_CACHE_FILE, "utf-8"));
    }
  } catch {}

  try {
    if (fs.existsSync(SAFARI_OVERRIDE_FILE)) {
      const overrides = JSON.parse(fs.readFileSync(SAFARI_OVERRIDE_FILE, "utf-8"));
      for (const [key, hasSession] of Object.entries(overrides)) {
        const cleanKey = key.trim().toLowerCase();
        let matched = false;
        for (const [bk, v] of Object.entries(base)) {
          if (
            bk.toLowerCase() === cleanKey ||
            v?.district?.toLowerCase() === cleanKey ||
            v?.username?.toLowerCase() === cleanKey
          ) {
            v.has_session = Boolean(hasSession);
            matched = true;
          }
        }
        if (!matched) {
          base[cleanKey] = {
            district: key,
            username: key,
            has_session: Boolean(hasSession),
          };
        }
      }
    }
  } catch {}

  return base;
}

export function updateSafariSessionStatus(
  district: string,
  username: string,
  hasSession: boolean
): { ok: boolean; hasSession: boolean } {
  const dKey = (district || "").trim().toLowerCase();
  const uKey = (username || "").trim().toLowerCase();

  let overrides: Record<string, boolean> = {};
  try {
    if (fs.existsSync(SAFARI_OVERRIDE_FILE)) {
      overrides = JSON.parse(fs.readFileSync(SAFARI_OVERRIDE_FILE, "utf-8"));
    }
  } catch {}

  if (dKey) overrides[dKey] = hasSession;
  if (uKey) overrides[uKey] = hasSession;

  try {
    const dir = path.dirname(SAFARI_OVERRIDE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SAFARI_OVERRIDE_FILE, JSON.stringify(overrides, null, 2), "utf-8");
  } catch (err) {
    console.warn("Could not save safari override file:", err);
  }

  try {
    if (fs.existsSync(SAFARI_CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(SAFARI_CACHE_FILE, "utf-8"));
      let matched = false;
      for (const [bk, v] of Object.entries(cache as Record<string, any>)) {
        if (
          (dKey && (bk.toLowerCase() === dKey || v?.district?.toLowerCase() === dKey)) ||
          (uKey && (bk.toLowerCase() === uKey || v?.username?.toLowerCase() === uKey))
        ) {
          v.has_session = hasSession;
          matched = true;
        }
      }
      if (!matched && district) {
        cache[district] = {
          district,
          username,
          has_session: hasSession,
        };
      }
      fs.writeFileSync(SAFARI_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
    }
  } catch {}

  return { ok: true, hasSession };
}

export function getLogoFileName(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".png";
}

export function getLogoPath(username: string): string {
  const fileName = getLogoFileName(username);
  const logosDir = path.resolve(process.cwd(), "public/generated/instagram-district-logos");
  const directPath = path.resolve(logosDir, fileName);
  if (fs.existsSync(directPath)) return directPath;
  const altFileName = fileName.includes("apnaa-")
    ? fileName.replace("apnaa-", "apna-")
    : fileName.replace("apna-", "apnaa-");
  const altPath = path.resolve(logosDir, altFileName);
  if (fs.existsSync(altPath)) return altPath;
  return directPath;
}

export function findSafariInfo(
  cache: Record<string, any>,
  district?: string | null,
  instaName?: string | null
): any {
  const dNorm = (district || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const uNorm = (instaName || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // 1. Direct match on key or normalized fields
  for (const [k, v] of Object.entries(cache)) {
    const kNorm = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    const vDNorm = (v?.district || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const vUNorm = (v?.username || "").toLowerCase().replace(/[^a-z0-9]/g, "");

    if (dNorm && (kNorm === dNorm || vDNorm === dNorm)) return v;
    if (uNorm && vUNorm && vUNorm === uNorm) return v;
  }

  // 2. Substring match (e.g. "apna._.balrampur" contains "balrampur")
  for (const [k, v] of Object.entries(cache)) {
    const kNorm = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    const vDNorm = (v?.district || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const distKey = kNorm || vDNorm;

    if (distKey && uNorm && (uNorm.includes(distKey) || distKey.includes(uNorm))) {
      return v;
    }
    if (distKey && dNorm && (dNorm.includes(distKey) || distKey.includes(dNorm))) {
      return v;
    }
  }

  return undefined;
}

export async function getDistrictProfiles(db?: any, orgId?: string): Promise<DistrictProfileItem[]> {
  let dbRows: any[] = [];
  if (db && orgId) {
    try {
      const { data, error } = await db
        .from("insta_profile_users")
        .select("id, district, insta_name, status, photo_status, photo_synced_at, source_row_number, updated_at")
        .eq("org_id", orgId)
        .order("district", { ascending: true });
      if (!error && Array.isArray(data)) {
        dbRows = data;
      }
    } catch {
      // Fallback to static roster below
    }
  }

  // Pre-load file check directory
  const logosDir = path.resolve(process.cwd(), "public/generated/instagram-district-logos");
  let existingFiles = new Set<string>();
  try {
    if (fs.existsSync(logosDir)) {
      existingFiles = new Set(fs.readdirSync(logosDir));
    }
  } catch {}

  const cache = getSafariCache();
  const localStatus = readLocalStatusMap();

  // Build items from DB or fallback roster
  if (dbRows.length > 0) {
    return dbRows.map((row) => {
      let fileName = getLogoFileName(row.insta_name);
      if (!existingFiles.has(fileName)) {
        const altFileName = fileName.includes("apnaa-")
          ? fileName.replace("apnaa-", "apna-")
          : fileName.replace("apna-", "apnaa-");
        if (existingFiles.has(altFileName)) {
          fileName = altFileName;
        }
      }
      const instaNameKey = (row.insta_name || "").trim().toLowerCase();

      // Find in Safari cache by normalized district name or username
      const safariInfo = findSafariInfo(cache, row.district, row.insta_name);

      // Genuine photo sync status (only marked synced when photo is confirmed uploaded)
      const localRecord = localStatus[row.id] || localStatus[instaNameKey];
      const isSynced =
        row.photo_status === "synced" ||
        Boolean(row.photo_synced_at) ||
        localRecord?.status === "synced";

      const fileMtime = existingFiles.has(fileName)
        ? (() => {
            try {
              return Math.floor(fs.statSync(path.join(logosDir, fileName)).mtimeMs);
            } catch {
              return undefined;
            }
          })()
        : undefined;
      const vParam = fileMtime ? `?t=${fileMtime}` : "";

      return {
        id: row.id,
        district: row.district || "Uttar Pradesh",
        instaName: row.insta_name,
        logoFileName: fileName,
        logoUrl: `/generated/instagram-district-logos/${fileName}${vParam}`,
        hasLogo: existingFiles.has(fileName),
        hasSafariSession: Boolean(safariInfo?.has_session),
        safariUuid: safariInfo?.uuid,
        safariUsername: safariInfo?.username,
        status: isSynced ? "synced" : "pending",
        photoSyncedAt: row.photo_synced_at || localRecord?.syncedAt || null,
        sourceRowNumber: row.source_row_number,
        updatedAt: row.updated_at,
      };
    });
  }

  // Fallback to static roster
  return DISTRICTS_ROSTER.map(([instaName, _hindiDistrict], index) => {
    const englishDistrict = instaName
      .replace(/^(Badalta|Apna+)[._]*/i, "")
      .replace(/^[._]+|[._]+$/g, "")
      .replace(/_+/g, " ")
      .trim();
    let fileName = getLogoFileName(instaName);
    if (!existingFiles.has(fileName)) {
      const altFileName = fileName.includes("apnaa-")
        ? fileName.replace("apnaa-", "apna-")
        : fileName.replace("apna-", "apnaa-");
      if (existingFiles.has(altFileName)) {
        fileName = altFileName;
      }
    }
    const instaNameKey = instaName.toLowerCase();
    const safariInfo = findSafariInfo(cache, englishDistrict, instaName);

    const localRecord = localStatus[`roster-${index + 1}`] || localStatus[instaNameKey];
    const isSynced = localRecord?.status === "synced";

    const fileMtime = existingFiles.has(fileName)
      ? (() => {
          try {
            return Math.floor(fs.statSync(path.join(logosDir, fileName)).mtimeMs);
          } catch {
            return undefined;
          }
        })()
      : undefined;
    const vParam = fileMtime ? `?t=${fileMtime}` : "";

    return {
      id: `roster-${index + 1}`,
      district: englishDistrict,
      instaName,
      logoFileName: fileName,
      logoUrl: `/generated/instagram-district-logos/${fileName}${vParam}`,
      hasLogo: existingFiles.has(fileName),
      hasSafariSession: Boolean(safariInfo?.has_session),
      safariUuid: safariInfo?.uuid,
      safariUsername: safariInfo?.username,
      status: isSynced ? "synced" : "pending",
      photoSyncedAt: localRecord?.syncedAt || null,
      sourceRowNumber: index + 2,
    };
  });
}

export function getPhotoPayload(username: string): {
  username: string;
  fileName: string;
  mimeType: string;
  base64: string;
  dataUrl: string;
} {
  const filePath = getLogoPath(username);
  if (!fs.existsSync(filePath)) {
    // If specific file not yet generated, fall back to template or error gracefully
    const templatePath = path.resolve(process.cwd(), "public/generated/instagram-district-logos/template.png");
    if (fs.existsSync(templatePath)) {
      const buffer = fs.readFileSync(templatePath);
      const base64 = buffer.toString("base64");
      return {
        username,
        fileName: getLogoFileName(username),
        mimeType: "image/png",
        base64,
        dataUrl: `data:image/png;base64,${base64}`,
      };
    }
    throw new Error(`Logo file not found for ${username}: ${filePath}`);
  }

  // Never delete local files - read and return payload
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString("base64");
  const dataUrl = `data:image/png;base64,${base64}`;

  return {
    username,
    fileName: getLogoFileName(username),
    mimeType: "image/png",
    base64,
    dataUrl,
  };
}

export async function recordPhotoSyncSuccess(
  id: string,
  status: "pending" | "synced",
  orgId?: string,
  db?: any
): Promise<{ ok: boolean; id: string; status: string }> {
  const isSynced = status === "synced";
  const nowIso = new Date().toISOString();

  // 1. Update database if real UUID and db context available
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (db) {
    try {
      if (isUuid) {
        let query = db
          .from("insta_profile_users")
          .update({
            photo_status: isSynced ? "synced" : "pending",
            photo_synced_at: isSynced ? nowIso : null,
            updated_at: nowIso,
          })
          .eq("id", id);
        if (orgId) query = query.eq("org_id", orgId);
        await query;
      } else {
        // Fallback: match by insta_name or district
        let query = db
          .from("insta_profile_users")
          .update({
            photo_status: isSynced ? "synced" : "pending",
            photo_synced_at: isSynced ? nowIso : null,
            updated_at: nowIso,
          })
          .or(`insta_name.ilike.${id},district.ilike.${id}`);
        if (orgId) query = query.eq("org_id", orgId);
        await query;
      }
    } catch (err) {
      console.warn("Could not update photo_status in db:", err);
    }
  }

  // 2. Also persist in local status json so it survives restarts
  const localMap = readLocalStatusMap();
  localMap[id] = {
    status: isSynced ? "synced" : "pending",
    syncedAt: isSynced ? nowIso : undefined,
  };
  const normalizedKey = id.toLowerCase().replace(/[^a-z0-9]+/g, "");
  localMap[normalizedKey] = {
    status: isSynced ? "synced" : "pending",
    syncedAt: isSynced ? nowIso : undefined,
  };
  writeLocalStatusMap(localMap);

  return { ok: true, id, status };
}

export async function deleteDistrictLogo(username: string): Promise<{ success: boolean; fileName: string }> {
  const fileName = getLogoFileName(username);
  const targetDir = path.resolve(process.cwd(), "public/generated/instagram-district-logos");
  if (fs.existsSync(targetDir)) {
    try {
      const files = fs.readdirSync(targetDir);
      const normalizedTarget = fileName.replace(/\.png$/i, "").toLowerCase();
      for (const file of files) {
        if (file === "template.png" || file === "drive-file-map.json" || file === "photo-sync-status.json") continue;
        const baseName = file.replace(/\.(png|jpe?g|webp|gif)$/i, "").toLowerCase();
        if (file.toLowerCase() === fileName.toLowerCase() || baseName === normalizedTarget) {
          try {
            fs.unlinkSync(path.join(targetDir, file));
          } catch (err) {
            console.warn(`Failed to delete logo file ${file}:`, err);
          }
        }
      }
    } catch (err) {
      console.warn(`Failed to scan directory for deleting ${username}:`, err);
    }
  }
  return { success: true, fileName };
}

export async function syncLogosFromGoogleDrive(
  orgId?: string,
  db?: any
): Promise<{
  success: boolean;
  totalFiles: number;
  downloadedCount: number;
  deletedCount: number;
  message: string;
}> {
  if (!db) {
    const { getDb } = await import("@/lib/supabase/db");
    db = getDb();
  }

  // 1. Resolve brand_id and org_id
  const { data: conn } = await db
    .from("drive_connections")
    .select("brand_id")
    .eq("is_active", true)
    .limit(1)
    .single();

  const brandId = conn?.brand_id;
  if (!brandId) {
    throw new Error("No active Google Drive connection found. Please connect Google Drive in Settings.");
  }

  let targetOrgId = orgId;
  if (!targetOrgId) {
    const { data: brand } = await db
      .from("brands")
      .select("org_id")
      .eq("id", brandId)
      .single();
    targetOrgId = brand?.org_id;
  }

  if (!targetOrgId) {
    throw new Error("Organization ID not found for Google Drive connection.");
  }

  const { getAuthenticatedDrive } = await import("@/server/services/drive/client");
  const drive = await getAuthenticatedDrive(brandId, targetOrgId);
  const folderId = "1D8XvhruaFUHEiIB646UPHizEKQWtTWA1";

  // 2. Query all files from Google Drive
  let pageToken: string | undefined = undefined;
  let allFiles: any[] = [];
  do {
    const res: any = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, size)",
      pageSize: 100,
      pageToken,
    });
    allFiles = allFiles.concat(res.data.files || []);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  if (allFiles.length === 0) {
    return {
      success: false,
      totalFiles: 0,
      downloadedCount: 0,
      deletedCount: 0,
      message: "No logo files found in Google Drive folder.",
    };
  }

  const targetDir = path.resolve(process.cwd(), "public/generated/instagram-district-logos");
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 3. Delete all existing photos (.png, .jpg, etc.) in local directory, preserving template.png
  let deletedCount = 0;
  try {
    const existingFiles = fs.readdirSync(targetDir);
    for (const file of existingFiles) {
      if (/\.(png|jpe?g|webp|gif)$/i.test(file) && file !== "template.png") {
        try {
          fs.unlinkSync(path.join(targetDir, file));
          deletedCount++;
        } catch (err) {
          console.warn(`Failed to delete local photo ${file}:`, err);
        }
      }
    }
  } catch (err) {
    console.warn("Failed to read directory to delete existing photos:", err);
  }

  // 4. Download all photos concurrently (pool of 8 parallel downloads)
  const driveMap: Record<string, string> = {};
  for (const f of allFiles) {
    driveMap[(f.name || "").toLowerCase()] = f.id;
  }

  const CONCURRENCY = 8;
  let downloadedCount = 0;
  for (let i = 0; i < allFiles.length; i += CONCURRENCY) {
    const batch = allFiles.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (f) => {
        const fileName = (f.name || "").toLowerCase();
        const dest = path.join(targetDir, fileName);
        try {
          const media: any = await drive.files.get(
            { fileId: f.id, alt: "media" },
            { responseType: "arraybuffer" }
          );
          fs.writeFileSync(dest, Buffer.from(media.data as ArrayBuffer));
          downloadedCount++;
        } catch (err) {
          console.error(`Failed to download photo ${f.name} from Google Drive:`, err);
        }
      })
    );
  }

  // 5. Update drive-file-map.json
  try {
    fs.writeFileSync(
      path.join(targetDir, "drive-file-map.json"),
      JSON.stringify(driveMap, null, 2),
      "utf-8"
    );
  } catch {}

  return {
    success: true,
    totalFiles: allFiles.length,
    downloadedCount,
    deletedCount,
    message: `Cleaned ${deletedCount} local photos & downloaded ${downloadedCount} fresh logos from Google Drive.`,
  };
}
