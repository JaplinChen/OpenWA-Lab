# OpenWA-Lab Dashboard 改版計劃

規劃階段，尚未實作。範圍全部在 `dashboard/` 前端。

## 目標總覽

1. 側邊欄精簡：只留「控制面板 / 聊天 / 記錄」+「設定」，其餘全部收進「設定」頁面。
2. 「翻譯」改名為「翻譯群組」。
3. 側邊欄底部「切換語系 / Theme / 登入登出」改為 純 ICON + Tooltip（收合文字）。
4. 語系新增越南語 (vi)，含完整 i18n 翻譯檔。
5. 專案名稱 `OpenWA` → `OpenWA-Lab`。

---

## 一、側邊欄重整 + 新增「設定」頁

### 現況
`dashboard/src/components/Layout.tsx:37-50` 的 `allNavItems` 列 11 個頁面。
路由在 `dashboard/src/App.tsx`。

### 分類
- 主導覽（保留在側邊欄）：控制面板 `/`、聊天 `/chats`、記錄 `/logs`
- 收進「設定」的頁面：工作階段、Webhooks、Templates、翻譯群組、API金鑰、訊息測試器、基礎架構、外掛

### 做法（採「設定作為容器頁 + 子分頁」）
- 新增 `dashboard/src/pages/Settings.tsx`：左側/頂部次選單列出 8 個子項，右側渲染對應現有頁面元件（直接 import 復用，不重寫）。
- 路由改為巢狀：`/settings` → `Settings`，底下 `/settings/sessions`、`/settings/webhooks`、`/settings/templates`、`/settings/translate`、`/settings/api-keys`、`/settings/message-tester`、`/settings/infrastructure`、`/settings/plugins`。
- 保留 admin-only 過濾邏輯（apiKeys / infrastructure / plugins 僅 admin）搬到 Settings 子選單。
- 舊路由 `/sessions` `/webhooks` 等：加 redirect 到新 `/settings/*`，避免既有連結/書籤 404。
- `allNavItems` 縮成 4 項：dashboard、chats、logs、settings（icon 用 `Settings` from lucide）。

### 待決策
Settings 子頁的版面：**左側次側欄** vs **頂部 tab**。建議左側次側欄（項目多、與主側邊欄一致）。等你確認。

### 影響檔案
- `Layout.tsx`（改 navItems）
- `App.tsx`（改路由 + redirect）
- 新增 `pages/Settings.tsx` + `Settings.css`
- i18n：新增 `nav.settings`、`settings.*` 子選單標題

---

## 二、「翻譯」→「翻譯群組」

- 只改顯示字串，不動路由/元件檔名（`Translate.tsx` 保留）。
- i18n key `nav.translate` 值：Translation → Translation Groups（各語系同步）。
- 繁中：翻譯 → 翻譯群組。
- 此項目本身移入「設定」子選單（見第一點），側邊欄不再直接出現。

---

## 三、底部控制項改 ICON + Tooltip

### 現況
`Layout.tsx:231-337` 三個按鈕（語系 / 外觀 / 登出）在非收合狀態會顯示文字 label。

### 做法
- 三顆按鈕一律只顯示 icon，移除 `{!isCollapsed && <span>...}` 文字。
- 加 `title`（原生 tooltip）＝已有的 `aria-label`；語系鈕 tooltip 顯示目前語言名稱，外觀鈕顯示目前主題名稱。
- 三顆改成水平排列一列（icon 按鈕），節省高度。CSS 調整 `.sidebar-footer` 為 flex row、置中。
- 點開的下拉選單（語系清單 / 外觀面板）維持不變。
- 收合(collapsed)狀態行為不變。

### 影響檔案
- `Layout.tsx`、`Layout.css`

### 待決策
tooltip 要用原生 `title`（0 成本）還是自製 tooltip 元件？建議原生 title。等你確認。

---

## 四、新增越南語 (vi)

### 現況
i18n 於 `dashboard/src/i18n/index.ts`，10 語系，語系檔在 `src/i18n/locales/*.json`。

### 做法
1. 新增 `src/i18n/locales/vi.json`：以 `en.json` 為基準完整翻譯（所有 key，避免落回 fallback）。
2. `index.ts`：
   - import `vi`
   - `supportedLanguages` 加 `'vi'`
   - `languageOptions` 加 `{ value: 'vi', label: 'Tiếng Việt', compactLabel: 'VI' }`
   - `resources` 加 `vi: { translation: vi }`
3. 非 RTL，`rtlLanguages` 不動。

### 影響檔案
- `index.ts` + 新增 `vi.json`
- 註：既有翻譯群組功能是 zh↔vi 自動翻譯，vi UI 語系與之獨立、不衝突。

---

## 五、專案更名 OpenWA → OpenWA-Lab

### 只改「顯示名稱」，不改 storage key / 圖檔名 / package name
避免破壞既有 localStorage（`openwa_theme`、`openwa_language`、`openwa_api_key` 等）與資源路徑。

### 要改
- `dashboard/index.html:7` `<title>` → `OpenWA-Lab`
- 各語系 JSON `common.appName`：`OpenWA` → `OpenWA-Lab`（10 + vi = 11 檔）
- 側邊欄品牌名透過 `t('common.appName')` 自動生效，無需改 `Layout.tsx`

### 不改（保留）
- `package.json` name（內部識別）
- `openwa_logo.webp`、`openwa_*` storage/api key
- README（除非你要一起改）

### 待決策
README 與 `package.json` name 要不要一起更名？預設不動。

---

## 執行分批（實作階段）

| 批次 | 內容 | 驗證 |
|------|------|------|
| 1 | 越南語 vi.json + i18n 註冊 | `npm run build` |
| 2 | 更名 OpenWA-Lab（title + appName x11） | `npm run build` |
| 3 | 底部控制項 icon+tooltip | build + `/browse` 截圖 |
| 4 | Settings 頁 + 路由重整 + 側邊欄精簡 + 翻譯群組改名 | build + `/browse` 截圖 |

批次 4 最大，觸碰 Layout/App/新頁面/CSS/i18n，實作時再細拆。

## 待你確認的決策點
1. Settings 子頁版面：左側次側欄（建議）/ 頂部 tab？
2. Tooltip：原生 `title`（建議）/ 自製元件？
3. 更名是否含 README 與 package.json name？（預設否）
