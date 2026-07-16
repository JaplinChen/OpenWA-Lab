<p align="center">
  <img src="docs/logo/openwa_logo.webp" alt="OpenWA-Lab Logo" width="200"/>
</p>

<h1 align="center">OpenWA-Lab</h1>
<p align="center">
  <strong>OpenWA fork — 中越（zh ↔ vi）自動翻譯與儀表板擴充</strong>
</p>

> **這是 [rmyndharis/OpenWA](https://github.com/rmyndharis/OpenWA) 的 fork。**
> 完整的產品說明、功能清單與版本發佈請看上游專案：
> [📖 上游 README](https://github.com/rmyndharis/OpenWA/blob/main/README.md) ·
> [ℹ️ About](https://github.com/rmyndharis/OpenWA) ·
> [🏷️ Releases](https://github.com/rmyndharis/OpenWA/releases)
>
> 本 README **只記錄這個 fork 在上游之上新增的變更。**

---

## 這個 fork 新增了什麼

### 中越自動翻譯（zh ↔ vi）
- **自動翻譯外掛**：只對選定的 WhatsApp 群組翻譯訊息（繁體中文 ↔ 越南文）。
- **翻譯設定管理 UI** 加上 runtime API，不需重啟即可開關與調整翻譯設定。
- 聊天列表的 **翻譯群組篩選**，方便快速找到已翻譯的群組。

### 儀表板變更
- 側邊欄導覽整併進 **Settings**。
- 儀表板 i18n 新增 **越南文（vi）** 語系。
- 聊天捲動修正：捲動位置錨定在最後看到的訊息，另加 **回到底部** 按鈕。
- 修復 icon-row 頁尾的外觀／語言彈窗版面。
- **群組發話者標籤**：群組訊息以 WhatsApp 風格顯示發話者名稱（每位發話者固定配色）。
- **@mention 名稱解析**：把 `@<號碼>` 提及轉成聯絡人顯示名稱（已存名稱 → verifiedName → pushName）。
- **發送者對照表（sender directory）**：名稱解析查不到時（聯絡人未存、無 pushName），翻譯訊息會漏出原始 `@<號碼>`。可手動維護 JID → 顯示名稱 覆蓋表補上，翻譯前自動替換。維護方式：
  - WhatsApp 指令（限 `TRANSLATE_ADMIN_IDS` 名單）：
    - `/sender`：列出所有對照
    - `/sender add <JID或@號碼> = <名稱>`：新增／覆蓋，例 `/sender add 200859128434777 = 總經理`
    - `/sender del <JID或@號碼>`：移除
  - 儀表板「發送者」頁，或 REST `GET/POST/DELETE /translate/senders`（ADMIN）。
  - 儲存於 `data/senders.json`（可用 `TRANSLATE_SENDERS_PATH` 覆寫）。

### 更名
- 專案 **OpenWA → OpenWA-Lab** 全面更名：docker/infra、swagger、套件名、i18n、儀表板、文件。

---

## 快速開始

與上游相同——完整設定請見 [上游 README](https://github.com/rmyndharis/OpenWA/blob/main/README.md)。複製本 fork：

```bash
git clone https://github.com/JaplinChen/OpenWA-Lab.git
cd OpenWA-Lab
docker compose -f docker-compose.dev.yml up -d
# 儀表板: http://localhost:2785   API: http://localhost:2785/api   Swagger: http://localhost:2785/api/docs
```

---

## 授權

MIT——沿用上游。詳見 [LICENSE](./LICENSE)。

<div align="center">
<sub>Fork by <a href="https://github.com/JaplinChen">Japlin Chen</a> · 基於 <a href="https://github.com/rmyndharis">Yudhi Armyndharis</a> 的 <a href="https://github.com/rmyndharis/OpenWA">OpenWA</a></sub>
</div>
