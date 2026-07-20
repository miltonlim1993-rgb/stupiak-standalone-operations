# Cash Count 完整版 v2.0 设置

## 推荐结构

```text
旧 FeedMe Extension / Backfill ─┐
                               ├→ 同一个 FeedMe Cash GAS → 原 FeedMe 年度 Report
新 Standalone Website ─────────┘
```

最安全、最简单的方法，是把新版 Patch 加进**目前仍在使用的 FeedMe Close Up Apps Script Project**。旧的 Backfill、Close Up action 全部保留；新网站只是增加三个新 action。

使用另外复制的 Apps Script Project 也可以，但里面必须有完整 FeedMe GAS、`resolveTarget_()`、`json_()` 和全部 Outlet/Target mapping，不能只有 Patch。

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

## 4. Apps Script Properties

必须有：

```text
CASH_GAS_SECRET = 88888888
CASH_OUTLET_NAME = RR-KCH
```

原 FeedMe GAS 已有的这些 routing 资料必须原样保留：

```text
OUTLET_FOLDER_...
TARGET_FILE_...
SALES_DRIVE_FOLDER_ID（若原代码使用）
SALES_TEMPLATE_SPREADSHEET_ID（若原代码使用）
```

`CASH_FOLDER_ID` 不是新版 Patch 的必填项。只有你的原 `resolveTarget_()` 明确读取它时才保留；不要用它替代现有 `OUTLET_FOLDER_...` / `TARGET_FILE_...` mapping。

## 5. Cloudflare Production Variables

```text
CASH_GAS_URL = 已更新的 Cash Web App /exec URL
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

更新现有 Deployment 可以保留同一个 `/exec` URL。

## 新版行为

- 自动从 `_RelationDaily` 表头侦测所有 Payment `System / Actual / Remark` 栏位。
- Template 新增 Payment Method 后，前端自动出现，不需要再改前端。
- 选择日期会读取该日现有 Opening、Handover、Closing、Payment Actual 与 Remark。
- 新版提交的每一次 Handover 都会保存在 `_CashShiftLog`。
- Closing Submit 回写对应 Payment Actual / Remark 与 Cash Count。
- `_CashShiftLog` 保存 denomination JSON，之后可完整读回纸币／硬币数量。

## 旧资料可读范围

- `_RelationDaily` 已有的 Payment Actual、Remark、Opening/Handover/Closing total 可以读回。
- 旧系统若从未保存 denomination JSON，只能读回总额，无法还原当时每一种纸币数量。
- 旧 `_RelationDaily` 只保留一组 Handover summary 时，无法还原同一天更早被覆盖的多个 Handover；新版之后的每次 Handover 都不会丢失。
