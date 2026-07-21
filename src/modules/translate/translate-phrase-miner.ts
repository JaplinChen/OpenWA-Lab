// High-frequency phrase mining over recorded translation sources. The translation_memory table
// dedupes on the whole message, so exact sentences rarely repeat — this instead slices each Chinese
// source into 2–4-char n-grams and counts how many DISTINCT messages each fragment appears in, so a
// term used across many different sentences surfaces even when no sentence repeats verbatim.

const CJK = /[一-鿿]/;

export interface SourceCount {
  source: string;
  count: number; // repeat count of the whole message (translation_memory.count)
}

export interface PhraseCount {
  phrase: string;
  count: number; // number of distinct messages the phrase appears in (weighted by message count)
}

export interface MineOptions {
  minLen?: number; // shortest n-gram, default 2
  maxLen?: number; // longest n-gram, default 4
  minCount?: number; // frequency threshold, default 3
  limit?: number; // top-N returned, default 30
  exclude?: Set<string>; // phrases already in the glossary — skipped
}

/** Contiguous Chinese runs in a string (mixed-language messages keep only the CJK parts). */
function cjkRuns(text: string): string[] {
  return (text.match(/[一-鿿]+/g) as string[] | null) || [];
}

/**
 * Count 2–4-char Chinese fragments across messages. Each fragment counts once per message (not once
 * per occurrence) so a single repetitive sentence can't inflate it; the message's own repeat count is
 * added as weight. Fragments already in the glossary, or below the frequency threshold, are dropped.
 *
 * ponytail: emits nested substrings (客戶的 also yields 客戶, 戶的). Noise like 戶的 is filtered
 * downstream by the LLM enrichment pass (returns non-term → skipped) + the minCount gate. Add a
 * redundancy filter (drop a short n-gram dominated by a longer one) only if the LLM pass proves noisy.
 */
export function minePhrases(sources: SourceCount[], opts: MineOptions = {}): PhraseCount[] {
  const minLen = opts.minLen ?? 2;
  const maxLen = opts.maxLen ?? 4;
  const minCount = opts.minCount ?? 3;
  const limit = opts.limit ?? 30;
  const exclude = opts.exclude ?? new Set<string>();

  const tally = new Map<string, number>();
  for (const { source, count } of sources) {
    const weight = count > 0 ? count : 1;
    const seen = new Set<string>(); // per-message dedupe
    for (const run of cjkRuns(source)) {
      for (let n = minLen; n <= maxLen; n++) {
        for (let i = 0; i + n <= run.length; i++) {
          const frag = run.slice(i, i + n);
          if (!CJK.test(frag) || exclude.has(frag) || seen.has(frag)) continue;
          seen.add(frag);
          tally.set(frag, (tally.get(frag) ?? 0) + weight);
        }
      }
    }
  }

  return [...tally.entries()]
    .filter(([, c]) => c >= minCount)
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count || b.phrase.length - a.phrase.length)
    .slice(0, Math.max(1, limit));
}

// ponytail: assert-based self-check — run `node -r ts-node/register translate-phrase-miner.ts`
if (require.main === module) {
  const src: SourceCount[] = [
    { source: '客戶的 forecast 很重要', count: 1 },
    { source: '這是客戶的資料', count: 1 },
    { source: '請確認客戶的訂單', count: 1 },
    { source: 'hello world', count: 5 }, // no CJK → contributes nothing
  ];
  const out = minePhrases(src, { minCount: 3 });
  const hit = out.find(p => p.phrase === '客戶');
  if (!hit || hit.count !== 3) throw new Error(`expected 客戶 count 3, got ${JSON.stringify(hit)}`);
  const excluded = minePhrases(src, { minCount: 3, exclude: new Set(['客戶']) });
  if (excluded.some(p => p.phrase === '客戶')) throw new Error('exclude set not honored');
  // eslint-disable-next-line no-console
  console.log('minePhrases self-check ok', out.slice(0, 3));
}
