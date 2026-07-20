# 下一步部署

这不是 Chrome Extension。不要在 `chrome://extensions` 使用 Load unpacked。

## 推荐方式

1. 把整个 `stupiak-standalone-operations` 文件夹放入一个新的 GitHub repository。
2. 在 Cloudflare Pages 连接该 repository。
3. Build command：`npm run build`
4. Output directory：`dist`
5. 部署后打开网址，进入 `Dev Settings`。
6. `Stock Count GAS URL` 已预填；输入 `STOCKCOUNT_SECRET` 后 Save。
7. 点击 `Test Stock Connection`，应显示 Outlet 和当前 Week。

## 为什么必须部署完整项目

项目中的 `functions/api/operations.js` 是 Google Apps Script Proxy：

- 避免浏览器直接连接 GAS 时发生 CORS 问题。
- 后期可在服务器端隐藏 GAS Secret。
- Submit 成功后可把标准事件发送给 Statvara。
- 后期可以接 Cloudflare R2 文件储存，而不改 Outlet UI。

只上传 `dist` 会没有这个服务器连接层，因此正式使用应部署整个 repository。

## 先不用开启的变量

Statvara 尚未连接时，不设置以下变量：

- `STATVARA_WEBHOOK_URL`
- `STATVARA_API_KEY`

未来设置后，成功提交才会发送：

- `stock.count.submitted`
- `cash.opening.submitted`
- `cash.handover.submitted`
- `cash.closing.submitted`

重复提交被 GAS 判定为 duplicate 时，不会重复通知 Statvara。

## Cash Count

Stock 可以先使用。Cash 页面已经完成，但要等现有 Cash GAS 加入：

`CashCountStandalonePatch_v1_1.gs`

并重新部署 Cash GAS 后，再把 Cash `/exec` URL 和 Secret 填入 Dev Settings。


## 推荐：把 Stock Secret 放在 Cloudflare，不要放在员工浏览器

在 Cloudflare Pages 项目进入：

```text
Settings → Variables and Secrets
```

新增以下 Production 变量：

```text
STOCK_GAS_URL = 你的 Stock GAS /exec URL
STOCK_GAS_SECRET = 与 Apps Script STOCKCOUNT_SECRET 相同的值
FILE_STORAGE_PROVIDER = google_drive
```

`STOCK_GAS_SECRET` 请设为 **Secret / Encrypt**，不要写进 GitHub、前端源代码或公开 ZIP。
重新部署后，Dev Settings 会显示 `Managed securely by Cloudflare`，Outlet 设备不需要输入或看到 Secret。
