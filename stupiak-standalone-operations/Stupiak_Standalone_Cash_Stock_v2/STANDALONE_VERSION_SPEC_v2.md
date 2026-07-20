# Stupiak Standalone Cash + Stock — Frozen Scope v2

## 1. Correction from v1

The Stock Count spreadsheet must **not** be normalized, redesigned, or rearranged.

The uploaded `13072026.xlsx` remains the visible Stock Count template and source of truth. Its visible worksheet order, names, row order, item order, weekly columns, formulas, colours, widths, merged cells, status columns, minimum columns, and `Order Page` layout must be preserved.

Visible worksheet order:

1. `Order Page`
2. `Inventory`
3. `Untensil PG1`
4. `Utensil PG2`
5. `Stationary`

Technical note: the Excel XML contains trailing spaces in `Inventory ` and `Stationary `. The GAS resolves both exact original names and Google-converted trimmed names without renaming the visible tabs.

Hidden technical sheets such as `_Submissions` and `_Meta` are allowed because they do not change the operator-facing layout.

---

## 2. Application scope

This is a standalone version. It does not use FeedMe.

```text
Home
├── Cash Count
│   ├── Opening
│   ├── Handover — unlimited events
│   ├── Closing
│   └── Today History
├── Stock Count
│   ├── Order Page
│   ├── Inventory
│   ├── Untensil PG1
│   ├── Utensil PG2
│   └── Stationary
└── Dev Settings
```

Remove all FeedMe login, portal, reports, collector, report sync, system closing, expected closing, FeedMe outlet lookup, and FeedMe permissions.

---

## 3. Dev Settings

The frontend shows only two independent backend groups:

```text
Cash Count GAS URL
Cash Count Secret

Stock Count GAS URL
Stock Count Secret
```

Storage keys:

```ts
cashCountGasUrl
cashCountGasSecret
stockCountGasUrl
stockCountGasSecret
```

Do not put these Stock backend configuration values in frontend Dev Settings:

- Drive folder ID
- template spreadsheet ID
- outlet name
- file prefix
- WhatsApp phone

Those belong in the Stock GAS Script Properties so outlet staff cannot change them.

---

## 4. Outlet behaviour

There is no Outlet selector in the Stock Count frontend.

One Stock GAS/template deployment represents one outlet. The GAS returns the outlet from:

1. `STOCK_OUTLET_NAME` Script Property, when configured; otherwise
2. the original-layout template spreadsheet file name.

Recommended template file names:

```text
RH Plaza - Stock Count Template
Skone Bintulu - Stock Count Template
```

The frontend displays the outlet returned by `getBootstrap` as read-only.

It must never accept or trust an outlet name typed by an operator.

---

## 5. Monthly Stock spreadsheet files

Stock Count uses one new spreadsheet per calendar month, stored inside the configured outlet folder.

File naming:

```text
Stock Count - <Outlet> - YYYY-MM
```

Example:

```text
Stock Count - RH Plaza - 2026-07
Stock Count - RH Plaza - 2026-08
```

When the frontend requests a date:

1. GAS derives `YYYY-MM` from the business date.
2. GAS searches the configured Drive folder for the exact monthly file name.
3. If found, GAS opens that file.
4. If missing, GAS copies the original-layout template into the folder.
5. GAS clears only date and quantity input cells in the new copy.
6. GAS keeps visible sheet layout, formulas, item rows, units, minimum quantities, formatting, and `Order Page` intact.
7. GAS updates the year in visible sheet titles.

The template is never used as the monthly data file.

---

## 6. Week mapping

The spreadsheet has five weekly count positions.

```text
Days 01–07 → Week 1
Days 08–14 → Week 2
Days 15–21 → Week 3
Days 22–28 → Week 4
Days 29–31 → Week 5
```

The GAS writes the selected business date into the corresponding date cell and writes quantities into the same week columns used by the Excel.

### Inventory

```text
Week 1: B–F
Week 2: G–K
Week 3: L–P
Week 4: Q–U
Week 5: V–Z
Minimum: AA
```

### Untensil PG1 / Utensil PG2

```text
Week 1: B–D
Week 2: E–G
Week 3: H–J
Week 4: K–M
Week 5: N–P
Minimum: Q
```

### Stationary

Monthly quantity remains in column B, unit in C, status in D, minimum in E.

---

## 7. Frontend Stock UI

The frontend is a responsive presentation of the spreadsheet, not a newly categorised inventory app.

### Required visual behaviour

- Tabs follow the exact visible sheet order.
- Keep original item row order.
- Do not regroup items into new categories.
- Do not rename `Untensil PG1` even though it is misspelled; it must match the spreadsheet.
- `Order Page` is read-only.
- Desktop/tablet displays the same five week groups horizontally.
- The first item column is sticky.
- Horizontal scrolling is allowed and expected.
- The current week is highlighted and editable.
- Other week columns are visible but read-only.
- Mobile may use a Week 1–5 selector to focus the same columns, but must preserve item order and cell meaning.
- Status and minimum are shown in the same row as the item.
- Inventory rows with carton/unit pairs show both quantity fields exactly like the sheet.

### Draft behaviour

- Save unsent field values locally by outlet + month + week.
- Do not clear the draft until GAS returns `saved: true`.
- Prevent double-click duplicate submission with one generated `submissionId`.

---

## 8. Submit and WhatsApp flow

This is a strict two-step flow.

### Before submit

```text
[Submit Stock Count]
[Send to WhatsApp — hidden or disabled]
```

### After successful GAS response

```text
Saved successfully
[Open Monthly Sheet]
[Send to WhatsApp]
```

Rules:

- Do not open WhatsApp automatically during Submit.
- Do not show an active WhatsApp button before the Sheet write succeeds.
- Use `whatsappShareUrl` returned by GAS.
- On click, open WhatsApp in a new tab/window.
- After opening, optionally call `markWhatsAppOpened`.
- Label the technical log as `WhatsApp Opened`, not `WhatsApp Sent`, because the app cannot confirm that the user actually pressed Send inside WhatsApp.

WhatsApp summary contains:

- Outlet
- business date
- Week 1–5
- counted by
- items requiring attention, grouped by visible sheet
- session note
- monthly spreadsheet link

When `WHATSAPP_PHONE` is blank, WhatsApp opens the share screen and the user chooses the staff group manually.

---

## 9. Stock GAS actions

```text
getBootstrap
submitStockCount
markWhatsAppOpened
getMonthStatus
```

### getBootstrap request

```json
{
  "action": "getBootstrap",
  "secret": "...",
  "businessDate": "2026-07-20"
}
```

The response includes outlet, monthly file, selected week, exact visible sheet order, original row order, all five week values, statuses, minimums, `Order Page`, and the monthly Sheet link.

### submitStockCount request shape

```json
{
  "action": "submitStockCount",
  "secret": "...",
  "submissionId": "stock-rh-plaza-20260720-uuid",
  "businessDate": "2026-07-20",
  "countedBy": "Milton",
  "sessionNote": "Weekly stock count",
  "sections": {
    "Inventory": [
      { "row": 4, "primary": 4 },
      { "row": 11, "primary": 2, "secondary": 16 }
    ],
    "Untensil PG1": [
      { "row": 4, "quantity": 4 }
    ],
    "Utensil PG2": [
      { "row": 4, "quantity": 74 }
    ],
    "Stationary": [
      { "row": 4, "quantity": 1 }
    ]
  }
}
```

The frontend uses row numbers returned by `getBootstrap`; do not hardcode item names as identifiers.

---

## 10. Cash Count

Cash remains separate from Stock.

- Cash continues to use the existing Cash spreadsheet/GAS route.
- Cash records Opening, unlimited Handover events, and Closing.
- Historical Cash records will be manually backfilled later.
- Stock monthly file creation must not affect Cash workbook naming or storage.
- Cash and Stock endpoints must never be merged into one setting.

---

## 11. Stock GAS Script Properties

Required:

```text
STOCK_MONTHLY_FOLDER_ID
STOCKCOUNT_SECRET
```

Recommended:

```text
STOCK_TEMPLATE_SPREADSHEET_ID
STOCK_OUTLET_NAME
STOCK_FILE_PREFIX
WHATSAPP_PHONE
```

`WHATSAPP_PHONE` is optional. For a WhatsApp group workflow, leave it blank so the operator chooses the group after clicking Send to WhatsApp.

---

## 12. Acceptance tests

1. Changing Stock GAS URL does not alter Cash GAS URL.
2. Stock screen shows outlet from GAS and has no outlet picker.
3. July request creates/opens only the July file.
4. August request automatically creates a separate August file in the same outlet folder.
5. New monthly file has the same five visible sheets in the same order and same layout as the original template.
6. Only quantity/date inputs are cleared in a new month; formulas and formatting remain.
7. A July 20 count writes to Week 3 columns.
8. Inventory carton + smaller-unit rows write both values to their original cells.
9. Submit failure keeps WhatsApp button disabled.
10. Submit success enables WhatsApp button and includes the monthly Sheet link.
11. Reusing the same submission ID does not write the stock twice.
12. Multiple outlet deployments never allow an operator to switch outlet from the frontend.
