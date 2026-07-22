// Re-classify glossary categories with an LLM (the regex backfill mis-tagged many).
// Dry run by default: prints a report + writes data/reclassify-report.txt, changes nothing.
// Add --apply to write the category sidecar (backs it up first).
//
// Deterministic override (see override() below), applied AFTER the LLM and reflected in the dry-run
// report: any 表單/一覽表/XX表 noun is pinned to `term` (the model scatters these into asset/phrase),
// except terms with a sentence-ending mark (？?。，、！!) which keep the LLM's call (UI prompts/questions).
//
// Usage:  node scripts/reclassify-glossary-categories.mjs [--apply]
// Env:    RECLASS_MODEL (default qwen3-14b-cline-32768:latest)
//         OLLAMA_ENDPOINT (default http://127.0.0.1:11434/api/chat)
import * as fs from 'node:fs';
import * as path from 'node:path';

const APPLY = process.argv.includes('--apply');
const DATA = path.resolve('data');
const GLOSSARY = path.join(DATA, 'glossary.json');
const CATEGORY = path.join(DATA, 'glossary-category.json');
const REPORT = path.join(DATA, 'reclassify-report.txt');
const ENDPOINT = process.env.OLLAMA_ENDPOINT || 'http://127.0.0.1:11434/api/chat';
const MODEL = process.env.RECLASS_MODEL || 'qwen3-14b-cline-32768:latest';
const BATCH = 25;

// value -> human label; the taxonomy the model must choose from (must match the dashboard's options).
const CATS = {
  name: '人名：真實人名、敬稱、頭銜、職稱代稱（如「大董」=董事長、「三董」）',
  dept: '部門：工廠/部/室/課/組/倉/庫/站等組織單位（如「一廠」「品管室」）',
  term: '術語：一般技術或業務名詞、抽象概念（如「大數據」「人工智能」）',
  asset: '資產：實體設備、器材、產品、物料、料號（如「定時器」「零件庫」的物品）',
  phrase: '對話：完整句子或多字口語片語（如「工作態度良好、合作性強」）',
  other: '其他：無法歸入以上任一類',
};
const VALID = new Set(Object.keys(CATS));

// Deterministic overrides applied AFTER the LLM: fixes systematic boundary mistakes the model makes.
// 表/表單/一覽表 are form/list nouns the model scatters into asset/phrase — pin them to term.
function override(zh, cat) {
  if (/[？?。，、！!]/.test(zh)) return cat; // 帶句末標點的句子維持 LLM 判斷（多為 UI 提示/問句）
  if (/表單|一覽表|表$/.test(zh)) return 'term';
  return cat;
}

const glossary = JSON.parse(fs.readFileSync(GLOSSARY, 'utf8'));
const zv = glossary['zh-tw:vi'] || {};
const current = fs.existsSync(CATEGORY) ? JSON.parse(fs.readFileSync(CATEGORY, 'utf8')) : {};
const terms = Object.entries(zv).map(([zh, vi]) => ({ zh, vi }));

const SYSTEM =
  '你是詞彙分類器。根據中文詞條（附越南文譯法輔助判斷）把每個詞歸到唯一一個類別代碼。' +
  '類別：\n' +
  Object.entries(CATS)
    .map(([k, v]) => `- ${k} = ${v}`)
    .join('\n') +
  '\n只輸出 JSON 物件，key 是中文詞條原字串，value 是類別代碼（name/dept/term/asset/phrase/other 之一），不要多餘文字。';

async function classifyBatch(batch) {
  const body = {
    model: MODEL,
    stream: false,
    think: false,
    format: 'json',
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(batch.map(t => ({ zh: t.zh, vi: t.vi }))) },
    ],
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.message.content);
}

const result = {}; // zh -> category
let failed = 0;
for (let i = 0; i < terms.length; i += BATCH) {
  const batch = terms.slice(i, i + BATCH);
  try {
    const map = await classifyBatch(batch);
    for (const { zh } of batch) {
      const cat = map[zh];
      result[zh] = override(zh, VALID.has(cat) ? cat : 'other');
    }
  } catch (err) {
    failed += batch.length;
    for (const { zh } of batch) result[zh] = current[zh] || 'other'; // keep existing on failure
    process.stderr.write(`batch ${i}: ${err.message}\n`);
  }
  process.stderr.write(`\r${Math.min(i + BATCH, terms.length)}/${terms.length}`);
}
process.stderr.write('\n');

// Build report.
const changes = [];
const before = {};
const after = {};
for (const { zh, vi } of terms) {
  const oldC = current[zh] || '';
  const newC = result[zh];
  before[oldC || '(未設)'] = (before[oldC || '(未設)'] || 0) + 1;
  after[newC] = (after[newC] || 0) + 1;
  if (oldC !== newC) changes.push({ zh, vi, oldC: oldC || '(未設)', newC });
}

const lines = [];
lines.push(`模型: ${MODEL}   詞條: ${terms.length}   失敗(保留原值): ${failed}`);
lines.push('\n=== 類別分布 (前 → 後) ===');
for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort())
  lines.push(`  ${k.padEnd(8)} ${String(before[k] || 0).padStart(4)} → ${String(after[k] || 0).padStart(4)}`);
lines.push(`\n=== 變更 ${changes.length} 筆 ===`);
for (const c of changes) lines.push(`  ${c.zh}  [${c.vi}]  ${c.oldC} → ${c.newC}`);

const report = lines.join('\n');
fs.writeFileSync(REPORT, report + '\n', 'utf8');
console.log(report.split('\n').slice(0, 60).join('\n'));
console.log(`\n完整報告: ${path.relative(process.cwd(), REPORT)}（共 ${changes.length} 筆變更）`);

if (!APPLY) {
  console.log('\n[dry-run] 未寫入。確認後加 --apply 才會改分類（會先備份）。');
  process.exit(0);
}

const stamp = new Date(fs.statSync(CATEGORY).mtime).toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(CATEGORY, `${CATEGORY}.bak-${stamp}`);
const merged = { ...current };
for (const { zh } of terms) merged[zh] = result[zh];
fs.writeFileSync(CATEGORY, JSON.stringify(merged, null, 2), 'utf8');
console.log(`\n[applied] 備份: ${path.basename(CATEGORY)}.bak-${stamp}，已寫入 ${terms.length} 筆分類。`);
