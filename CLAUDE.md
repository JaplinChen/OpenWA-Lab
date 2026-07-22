# OpenWA-Lab — 專案指令

## Translate 模組機制

### 發送者對照表（sender directory）

未解析的 @提及 JID（如 `@200859128434777`）會漏進翻譯訊息，因 sessionStore 查無該聯絡人名字（未存、無 pushName）。sender 對照表補此缺口，比照 glossary 全套。

- **唯一注入點**：`TranslateService.translate()` 內 `buildPrompt(this.senders.apply(text), ...)` — 送 Ollama 前把 `@<jid>` 換成 `@<name>`。要改替換行為改這裡，不要動 adapter 的 `resolveMentionNames`（避免跨模組耦合）。
- **儲存**：`data/senders.json`，flat `{ "<digits>": "<name>" }`，`TRANSLATE_SENDERS_PATH` 可覆寫。
- **類**：`src/modules/translate/translate-senders.ts` 的 `SenderDirectory`（load/entries/add/remove/apply/command）。normalize 接受 `200...@c.us`／`@200...`／純數字，只存 digits。
- **指令**：`/sender`、`/sender add <JID>=名稱`、`/sender del <JID>`，admin 沿用 `TRANSLATE_ADMIN_IDS`。
- **REST**：`GET/POST/DELETE /translate/senders`（ADMIN）。前端頁 `dashboard/src/pages/Senders.tsx`（重用 Glossary.css）。

### 高頻詞候選（phrase candidates）

整句 `translation_memory` 候選幾乎不重複（`UNIQUE(pair_key, source)`），候選頁長期停在「出現1次」。高頻詞候選補詞彙級路徑：從歷史翻譯挖高頻中文片段 → 濾掉已在 glossary 的 → LLM 批次補越南譯法 → 複用 glossary ok/no 審核。dashboard「詞彙表」頁第三個「高頻詞」tab（在翻譯候選、詞條之間）。

- **挖詞**：`src/modules/translate/translate-phrase-miner.ts` 純函式 `minePhrases(sources, opts)` — 中文 2–4 字滑窗、每訊息去重、乘 message count 權重、過 glossary exclude set 與 minCount 門檻（env `TRANSLATE_PHRASE_MIN_COUNT`，預設 3）。會噴 nested substring 噪音（客戶的→客戶/戶的），交由 LLM 補譯階段過濾（非術語回空字串即跳過）。
- **儲存**：`translate-phrase-candidates.ts` 的 `PhraseCandidates` — **另存** `phrase_candidates` 表（同 `translations.sqlite`，不污染 `translation_memory`），`UNIQUE(phrase)`，upsert `ON CONFLICT WHERE status='new'` 防已審核片段復活。
- **串接**：`TranslateService.scanPhrases()` = `memory.allSources()` → `minePhrases()` → `translatePhrases()`（一次 LLM 回 JSON `{片段:越南文}`）→ upsert。掃描為 dashboard 手動觸發，不在翻譯熱路徑。
- **REST**：`POST /translate/memory/phrases/scan`、`GET /translate/memory/phrases`、`POST .../:id/approve`、`DELETE .../:id`（皆 ADMIN）。前端 Glossary 第三 tab 複用 `MemoryCandidates` 元件（phrase 映射 source 欄）。

**要新增同類「翻譯覆蓋表」**：照 glossary/senders 走一遍 — class + service CRUD + controller + dto + 前端頁重用 Glossary.css + nav i18n（en/zh-HK/zh-CN/vi）。
