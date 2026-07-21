# Stock Count D1 一次性设置

## 目标

前端打开 Stock Count 时优先读取 Cloudflare D1，不再每次等待 Google Apps Script 扫描整份月度 Spreadsheet。

保存流程：

```text
Browser draft
→ Cloudflare D1（立即确认）
→ 后台同步 Google Apps Script
→ _StockRelation / Google Sheet 报表镜像
```

## Cloudflare 后台设置

1. 打开 Cloudflare Dashboard。
2. 进入 `Storage & Databases` → `D1 SQL Database`。
3. 建立数据库：

```text
stupiak-operations
```

4. 回到 `Workers & Pages` → `stupiakops` → `Settings` → `Bindings`。
5. 添加 `D1 database binding`：

```text
Variable name: STOCK_DB
D1 database: stupiak-operations
```

6. Production 和 Preview 都使用同一个 binding（测试阶段可先只设 Production）。
7. 保存后重新部署最新 `main`。

第一次 Stock 请求会自动建立需要的数据表，不需要先在 Console 手动执行 SQL。仓库仍保留：

```text
migrations/0001_stock_d1.sql
```

作为审计和后续 migration 使用。

## 可选变量

只有当前项目没有从 URL 带 outlet 时才需要：

```text
STOCK_DEFAULT_OUTLET = RR-KCH
```

正常 outlet 专属网址会直接把 outlet key 发送给 D1，不依赖这个 fallback。

## 验证

打开：

```text
https://stupiakops.pages.dev/api/system
```

应看到：

```json
{
  "stockD1Configured": true,
  "stockConnectionMode": "cloudflare_d1_with_sheet_mirror"
}
```

第一次打开某个月份：

```text
D1 尚无 snapshot
→ 从 GAS 抓一次
→ 存入 D1
```

第二次打开同一个 outlet + month：

```text
直接从 D1 返回
```

保存时前端收到：

```text
dataSource: cloudflare-d1
gasSyncStatus: pending
```

Google Sheet 同步完成后，D1 queue 会转为：

```text
synced
```
