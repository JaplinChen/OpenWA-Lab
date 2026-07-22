// One-time backfill: assign an initial category tag to each glossary term and de-shout all-caps
// Vietnamese targets. Casing normalization is category-INDEPENDENT and safe: only strings that
// contain Vietnamese diacritics AND are all-caps get sentence-cased (pure-ASCII names/company/codes
// are never touched), minus an acronym keeplist. Category is a best-effort label for the dashboard.
//
// Usage:  node scripts/backfill-glossary-categories.mjs [--apply]
//   (default = dry run: prints the report, writes nothing)
import * as fs from 'node:fs';
import * as path from 'node:path';

const APPLY = process.argv.includes('--apply');
const DATA = path.resolve('data');
const GLOSSARY = path.join(DATA, 'glossary.json');
const CATEGORY = path.join(DATA, 'glossary-category.json');

// Tokens preserved in ALL-CAPS even inside a normalized Vietnamese string (brands / acronyms / models).
const KEEP_UPPER = new Set([
  'LOGITECH', 'RALLY', 'PLUS', 'POLYCOM', 'SYNOLOGY', 'POE', 'WIFI', 'USB', 'HDMI', 'VGA', 'COM',
  'ERP', 'SFP', 'KVM', 'RJ45', 'PDU', 'RACK', 'LAN', 'CPU', 'GPU', 'RAM', 'DVD', 'CD', 'PC', 'TV',
  'TIVI', 'IP', 'HA', 'SAP', 'DXC', 'UBOX', 'TVBOX', 'FMA', 'MC', 'VPN', 'LED', 'LCD', 'RS232C',
  'POD', 'MIC', 'TYPE-C', 'TO', 'HDMI1',
]);
// Vietnamese-diacritic acronyms that must NOT be sentence-cased (would otherwise become "Bgđ").
const ACRONYM_KEEP = new Set(['BGĐ']);

const VN_DIACRITIC =
  /[ĂÂĐÊÔƠƯÀÁẢÃẠẰẮẲẴẶẦẤẨẪẬÈÉẺẼẸỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌỒỐỔỖỘỜỚỞỠỢÙÚỦŨỤỪỨỬỮỰỲÝỶỸỴăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/;
const hasLetter = s => /\p{L}/u.test(s);
const isUpper = s => hasLetter(s) && s === s.toUpperCase() && s !== s.toLowerCase();
const isAsciiToken = t => /^[A-Za-z0-9&/+\-]+$/.test(t);

// Sentence-case: first alphabetic char upper, rest lower — but keep brand/acronym/number tokens as-is.
function sentenceCase(v) {
  let first = true;
  return v
    .split(/(\s+|\/)/)
    .map(t => {
      if (t.trim() === '' || t === '/') return t;
      if (isAsciiToken(t) && (KEEP_UPPER.has(t.toUpperCase()) || /\d/.test(t))) return t;
      const lower = t.toLowerCase();
      if (first) {
        first = false;
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      }
      return lower;
    })
    .join('');
}

// Should this all-caps target be de-shouted? Only real Vietnamese (has diacritics), not acronyms.
function shouldNormalize(vi) {
  if (!isUpper(vi)) return false;
  if (ACRONYM_KEEP.has(vi.trim())) return false;
  return VN_DIACRITIC.test(vi);
}

const hanLen = s => [...s].filter(c => /\p{Script=Han}/u.test(c)).length;
function classify(zh, vi) {
  if (/[？?。，、！!：:]/.test(zh) || hanLen(zh) >= 8) return 'phrase';
  if (/(TNHH|C[ÔO]NG TY)/i.test(vi)) return 'name';
  const toks = vi.split(/\s+/);
  if (!VN_DIACRITIC.test(vi) && isUpper(vi) && toks.length >= 2 && toks.length <= 4 && toks.every(t => /^[A-Za-z\-]+$/.test(t)))
    return 'name';
  if (/[廠部室課組倉庫處站]|課長|組長|副總|協理|董事/.test(zh)) return 'dept';
  return 'term';
}

const glossary = JSON.parse(fs.readFileSync(GLOSSARY, 'utf8'));
const zv = glossary['zh-tw:vi'] || {};
const category = fs.existsSync(CATEGORY) ? JSON.parse(fs.readFileSync(CATEGORY, 'utf8')) : {};

const casingChanges = [];
const catCounts = {};
const newZv = {};
const reverseCollisions = [];
const seenTarget = new Map(); // normalized target -> zh (to detect reverse-map collisions)

for (const [zh, viRaw] of Object.entries(zv)) {
  const cat = classify(zh, viRaw);
  catCounts[cat] = (catCounts[cat] || 0) + 1;
  if (!category[zh]) category[zh] = cat; // don't clobber a manually-set tag

  let vi = viRaw;
  if (shouldNormalize(viRaw)) {
    vi = sentenceCase(viRaw);
    if (vi !== viRaw) casingChanges.push([zh, viRaw, vi]);
  }
  newZv[zh] = vi;
  if (seenTarget.has(vi)) reverseCollisions.push([vi, seenTarget.get(vi), zh]);
  else seenTarget.set(vi, zh);
}

// Rebuild both directions from the normalized zh->vi map.
const newVz = {};
for (const [zh, vi] of Object.entries(newZv)) newVz[vi] = zh;

console.log('=== 類別分布 ===');
for (const [c, n] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
console.log(`\n=== casing 變更: ${casingChanges.length} 筆 ===`);
casingChanges.slice(0, 25).forEach(([zh, a, b]) => console.log(`  ${zh}: ${a}  →  ${b}`));
if (casingChanges.length > 25) console.log(`  ...(其餘 ${casingChanges.length - 25} 筆)`);
console.log(`\n=== 反向鏡像碰撞 (不同中文→相同越南文): ${reverseCollisions.length} 筆 ===`);
reverseCollisions.forEach(([vi, a, b]) => console.log(`  "${vi}"  ←  ${a} / ${b}`));

if (!APPLY) {
  console.log('\n[dry-run] 未寫入。加 --apply 才會改檔（會先備份）。');
  process.exit(0);
}

const stamp = new Date(fs.statSync(GLOSSARY).mtime).toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(GLOSSARY, `${GLOSSARY}.bak-${stamp}`);
glossary['zh-tw:vi'] = newZv;
glossary['vi:zh-tw'] = newVz;
fs.writeFileSync(GLOSSARY, JSON.stringify(glossary, null, 2), 'utf8');
fs.writeFileSync(CATEGORY, JSON.stringify(category, null, 2), 'utf8');
console.log(`\n[applied] 備份: ${path.basename(GLOSSARY)}.bak-${stamp}`);
console.log(`  glossary 詞條: ${Object.keys(newZv).length}, 分類: ${Object.keys(category).length}, casing 改: ${casingChanges.length}`);
