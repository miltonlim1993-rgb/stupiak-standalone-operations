# Google Apps Script backends

- `cash-count-v2.6.0.gs` — multi-outlet Cash Count, actual-only, no WhatsApp workflow.
- `stock-count-v3.0.0.gs` — relation-first Stock Count. Fast submit writes `_StockRelation`; PDF/XLSX/WhatsApp package is prepared by a separate action.

Deploy each file as its own Apps Script Web App (`Execute as: Me`, `Who has access: Anyone`).
