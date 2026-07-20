# Stock Count Monthly GAS Setup

## A. Prepare the original-layout template

1. Upload `13072026.xlsx` to the outlet's Google Drive.
2. Open it with Google Sheets and save/convert it as a Google Spreadsheet.
3. Do not rename, reorder, delete, or redesign these visible sheets. The uploaded Excel contains invisible trailing spaces in `Inventory ` and `Stationary `; the supplied GAS supports both the original names and names trimmed by Google Sheets:
   - Order Page
   - Inventory
   - Untensil PG1
   - Utensil PG2
   - Stationary
4. Rename the spreadsheet so its file name identifies the outlet, for example:

```text
RH Plaza - Stock Count Template
```

The GAS can derive `RH Plaza` from this name. Alternatively, set `STOCK_OUTLET_NAME` explicitly.

## B. Create the monthly folder

Create one Drive folder for that outlet, for example:

```text
Stock Count / RH Plaza
```

Copy the folder ID from its Drive URL.

## C. Add Apps Script

1. In the original-layout Google Spreadsheet, open **Extensions → Apps Script**.
2. Replace the default code with `StockCountMonthly.gs`.
3. Open **Project Settings → Script Properties**.
4. Add:

```text
STOCK_MONTHLY_FOLDER_ID = <the outlet folder ID>
STOCK_TEMPLATE_SPREADSHEET_ID = <the original-layout Google Spreadsheet ID>
STOCK_OUTLET_NAME = RH Plaza
STOCK_FILE_PREFIX = Stock Count
STOCKCOUNT_SECRET = <your private secret>
```

Optional:

```text
WHATSAPP_PHONE = 60123456789
```

Leave `WHATSAPP_PHONE` blank when the operator should choose a WhatsApp group manually.

## D. Time zone

In Apps Script Project Settings, set the time zone to:

```text
Asia/Kuala_Lumpur
```

## E. Deploy

1. Click **Deploy → New deployment**.
2. Type: **Web app**.
3. Execute as: **Me**.
4. Who has access: choose the access level required by your frontend deployment.
5. Copy the `/exec` URL.
6. Put that URL only in the frontend's **Stock Count GAS URL** setting.

Do not put it into Cash Count GAS URL.

## F. Monthly result

The first request for a month creates:

```text
Stock Count - RH Plaza - 2026-07
```

The first request in the next month creates:

```text
Stock Count - RH Plaza - 2026-08
```

Both files stay in the configured outlet folder. The original template is not filled with live stock counts.
