# Dashboard v1.2 设置

## 已加入的页面

- Dashboard → Stock / Cash 切换
- 自定义 From / To 日期
- This month / Last 3 months / Year to date
- Stock 每月文件、盘点次数、最新数量、变化、最低库存、状态、完整历史
- Cash 每月、每日、Opening、多个 Handover、Closing、Variance 与缺少 Closing

## Stock GAS

1. 打开 Stock Template Google Sheet。
2. Extensions → Apps Script。
3. 使用 `StockCountMonthly.gs` v2.2.0 完整替换旧代码。
4. Deploy → Manage deployments → Edit。
5. Version 选择 New version，然后 Deploy。
6. `/exec` URL 不需要改；Cloudflare 的 STOCK_GAS_URL 保持原本 URL。

新版本会：

- 读取日期范围内所有月份文件。
- 读取现有 Week 1–5 数量和 Stationary。
- 以后每次 Submit 额外写入隐藏 `_StockHistory`，保留不可变的品项历史。

## Cash GAS

把 `CashCountStandalonePatch_v1_2.gs` 加入原 Cash Apps Script，并在原 `doPost` routing 加入：

```js
if (payload.action === 'saveStandaloneCashCount') {
  return handleStandaloneCashCount_(payload);
}
if (payload.action === 'getStandaloneCashDashboard') {
  return standaloneCashDashboard_(payload);
}
```

然后部署 New version。

Cloudflare Production variables 需要：

```text
CASH_GAS_URL
CASH_GAS_SECRET
```

Stock 和 Cash URL / Secret 继续完全分开。
