# Google Apps Script backend contract

The production frontend now expects:

- Cash Count v2.6 or newer: actual-only save, no WhatsApp workflow.
- Stock Count v3.0 or newer: fast relation-first save to `_StockRelation`; PDF/XLSX and the WhatsApp message are prepared through a separate `prepareStockShare` action.

Deploy Cash and Stock as separate Apps Script Web Apps (`Execute as: Me`, `Who has access: Anyone`) and keep their Cloudflare variables separate.
