# Cash Count 完整版 v2.0 设置

## 结构

网站 → Cloudflare Pages Function → Cash GAS → 原 FeedMe 年度 Report

Cash GAS 必须与原 FeedMe Close Up 完整 GAS 放在同一个 Apps Script Project 中，因为新版继续使用原有的 `resolveTarget_()`、`json_()`、年度文件与 Outlet routing。

## 1. 替换 Patch

删除旧的 `CashCountStandalonePatch_v1_1.gs` / `v1_2.gs`。同一个 Apps Script Project 只保留：

- 原 FeedMe 完整 GAS
- `CashCountStandalonePatch_v2_0.gs`

不要同时保留多个 Patch，否则常数和函数会重复。

## 2. doPost 路由

在原 GAS 的 `doPost()` lock 内、`throw new Error('Unsupported action')` 之前加入：

```javascript
if (payload.action === 'getStandaloneCashBootstrap') return standaloneCashBootstrap_(payload);
if (payload.action === 'saveStandaloneCashCount') return handleStandaloneCashCount_(payload);
if (payload.action === 'getStandaloneCashDashboard') return standaloneCashDashboard_(payload);
```

## 3. Secret 验证

```javascript
function validateSecret_(value) {
  const props = PropertiesService.getScriptProperties();
  const required = props.getProperty('CASH_GAS_SECRET') || props.getProperty('CLOSEUP_SECRET') || '';
  if (required && value !== required) throw new Error('Invalid secret');
}
```

## 4. Cash Script Properties

```text
CASH_GAS_SECRET = 88888888
CASH_OUTLET_NAME = RR-KCH
CASH_FOLDER_ID = 原 FeedMe Sales 根文件夹 ID
```

原本的 `OUTLET_FOLDER_...` 和 `TARGET_FILE_...` mapping 必须保留。

## 5. Cloudflare Production Variables

```text
CASH_GAS_URL = Cash Web App /exec URL
CASH_GAS_SECRET = 88888888
OUTLET_NAME = RR-KCH
```

## 6. Web App Deployment

```text
Deploy → Manage deployments → Edit
Version: New version
Execute as: Me
Who has access: Anyone
Deploy
```

## 新版行为

- 自动从 `_RelationDaily` 表头侦测所有 Payment `System / Actual / Remark` 栏位。
- Template 新增 Payment Method 后，前端自动出现，不需要再改前端。
- 选择日期会读取该日现有 Opening、所有 Handover、Closing、Payment Actual 与 Remark。
- Closing Submit 回写对应 Payment Actual / Remark 与 Cash Count。
- `_CashShiftLog` 保存每次 Cash 事件与 denomination JSON。
