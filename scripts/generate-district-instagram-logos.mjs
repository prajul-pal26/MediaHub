import fs from "node:fs/promises";
import path from "node:path";

process.env.FONTCONFIG_FILE = path.resolve("scripts/assets/fonts/mukta-fontconfig.xml");
const { default: sharp } = await import("sharp");

const outputDir = path.resolve("public/generated/instagram-district-logos");
const templateImage = path.resolve("public/generated/instagram-district-logos/template.png");
const districts = [
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

const orange = "#f4510b";
const escapeXml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const fileName = (username) => username.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
const districtFontSize = (name) => name.length > 15 ? 168 : name.length > 12 ? 205 : name.length > 10 ? 250 : 300;

function districtOverlay(name) {
  const size = districtFontSize(name);
  return `
    <svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
      <text x="540" y="1440" transform="scale(1 0.45)" text-anchor="middle" fill="${orange}" font-family="Mukta" font-size="${size}" font-weight="800">${escapeXml(name)}</text>
    </svg>`;
}

await fs.mkdir(outputDir, { recursive: true });
for (const [username, district] of districts) {
  const output = path.join(outputDir, `${fileName(username)}.png`);
  await sharp(templateImage)
    .resize(1080, 1080)
    .composite([{ input: Buffer.from(districtOverlay(district)) }])
    .png({ compressionLevel: 9 })
    .toFile(output);
}
console.log(`Created ${districts.length} logos in ${outputDir}`);
