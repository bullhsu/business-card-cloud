# 名片雲端

Cloudflare Workers + R2 + D1 的名片掃描雲端工具。手機開啟網頁後可拍攝名片正面與背面，儲存圖片與聯絡資料，並為後續 Google Contacts 同步保留資料欄位。

## 隱私與資源隔離

這個 repository 只包含程式碼與空白資料庫 migration，不包含作者已上傳的名片、聯絡人資料、R2 圖片、D1 備份、Worker 網域或任何 API key。

每位使用者都必須在自己的 Cloudflare 帳號建立獨立的 Worker、D1 database 與 R2 bucket，並使用自己的 OpenAI API key 與 Google OAuth credentials。請勿連接作者或其他人的 Cloudflare 資源，也不要把 `.dev.vars`、資料庫匯出檔或真實 credentials 提交到 Git。

目前專案尚未實作使用者登入與多租戶資料隔離。部署到公開網域前，請先以 Cloudflare Access 或等效的驗證機制限制存取；否則知道 Worker 網址的人可能存取名片 API。不要把正式 Worker 網址公開分享。

## 目前完成

- 手機相機上傳名片正面與背面。
- 聯絡人資料表單。
- Worker API：名片新增、更新、刪除、OpenAI Vision 辨識與 Google 同步。
- R2：正反面圖片分別存為 object。
- D1：儲存聯絡人欄位、正反面 object key、正反面應用內連結。
- Google Contacts OAuth 與 People API 同步流程。
- PWA manifest 與主畫面 icon。

## App 圖示

目前預設圖示在 `public/icon.svg`，PWA manifest 在 `public/site.webmanifest`。

若要換正式圖示，建議準備：

- 1024 x 1024 PNG，正方形，不要自行裁圓角。
- 主視覺置中，四周保留約 10% 到 15% 安全邊界。
- 背景不要透明，iOS 加到主畫面時比較穩。
- 若有 SVG、Figma 匯出或品牌 logo 原檔，也可以直接替換。

## Google Contacts 設定

1. 到 Google Cloud Console 建立或選擇一個專案。
2. 啟用 People API。
3. 建立 OAuth consent screen，測試階段可先把自己的 Google 帳號加入 test users。
4. 建立 OAuth Client ID，類型選 Web application。
5. Authorized redirect URI 加入：

```text
https://business-card-cloud.<your-workers-subdomain>.workers.dev/api/google/callback
```

6. 將憑證設為 Cloudflare Worker secrets：

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

7. 重新部署後，到 App 設定裡點「登入 Google 帳號」，授權 scope：

```text
https://www.googleapis.com/auth/contacts
```

同步時會建立或使用設定中的 Google 聯絡人標籤，並把名片正反面連結同步到 Google Contacts 的 URL、自訂欄位與備註。

## 正反面連結策略

Google Contacts 不適合作為名片掃描圖庫。這個專案會把原始圖片放在 Cloudflare R2，並在 D1 裡保存：

- `front_image_url`
- `back_image_url`

之後同步到 Google Contacts 時，會把這兩條連結放進聯絡人的備註或 URL 欄位。圖片仍由本 App 控制權限。

## 自己用 vs 朋友一起用

### 僅自己用

- Google OAuth 可以先維持測試或內部使用情境。
- 資料模型可以先不做多租戶，所有名片都屬於你。
- R2 圖片連結可以只要求你登入後可看。
- 去重規則可以依你的 Google Contacts 做 email/電話比對。
- 隱私政策與 OAuth 驗證壓力較低，但仍應清楚記錄資料用途。

### 給朋友一起用

- 必須加上使用者帳號與資料隔離，資料表需新增 `user_id`。
- 每位使用者要各自授權 Google OAuth，token 必須分開加密保存。
- R2 圖片路由必須檢查圖片擁有者，不能只靠 URL 隱藏。
- Google OAuth 若對外使用 Contacts 權限，可能需要完成 Google app verification。
- 需要正式的隱私政策、資料刪除機制、授權撤銷流程。
- 去重只能在各自帳號內做，不能跨朋友共享 Google 聯絡人資料。
- 若朋友之間要共享同一張名片，需另外設計共享權限與審計紀錄。

## 本機開發

```bash
npm install
npm run dev
```

## Cloudflare 資源

先登入自己的 Cloudflare 帳號，再建立自己的 R2 bucket：

```bash
npx wrangler r2 bucket create business-card-images
```

建立自己的 D1 database，並把指令回傳的 `database_id` 填入 `wrangler.jsonc`。Repository 中的全零 ID 只是安全 placeholder，不能直接部署：

```bash
npx wrangler d1 create business-card-cloud
npx wrangler d1 migrations apply business-card-cloud --local
```

部署前套用遠端 migration：

```bash
npx wrangler d1 migrations apply business-card-cloud --remote
npm run deploy
```

## 下一步

- 加入 Google OAuth 登入。
- 建立或取得 Google Contacts 的 `工作聯絡人` contact group。
- 建立/更新聯絡人，並把正反面名片連結同步到備註。
- 視覺辨識使用伺服器端 OpenAI API；請勿把 API key 放在前端或提交到 Git。

## OpenAI Vision 設定

視覺辨識統一使用伺服器端 OpenAI API。請在本機 `.dev.vars` 或 Cloudflare Worker Secret 設定：

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put OPENAI_MODEL # 可選，預設 gpt-4o-mini
```

本機開發可複製 `.dev.vars.example` 為 `.dev.vars` 後填入金鑰。部署前請確認 `.dev.vars` 不會被提交。
- 若要多人使用，先新增使用者資料表與權限檢查。
