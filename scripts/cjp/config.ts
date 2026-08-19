/**
 * Search + classification config for the CJP "School Theek Karo Abhiyan" harvest.
 *
 * Every term here was derived from evidence actually observed in live search
 * results (see scripts/cjp/README.md), not guessed. The campaign launched
 * 15 August 2026, run by CJP = Cockroach Janta Party, founder Abhijeet Dipke.
 * It is a NATIONWIDE campaign, so geography filtering does real work: most
 * campaign content is not Uttar Pradesh content.
 */

/**
 * CORE campaign phrases. A match here is sufficient on its own — these name
 * the campaign itself and cannot plausibly appear by coincidence.
 */
export const CAMPAIGN_CORE: RegExp[] = [
  /school\s*th(?:ee|i)k\s*kar(?:o|a)/i,
  /स्कूल\s*ठीक\s*कर(?:ो|ों|ना)/,
  /schooltheekkaro\w*/i,
  /schoolthikkaro\w*/i,
];

/**
 * ORG identifiers. NOT sufficient alone — CJP ran an earlier exam-paper-leak
 * protest at Jantar Mantar in July, and unrelated viral clips carry #cjp tags.
 * Requires school context to count.
 */
export const CAMPAIGN_ORG: RegExp[] = [
  /cockroach\s*jan[at]+a?\s*party/i,
  /कॉकरोच\s*जनता\s*पार्टी/,
  /cockroachjantaparty/i,
  /\bcjp\b/i,
  /\bसीजेपी\b/,
  /abhij(?:ee|i)t\s*d(?:i|ee)pa?ke/i,
  /अभिजीत\s*दीपके/,
];

/** Genuine school/education context — deliberately excludes bare "teacher". */
export const SCHOOL_CONTEXT: RegExp[] = [
  /\bschools?\b/i,
  /स्कूल/,
  /विद्यालय/,
  /\bशाला\b/,
  /classroom|कक्षा/i,
  /सरकारी\s*स्कूल|government\s*school|govt\s*school/i,
  /शिक्षा\s*व्यवस्था|education\s*system/i,
  /\bsarpanch\b|सरपंच/i,
  /पाठशाला/,
];

/**
 * Entertainment markers. When these appear without a CORE phrase the row is
 * almost certainly a viral clip that merely carries a campaign hashtag.
 */
export const ENTERTAINMENT_NOISE: RegExp[] = [
  /\bdance\b|डांस|नाच/i,
  /\bsong\b|गाना|गीत/i,
  /comedy|कॉमेडी|funny|मजेदार/i,
  /\bprank\b|प्रैंक/i,
  /shayari|शायरी|status\s*video/i,
  /movie|film|फिल्म|trailer|ट्रेलर/i,
  /bhajan|भजन|\bdj\b|remix|रीमिक्स/i,
  /love\s*story|लव\s*स्टोरी/i,
];

/** Hashtags observed in real post/video text. */
export const HASHTAGS_VERIFIED = [
  "schooltheekkaroabhiyan",
  "schooltheekkaro",
  "schoolthikkaroabhiyan",
  "cjp",
  "abhijeetdipke",
  "cockroachjantaparty",
];

/** Plausible but NOT yet evidenced — searched, then reported separately. */
export const HASHTAGS_CANDIDATE = [
  "schooltheekkaro2026",
  "cjpschoolthikkaro",
  "स्कूलठीककरो",
  "upschool",
  "upschoolmerger",
];

/** YouTube queries, mixing Hindi/English and campaign/UP axes. */
export const YT_QUERIES = [
  "School Theek Karo Abhiyan",
  "स्कूल ठीक करो अभियान",
  "School Theek Karo Abhiyan CJP",
  "CJP School Theek Karo Abhiyan Uttar Pradesh",
  "स्कूल ठीक करो अभियान उत्तर प्रदेश",
  "Cockroach Janta Party Uttar Pradesh school",
  "Abhijeet Dipke School Theek Karo",
  "अभिजीत दीपके स्कूल ठीक करो अभियान यूपी",
  "CJP school abhiyan Yogi UP",
  "स्कूल ठीक करो अभियान लखनऊ",
  "UP सरकारी स्कूल हालत CJP",
  "School Theek Karo Abhiyan UP government notice",
  // The Hamirpur "road to school" march is the UP trigger event Dipke endorsed;
  // coverage brands it a "Gen Alpha protest", which is itself a viral term.
  "Hamirpur school children road protest",
  "हमीरपुर स्कूल बच्चे सड़क आंदोलन",
  "Gen Alpha protest Uttar Pradesh school",
  "Chandupur Hamirpur school road collectorate",
  "Allahabad High Court Hamirpur school road suo motu",
  "हमीरपुर कलेक्ट्रेट छात्र प्रदर्शन स्कूल",
  // Fatehpur sit-in — the other confirmed UP Gen Alpha event.
  "Fatehpur Sarvodaya Inter College Kishanpur students protest",
  "फतेहपुर सर्वोदय इंटर कॉलेज छात्र धरना",
  "Gen Alpha protest UP school students demands",
];

/** Instagram hashtags to sweep (no '#'). */
export const IG_TAGS = [
  "schooltheekkaroabhiyan",
  "schooltheekkaro",
  "schoolthikkaroabhiyan",
  "cockroachjantaparty",
  "abhijeetdipke",
  "cjp",
  "hamirpur",
  "genalphaprotest",
  // #SchoolThikKaro is the campaign's own canonical tag (verified in coverage);
  // #MainBhiCockroach is CJP's core movement tag.
  "schoolthikkaro",
  "mainbhicockroach",
  "genalpha",
];

/**
 * Uttar Pradesh signals. Split into strong (unambiguous) and district names,
 * because a bare district mention is weaker evidence than "Uttar Pradesh".
 */
export const UP_STRONG: RegExp[] = [
  /uttar\s*pradesh/i,
  /उत्तर\s*प्रदेश/,
  /\bयूपी\b/,
  /(?:^|[^a-z])u\.?p\.?(?:[^a-z]|$)/i,
  /yogi\s*adityanath/i,
  /योगी\s*आदित्यनाथ/,
  /\bcm\s*yogi\b/i,
  /basic\s*shiksha\s*parishad/i,
  /परिषदीय\s*विद्यालय/,
  /बेसिक\s*शिक्षा\s*परिषद/,
];

export const UP_DISTRICTS: RegExp[] = [
  // Hamirpur first: the schoolgirls' "road to school" march on the district
  // collectorate is the UP trigger event Dipke tied the campaign to.
  /hamirpur|हमीरपुर/i,
  /mahoba|महोबा/i,
  /jalaun|जालौन|orai|उरई/i,
  /chitrakoot|चित्रकूट/i,
  /lucknow|लखनऊ/i,
  /kanpur|कानपुर/i,
  /varanasi|वाराणसी|banaras|बनारस/i,
  /prayagraj|प्रयागराज|allahabad|इलाहाबाद/i,
  /agra|आगरा/i,
  /noida|नोएडा/i,
  /ghaziabad|गाजियाबाद/i,
  /gorakhpur|गोरखपुर/i,
  /meerut|मेरठ/i,
  /bareilly|बरेली/i,
  /aligarh|अलीगढ|अलीगढ़/i,
  /ayodhya|अयोध्या/i,
  /mathura|मथुरा/i,
  /jhansi|झांसी/i,
  /moradabad|मुरादाबाद/i,
  /saharanpur|सहारनपुर/i,
  /azamgarh|आजमगढ/i,
  /sitapur|सीतापुर/i,
  /hardoi|हरदोई/i,
  /unnao|उन्नाव/i,
  /raebareli|रायबरेली/i,
  /barabanki|बाराबंकी/i,
  /sultanpur|सुल्तानपुर/i,
  /jaunpur|जौनपुर/i,
  /ghazipur|गाजीपुर/i,
  /mirzapur|मिर्जापुर/i,
  /deoria|देवरिया/i,
  /bahraich|बहराइच/i,
  /gonda|गोंडा/i,
  /basti|बस्ती/i,
  /lakhimpur|लखीमपुर/i,
  /muzaffarnagar|मुजफ्फरनगर/i,
  /bulandshahr|बुलंदशहर/i,
  /firozabad|फिरोजाबाद/i,
  /etawah|इटावा/i,
  /fatehpur|फतेहपुर/i,
  /banda|बांदा/i,
  /pratapgarh|प्रतापगढ/i,
  /amethi|अमेठी/i,
  /kushinagar|कुशीनगर/i,
  /ballia|बलिया/i,
  /mau\b|मऊ/i,
  /chandauli|चंदौली/i,
  /sonbhadra|सोनभद्र/i,
  /shahjahanpur|शाहजहांपुर/i,
  /rampur|रामपुर/i,
  /budaun|बदायूं/i,
  /bijnor|बिजनौर/i,
  /hathras|हाथरस/i,
  /kannauj|कन्नौज/i,
];

/** Signals that a row is about a DIFFERENT state — used to demote, not exclude. */
export const OTHER_STATES: RegExp[] = [
  /\bbihar\b|बिहार/i,
  /\bpatna\b|पटना/i,
  /maharashtra|महाराष्ट्र/i,
  /hingoli|हिंगोली/i,
  /\bnagpur\b|नागपुर/i,
  /\bmumbai\b|मुंबई/i,
  /west\s*bengal|पश्चिम\s*बंगाल|\bbengal\b|बंगाल/i,
  /jharkhand|झारखंड/i,
  /madhya\s*pradesh|मध्य\s*प्रदेश/i,
  /rajasthan|राजस्थान/i,
  /gujarat|गुजरात/i,
  /chhattisgarh|छत्तीसगढ/i,
  /\bodisha\b|ओडिशा/i,
  /\bpunjab\b|पंजाब/i,
  /haryana|हरियाणा/i,
  /jantar\s*mantar/i,
];

/** UP education-policy context terms (supporting, not sufficient, evidence). */
export const UP_POLICY_TERMS: RegExp[] = [
  /composite\s*school|कंपोजिट\s*स्कूल/i,
  /school\s*merger|स्कूल\s*विलय/i,
  /school\s*pairing|स्कूल\s*पेयरिंग/i,
  /shiksha\s*mitra|शिक्षा\s*मित्र/i,
];

/**
 * NAME-COLLISION TRAP. "स्कूल चलो अभियान" (School Chalo Abhiyan) is the UP
 * government's own pro-government school-ENROLMENT drive — completely unrelated
 * to CJP's School Thik Karo. It dominates Hindi search results for anything
 * shaped like "स्कूल … अभियान", so it must be actively excluded rather than
 * merely not-matched.
 */
export const EXCLUDE_TERMS: RegExp[] = [
  /school\s*chalo\s*abhiyan|स्कूल\s*चलो\s*अभियान/i,
  /citizens\s*for\s*justice\s*and\s*peace/i,
  /cjp\.org\.in/i,
  /teesta\s*setalvad/i,
];

/**
 * The genuinely viral UP story: the "Gen Alpha" school-student protest wave
 * that CJP amplified but did not organise. Coverage of these events often does
 * NOT name CJP at all, so they need their own detection axis or the UP corpus
 * comes back nearly empty.
 *
 *   Hamirpur  — 11-12 Aug 2026, children from Gangwa Ka Dera / Bachichi ka Dera
 *               / Chandupur marched ~5km ("Tiranga Yatra") to the DM's office
 *               for a paved road to school. Amplified by Dipke and
 *               @BhimArmyChief. Allahabad HC took suo motu cognisance.
 *   Fatehpur  — 28-29 Jul 2026, ~1,500 students of Sarvodaya Inter College,
 *               Kishanpur held a ~6-hour sit-in; 7 of 8 demands conceded.
 */
export const UP_PROTEST_EVENTS: RegExp[] = [
  /gen[\s-]*alpha/i,
  /tiranga\s*yatra|तिरंगा\s*यात्रा/i,
  /gangwa\s*ka\s*dera|बछिछी|bachichi/i,
  /chandupur|chandpur|चंदुपुर|चांदपुर/i,
  /sarvodaya\s*inter\s*college|सर्वोदय\s*इंटर\s*कॉलेज/i,
  /kishanpur|किशनपुर/i,
  /road\s*to\s*school|स्कूल\s*तक\s*सड़क|सड़क\s*की\s*मांग/i,
  /storm(?:ed)?\s*dm'?s?\s*office|डीएम\s*दफ्तर|कलेक्ट्रेट\s*पहुंचे/i,
];

/**
 * Campaign sub-events worth tagging in the output. The Hamirpur "road to
 * school" march and the Sarpanch Challenge are the two concrete hooks the
 * coverage keeps returning to.
 */
export const EVENT_TAGS: { tag: string; pattern: RegExp }[] = [
  { tag: "hamirpur_road_to_school", pattern: /hamirpur|हमीरपुर|road\s*to\s*school|स्कूल\s*तक\s*सड़क/i },
  { tag: "sarpanch_challenge", pattern: /sarpanch\s*challenge|सरपंच\s*चैलेंज|sarpanch|सरपंच/i },
  { tag: "collectorate_march", pattern: /collectorate|कलेक्ट्रेट|dm\s*office|डीएम\s*कार्यालय|जिलाधिकारी/i },
  { tag: "jantar_mantar", pattern: /jantar\s*mantar|जंतर\s*मंतर/i },
  { tag: "up_govt_response", pattern: /notice|नोटिस|यू-?टर्न|u-?turn|आदेश|शासनादेश/i },
];

/** Only keep content published within this window (campaign is days old). */
export const RECENCY_DAYS = 45;

export const OUTPUT_DIR = "cjp_output";
