# Frontend Stock UI Contract v2

## Settings

```ts
type DevSettings = {
  cashCountGasUrl: string;
  cashCountGasSecret: string;
  stockCountGasUrl: string;
  stockCountGasSecret: string;
};
```

No FeedMe fields. No outlet field. No Drive folder field.

## Initial load

```ts
POST stockCountGasUrl
{
  action: "getBootstrap",
  secret: stockCountGasSecret,
  businessDate: "YYYY-MM-DD"
}
```

Use response `outlet` as read-only header text.

## Visible tabs

Render exactly:

```ts
[
  "Order Page",
  "Inventory",
  "Untensil PG1",
  "Utensil PG2",
  "Stationary"
]
```

Do not alphabetize and do not correct the `Untensil` spelling.

## Table rendering

### Desktop/tablet

- Sticky Item column.
- Five week groups from left to right.
- Current week uses editable number inputs.
- Other weeks show saved values and remain read-only.
- Status and minimum follow each spreadsheet row.
- Use horizontal scroll rather than converting every item into a detached card.

### Mobile

- Keep original row order.
- A Week 1–5 segmented selector may focus one week at a time.
- Inventory dual-unit rows retain two adjacent inputs.
- Do not regroup by order status.

## Submit state machine

```text
idle
→ editing
→ submitting
→ saved
→ whatsapp-opened
```

WhatsApp button behaviour:

```ts
const canSendWhatsApp = submitResponse?.ok === true && submitResponse?.saved === true;
```

Never enable it from local form validity alone.

## WhatsApp click

```ts
window.open(submitResponse.whatsappShareUrl, "_blank", "noopener,noreferrer");
```

Then fire without blocking the WhatsApp window:

```ts
POST stockCountGasUrl
{
  action: "markWhatsAppOpened",
  secret: stockCountGasSecret,
  submissionId,
  businessDate
}
```

The UI label is **Send to WhatsApp**. The internal status is **WhatsApp opened**, not confirmed sent.

## Submit payload building

Use the spreadsheet row numbers returned by `getBootstrap`.

```ts
sections.Inventory = inventoryRows.map((row) => ({
  row: row.row,
  primary: row.currentWeek.primaryValue,
  ...(row.hasSecondaryQuantity
    ? { secondary: row.currentWeek.secondaryValue }
    : {})
}));
```

Do the same for the other visible sheets without changing their row order.
