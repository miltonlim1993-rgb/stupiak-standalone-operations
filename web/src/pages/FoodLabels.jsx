import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { opsClient } from "@/api/opsClient";
import { useAuth } from "@/lib/AuthContext";
import { ROLE_LEVEL, todayStr } from "@/lib/ops-helpers";
import {
  AlertCircle,
  ArrowRightLeft,
  Camera,
  ChefHat,
  CalendarRange,
  CheckCircle2,
  Clock3,
  Flame,
  Loader2,
  PackageCheck,
  PackageSearch,
  Plus,
  Printer,
  Search,
  Settings2,
  Snowflake,
  Sparkles,
  Tag,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import MobileSheet from "@/components/MobileSheet";

const REPRINT_REASONS = [
  "Label damaged",
  "Printer jam",
  "Print unclear",
  "Label lost",
  "Wrong placement",
  "Other",
];

const STORAGE_LABELS = {
  freezer: "❄️ Freezer",
  frozen: "❄️ Frozen",
  refrigerated: "🧊 Refrigerated",
  chiller: "🧊 Chiller",
  defrost: "🧊 Defrost",
  room_temp: "🌡️ Room Temp",
  dry_storage: "📦 Dry Storage",
  heated: "🔥 Heated",
};

function actionPresentation(value) {
  const action = String(value || "Label").trim();
  const key = action.toLowerCase();
  if (/defrost|thaw|frozen/.test(key)) return { icon: Snowflake, classes: "border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200" };
  if (/cook|heat|grill|fry|bake/.test(key)) return { icon: Flame, classes: "border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200" };
  if (/portion|pack|seal|store/.test(key)) return { icon: PackageCheck, classes: "border-violet-200 bg-violet-100 text-violet-800 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200" };
  if (/transfer|refill|move/.test(key)) return { icon: ArrowRightLeft, classes: "border-cyan-200 bg-cyan-100 text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950 dark:text-cyan-200" };
  if (/prep|prepare|mix|marinate|slice|cut/.test(key)) return { icon: ChefHat, classes: "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" };
  return { icon: Sparkles, classes: "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200" };
}

function LabelActionBadge({ action }) {
  if (!action) return null;
  const meta = actionPresentation(action);
  const Icon = meta.icon;
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.classes}`}><Icon className="h-3 w-3" />{action}</span>;
}

const FALLBACK_PRINTER = {
  label_width_mm: 40,
  label_height_mm: 30,
  dpi: 203,
  default_copies: 1,
  connection_type: "system_print",
  configured: false,
};


function cachedPrinterProfile(outletId) {
  try {
    const raw = localStorage.getItem(`stupiaks_ops.label_printer_draft.${outletId || "default"}`);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.form && typeof parsed.form === "object" ? parsed.form : null;
  } catch {
    return null;
  }
}

function parseLabelMeta(notes) {
  if (!notes) return {};
  try {
    const parsed = JSON.parse(notes);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function asBoolean(value) {
  return value === true || String(value || "").toLowerCase() === "true";
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function storageKey(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("freezer")) return "freezer";
  if (raw.includes("frozen")) return "frozen";
  if (raw.includes("refriger")) return "refrigerated";
  if (raw.includes("chill")) return "chiller";
  if (raw.includes("defrost")) return "defrost";
  if (raw.includes("room")) return "room_temp";
  if (raw.includes("dry")) return "dry_storage";
  if (raw.includes("heat") || raw.includes("hot")) return "heated";
  return raw.replaceAll(/[^a-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "");
}

function storageLabel(value) {
  const key = storageKey(value);
  return STORAGE_LABELS[key] || String(value || "Not specified");
}

const LABEL_TIME_ZONE = "Asia/Kuala_Lumpur";

function dateOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseDateValue(value) {
  if (!value) return { date: null, hasTime: false };
  const raw = String(value).trim();
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const date = new Date(isDateOnly ? `${raw}T00:00:00+08:00` : raw);
  return {
    date: Number.isNaN(date.getTime()) ? null : date,
    hasTime: !isDateOnly,
  };
}

function formatDateTime(value, timeZone = LABEL_TIME_ZONE) {
  const parsed = parseDateValue(value);
  if (!parsed.date) return value ? String(value) : "—";
  return new Intl.DateTimeFormat("en-MY", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(parsed.hasTime ? {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    } : {}),
  }).format(parsed.date).replace(",", "");
}

function formatLabelDate(value, timeZone = LABEL_TIME_ZONE) {
  const parsed = parseDateValue(value);
  if (!parsed.date) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(parsed.date).replace(",", "").toUpperCase();
}

function formatLabelTime(value, timeZone = LABEL_TIME_ZONE) {
  const parsed = parseDateValue(value);
  if (!parsed.date || !parsed.hasTime) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed.date);
}

function toLocalDateTimeInput(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function durationLabel(value) {
  const minutes = Number(value || 0);
  if (!Number.isFinite(minutes) || minutes < 0) return "Not configured";
  if (minutes === 0) return "Not configured";
  if (minutes % 525600 === 0) {
    const years = minutes / 525600;
    return `${years} year${years === 1 ? "" : "s"}`;
  }
  if (minutes % 43200 === 0) {
    const months = minutes / 43200;
    return `${months} month${months === 1 ? "" : "s"}`;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function productOptionsFromCatalog(catalog) {
  const products = new Map();
  for (const product of catalog?.products || []) {
    products.set(String(product.productId), { ...product });
  }
  for (const rule of catalog?.rules || []) {
    const id = String(rule.productId || rule.productName || rule.ruleId);
    if (!products.has(id)) {
      products.set(id, {
        productId: id,
        productName: rule.productName || id,
        displayName: rule.productName || id,
        defaultLabelTitle: rule.outputProductName || rule.productName || id,
        note: "",
      });
    }
  }
  const rulesByProduct = new Map();
  for (const rule of catalog?.rules || []) {
    const id = String(rule.productId || rule.productName || rule.ruleId);
    if (!rulesByProduct.has(id)) rulesByProduct.set(id, []);
    rulesByProduct.get(id).push(rule);
  }
  return [...products.values()]
    .filter((product) => (rulesByProduct.get(String(product.productId)) || []).length > 0)
    .sort((a, b) => String(a.displayName || a.productName).localeCompare(String(b.displayName || b.productName)));
}

function labelTitleFor(rule, product) {
  return String(
    product?.displayName
    || product?.productName
    || (rule?.requiresSource ? rule?.outputProductName : "")
    || rule?.productName
    || product?.defaultLabelTitle
    || rule?.outputProductName
    || "Food Label",
  );
}

function displayLabelName(label) {
  const meta = parseLabelMeta(label?.notes);
  return String(meta.product_name || label?.item_name || "Food Label");
}

function batchCodeFor(label) {
  const meta = parseLabelMeta(label?.notes);
  return String(meta.batch_code || label?.serial_batch || "");
}

function LabelDrawer({
  open,
  onOpenChange,
  title,
  subtitle = "",
  children,
}) {
  return (
    <MobileSheet
      open={open}
      onClose={() => onOpenChange?.(false)}
      title={title}
      description={subtitle}
      compact={false}
    >
      <div className="labels-drawer-body min-h-0">
        {children}
      </div>
    </MobileSheet>
  );
}

function normalizedExpiryMode(value) {
  return String(value || "none").trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");
}

function sourceExpiry(label) {
  if (!label) return null;
  const meta = parseLabelMeta(label.notes);
  const date = new Date(meta.expires_at || label.expiry_date || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

function calculatedExpiryFor(rule, preparedAt, manualExpiry) {
  if (!rule) return null;
  if (rule.manualExpiryRequired) {
    const date = new Date(manualExpiry || "");
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const durationMinutes = Number(rule.durationMinutes || 0);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
  return new Date(preparedAt.getTime() + durationMinutes * 60000);
}

function effectiveExpiryFor(rule, calculatedExpiry, sourceLabel) {
  if (!calculatedExpiry) return null;
  const expiry = sourceExpiry(sourceLabel);
  if (!expiry) return calculatedExpiry;
  const mode = normalizedExpiryMode(rule?.sourceExpiryMode);
  if (["source", "inherit", "same_as_source"].includes(mode)) return expiry;
  if (["min", "minimum", "earliest", "cap", "cap_at_source", "source_cap"].includes(mode)) {
    return expiry.getTime() < calculatedExpiry.getTime() ? expiry : calculatedExpiry;
  }
  return calculatedExpiry;
}

function previewSourceCode(label) {
  return batchCodeFor(label);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isTruthyRecord(value) {
  return asBoolean(value);
}

const EAN13_L = {
  0: "0001101",
  1: "0011001",
  2: "0010011",
  3: "0111101",
  4: "0100011",
  5: "0110001",
  6: "0101111",
  7: "0111011",
  8: "0110111",
  9: "0001011",
};

const EAN13_G = {
  0: "0100111",
  1: "0110011",
  2: "0011011",
  3: "0100001",
  4: "0011101",
  5: "0111001",
  6: "0000101",
  7: "0010001",
  8: "0001001",
  9: "0010111",
};

const EAN13_R = {
  0: "1110010",
  1: "1100110",
  2: "1101100",
  3: "1000010",
  4: "1011100",
  5: "1001110",
  6: "1010000",
  7: "1000100",
  8: "1001000",
  9: "1110100",
};

const EAN13_PARITY = {
  0: "LLLLLL",
  1: "LLGLGG",
  2: "LLGGLG",
  3: "LLGGGL",
  4: "LGLLGG",
  5: "LGGLLG",
  6: "LGGGLL",
  7: "LGLGLG",
  8: "LGLGGL",
  9: "LGGLGL",
};

function ean13Bits(value) {
  const digits = String(value || "").replaceAll(/\D/g, "");
  if (!/^\d{13}$/.test(digits)) return "";
  const parity = EAN13_PARITY[digits[0]];
  let bits = "101";
  for (let index = 1; index <= 6; index += 1) {
    const digit = digits[index];
    bits += parity[index - 1] === "G" ? EAN13_G[digit] : EAN13_L[digit];
  }
  bits += "01010";
  for (let index = 7; index <= 12; index += 1) bits += EAN13_R[digits[index]];
  return `${bits}101`;
}

function renderEan13Svg(value) {
  const bits = ean13Bits(value);
  if (!bits) return "";
  const rects = [];
  let start = -1;
  for (let index = 0; index <= bits.length; index += 1) {
    if (bits[index] === "1" && start < 0) start = index;
    if ((bits[index] !== "1" || index === bits.length) && start >= 0) {
      const guard = start < 3
        || (start >= 45 && start < 50)
        || start >= 92;
      rects.push(`<rect x="${start + 11}" y="0" width="${index - start}" height="${guard ? 34 : 29}" />`);
      start = -1;
    }
  }
  return `<svg viewBox="0 0 117 34" preserveAspectRatio="none" role="img" aria-label="EAN-13 ${escapeHtml(value)}"><g fill="#000">${rects.join("")}</g></svg>`;
}

function extractLookupCode(text) {
  const raw = String(text || "").toUpperCase();
  const digitsOnly = raw.replaceAll(/\D/g, "");
  const barcodeMatch = digitsOnly.match(/\d{13}/);
  if (barcodeMatch) return barcodeMatch[0];

  const batchMatch = raw.match(/\b([A-Z0-9]{2,8})[\s-]*(\d{6})[\s-]*(\d{3,4})\b/);
  if (batchMatch) return `${batchMatch[1]}-${batchMatch[2]}-${batchMatch[3]}`;

  // Backward compatibility for labels created before readable batch codes.
  const legacyCompact = raw.replaceAll(/[^A-Z0-9]/g, "");
  const legacySerial = legacyCompact.match(/B[0-9O]{16}/);
  if (legacySerial) return legacySerial[0].replaceAll("O", "0");

  return "";
}

async function detectLookupCodeFromImage(file) {
  if (!file) return "";
  const imageSource = typeof createImageBitmap === "function" ? await createImageBitmap(file) : file;
  try {
    if ("BarcodeDetector" in globalThis) {
      try {
        const preferred = ["ean_13", "code_128", "code_39", "qr_code"];
        const supported = typeof globalThis.BarcodeDetector.getSupportedFormats === "function"
          ? await globalThis.BarcodeDetector.getSupportedFormats()
          : preferred;
        const formats = preferred.filter((format) => supported.includes(format));
        const detector = formats.length
          ? new globalThis.BarcodeDetector({ formats })
          : new globalThis.BarcodeDetector();
        const results = await detector.detect(imageSource);
        const detected = results.map((result) => extractLookupCode(result.rawValue)).find(Boolean);
        if (detected) return detected;
      } catch (error) {
        console.debug("Barcode camera scan unavailable", error);
      }
    }

    if ("TextDetector" in globalThis) {
      try {
        const results = await new globalThis.TextDetector().detect(imageSource);
        const detectedText = results
          .map((result) => result.rawValue || result.data || result.text || "")
          .join(" ");
        const detected = extractLookupCode(detectedText);
        if (detected) return detected;
      } catch (error) {
        console.debug("OCR camera scan unavailable", error);
      }
    }

    return "";
  } finally {
    imageSource.close?.();
  }
}

export default function FoodLabels() {
  const { user } = useAuth();
  const canManageLabels = (ROLE_LEVEL[user?.role] || 0) >= ROLE_LEVEL.manager;
  const [labels, setLabels] = useState([]);
  const [printerProfile, setPrinterProfile] = useState(FALLBACK_PRINTER);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [traceLabel, setTraceLabel] = useState(null);
  const [labelSearch, setLabelSearch] = useState("");
  const [searchingLabels, setSearchingLabels] = useState(false);
  const [scanningLabelPhoto, setScanningLabelPhoto] = useState(false);
  const [labelScanError, setLabelScanError] = useState("");
  const [dateFilterOpen, setDateFilterOpen] = useState(false);
  const [fromDate, setFromDate] = useState(() => dateOffset(-7));
  const [toDate, setToDate] = useState(() => todayStr());
  const [appliedRange, setAppliedRange] = useState(() => ({ from: dateOffset(-7), to: todayStr() }));
  const [reprintLabel, setReprintLabel] = useState(null);
  const [reprintQuantity, setReprintQuantity] = useState("1");
  const [reprintReason, setReprintReason] = useState("");
  const [reprintNote, setReprintNote] = useState("");
  const [reprintSaving, setReprintSaving] = useState(false);
  const [reprintError, setReprintError] = useState("");
  const labelCameraInputRef = useRef(null);

  useEffect(() => {
    loadLabels();
    const outletId = user?.outlet_id || "";
    const cached = cachedPrinterProfile(outletId);
    opsClient.labels.printerProfile({ outletId })
      .then((profile) => setPrinterProfile({ ...FALLBACK_PRINTER, ...(profile || {}), ...(cached || {}) }))
      .catch(() => setPrinterProfile({ ...FALLBACK_PRINTER, ...(cached || {}) }));
  }, [user?.outlet_id]);

  const loadLabels = async (range = appliedRange) => {
    setLoading(true);
    try {
      const filter = range?.from && range?.to
        ? { prep_date: { $gte: range.from, $lte: range.to } }
        : {};
      const list = await opsClient.entities.FoodLabel.filter(filter, "-created_date", 500);
      setLabels(list || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const deleteLabel = async (id) => {
    try {
      await opsClient.entities.FoodLabel.delete(id);
      setLabels((prev) => prev.filter((label) => label.id !== id));
    } catch (err) {
      console.error(err);
    }
  };

  const finishSourceBatch = async (label) => {
    if (!label?.id) return;
    try {
      const updated = await opsClient.labels.finishSource(label.id);
      setLabels((prev) => prev.map((row) => row.id === label.id ? updated : row));
      setTraceLabel(updated);
    } catch (err) {
      console.error(err);
    }
  };

  const visibleLabels = useMemo(() => {
    const query = labelSearch.trim().toLowerCase();
    if (!query) return labels;
    return labels.filter((label) => {
      const meta = parseLabelMeta(label.notes);
      return [label.item_name, label.barcode, label.serial_batch, label.id, meta.action, meta.source_short_code, meta.source_serial_batch, meta.source_product_name]
        .some((value) => String(value || "").toLowerCase().includes(query));
    });
  }, [labels, labelSearch]);

  const findLabelFromSearch = async (lookupValue = "") => {
    const rawQuery = String(lookupValue || labelSearch).trim();
    const query = rawQuery.toLowerCase();
    if (!query || searchingLabels) return;
    const exact = labels.find((label) => {
      const meta = parseLabelMeta(label.notes);
      return [label.id, label.barcode, label.serial_batch, meta.source_short_code]
        .some((value) => String(value || "").toLowerCase() === query);
    });
    if (exact) {
      setTraceLabel(exact);
      return;
    }
    setSearchingLabels(true);
    try {
      const [byBarcode, byBatch, byId] = await Promise.all([
        opsClient.entities.FoodLabel.filter({ barcode: rawQuery }, "-created_date", 5),
        opsClient.entities.FoodLabel.filter({ serial_batch: rawQuery }, "-created_date", 5),
        opsClient.entities.FoodLabel.filter({ id: rawQuery }, "-created_date", 5),
      ]);
      const found = [...(byBarcode || []), ...(byBatch || []), ...(byId || [])][0];
      if (found) {
        setLabels((current) => current.some((row) => row.id === found.id) ? current : [found, ...current]);
        setTraceLabel(found);
      }
    } catch (lookupError) {
      console.error(lookupError);
    } finally {
      setSearchingLabels(false);
    }
  };

  const scanExistingLabelPhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || scanningLabelPhoto) return;
    setScanningLabelPhoto(true);
    setLabelScanError("");
    try {
      const code = await detectLookupCodeFromImage(file);
      if (!code) {
        setLabelScanError("No barcode or batch code was detected. Move closer, keep the label flat and try again.");
        return;
      }
      setLabelSearch(code);
      await findLabelFromSearch(code);
    } catch (error) {
      setLabelScanError(error.message || "The camera image could not be read.");
    } finally {
      setScanningLabelPhoto(false);
    }
  };

  const printLabel = (label, printWindow = null, options = {}) => {
    const meta = parseLabelMeta(label.notes);
    const displayName = displayLabelName(label);
    const titleClass = displayName.length > 24 ? "title title-long" : "title";
    const width = Math.max(20, asNumber(printerProfile.label_width_mm, 40));
    const height = Math.max(15, asNumber(printerProfile.label_height_mm, 30));
    const copies = Math.max(1, Math.min(100, Math.round(asNumber(
      options.copies
      || label.initial_print_quantity
      || meta.initial_print_quantity
      || printerProfile.default_copies,
      1,
    ))));
    const printMode = String(options.mode || "print").toLowerCase();
    const operatorName = String(
      options.operatorName
      || (printMode === "reprint" ? label.last_reprinted_by_name || meta.last_reprinted_by_name : label.printed_by_name || meta.printed_by_name)
      || user?.full_name
      || "",
    ).trim();
    const storage = String(
      meta.storage_condition_display
      || label.storage_condition
      || storageLabel(label.storage_condition),
    ).replace(/^[^A-Za-z0-9]+/, "");
    const preparedAt = meta.prepared_at || label.created_date || label.prep_date;
    const expiresAt = meta.expires_at || meta.calculated_expires_at || label.expiry_date;
    const timeZone = meta.time_zone || LABEL_TIME_ZONE;
    const showQuantity = isTruthyRecord(meta.show_quantity_on_label);
    const quantityText = showQuantity
      ? `${label.quantity || 1}${meta.quantity_unit ? ` ${meta.quantity_unit}` : ""}`
      : "";
    const batchCode = batchCodeFor(label);
    const barcodeSvg = renderEan13Svg(label.barcode);
    const win = printWindow && !printWindow.closed
      ? printWindow
      : window.open("", "_blank", "width=480,height=640");

    if (!win) return false;

    const labelMarkup = `
        <div class="label">
          <div class="top">
            <div class="${titleClass}">${escapeHtml(displayName)}</div>
            <div class="context">
              <span>${escapeHtml(meta.action || "LABEL")}</span>
              <span>•</span>
              <span class="storage">${escapeHtml(storage)}</span>
            </div>
          </div>

          <div class="times">
            <div class="time-box">
              <div class="time-head">
                <span>Made</span>
                ${formatLabelTime(preparedAt, timeZone) ? `<strong>${escapeHtml(formatLabelTime(preparedAt, timeZone))}</strong>` : ""}
              </div>
              <div class="time-date">${escapeHtml(formatLabelDate(preparedAt, timeZone))}</div>
            </div>
            <div class="time-box">
              <div class="time-head">
                <span>Use By</span>
                ${formatLabelTime(expiresAt, timeZone) ? `<strong>${escapeHtml(formatLabelTime(expiresAt, timeZone))}</strong>` : ""}
              </div>
              <div class="time-date">${escapeHtml(formatLabelDate(expiresAt, timeZone))}</div>
            </div>
          </div>

          ${quantityText ? `<div class="quantity">${escapeHtml(meta.quantity_label || "Qty")}: ${escapeHtml(quantityText)}</div>` : ""}
          <div class="operator">${printMode === "reprint" ? "REPRINT · " : ""}BY: ${escapeHtml(operatorName || "—")}</div>

          <div class="barcode-wrap">
            <div class="batch">BATCH ${escapeHtml(batchCode || "—")}</div>
            ${barcodeSvg ? `<div class="ean13">${barcodeSvg}</div>` : ""}
            <div class="barcode">${escapeHtml(label.barcode || "")}</div>
          </div>
        </div>`;

    win.document.open();
    win.document.write(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>Food Label - ${escapeHtml(displayName)}</title>
        <style>
          @page { size: ${width}mm ${height}mm; margin: 0; }
          * { box-sizing: border-box; }
          html, body { margin: 0; }
          body {
            width: ${width}mm;
            font-family: Arial, Helvetica, sans-serif;
            color: #000;
            background: #fff;
          }
          .label {
            width: ${width}mm;
            height: ${height}mm;
            padding: 1.2mm 1.7mm .75mm;
            display: flex;
            flex-direction: column;
            break-after: page;
            page-break-after: always;
            overflow: hidden;
          }
          .label:last-child { break-after: auto; page-break-after: auto; }
          .top {
            border-bottom: .3mm solid #000;
            padding-bottom: .45mm;
          }
          .title {
            width: 100%;
            max-height: 6.5mm;
            overflow: hidden;
            overflow-wrap: anywhere;
            font-size: 8.7pt;
            font-weight: 900;
            line-height: .98;
            white-space: normal;
          }
          .title-long {
            font-size: 7.1pt;
            line-height: 1;
          }
          .context {
            display: flex;
            align-items: center;
            gap: .7mm;
            min-width: 0;
            padding-top: .45mm;
            overflow: hidden;
            font-size: 5.5pt;
            font-weight: 850;
            line-height: 1;
            text-transform: uppercase;
            white-space: nowrap;
          }
          .context .storage {
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .times {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            gap: .65mm;
            margin-top: .65mm;
          }
          .time-box {
            min-width: 0;
            border: .23mm solid #000;
            padding: .45mm .55mm .5mm;
          }
          .time-head {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: .35mm;
            font-size: 4.7pt;
            font-weight: 800;
            line-height: 1;
            text-transform: uppercase;
            white-space: nowrap;
          }
          .time-head strong {
            font-size: 5.5pt;
            font-weight: 900;
          }
          .time-date {
            margin-top: .3mm;
            overflow: hidden;
            font-size: 5.55pt;
            font-weight: 900;
            line-height: 1;
            text-overflow: clip;
            white-space: nowrap;
          }
          .quantity {
            margin-top: .35mm;
            text-align: right;
            font-size: 5pt;
            font-weight: 700;
            line-height: 1;
          }
          .operator {
            margin-top: .35mm;
            overflow: hidden;
            font-size: 4.8pt;
            font-weight: 850;
            line-height: 1;
            text-overflow: ellipsis;
            text-transform: uppercase;
            white-space: nowrap;
          }
          .barcode-wrap {
            margin-top: auto;
            text-align: center;
          }
          .batch {
            margin-bottom: .25mm;
            overflow: hidden;
            font: 800 4.9pt "Courier New", monospace;
            line-height: 1;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .ean13 {
            width: 100%;
            height: 4.4mm;
            overflow: hidden;
          }
          .ean13 svg {
            display: block;
            width: 100%;
            height: 100%;
          }
          .barcode {
            margin-top: .08mm;
            font: 700 4.65pt "Courier New", monospace;
            letter-spacing: .12mm;
            line-height: 1;
          }
        </style>
      </head>
      <body>
        ${Array.from({ length: copies }, () => labelMarkup).join("")}
        <script>
          window.onload = () => window.setTimeout(() => window.print(), 60);
        </script>
      </body>
      </html>
    `);
    win.document.close();
    return true;
  };

  const openReprint = (label) => {
    setTraceLabel(null);
    setReprintLabel(label);
    setReprintQuantity("1");
    setReprintReason("");
    setReprintNote("");
    setReprintError("");
  };

  const submitReprint = async (event) => {
    event.preventDefault();
    if (!reprintLabel?.id || reprintSaving) return;
    const quantity = Number(reprintQuantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      setReprintError("Reprint quantity must be a whole number from 1 to 100.");
      return;
    }
    if (!reprintReason) {
      setReprintError("Select why this label needs to be reprinted.");
      return;
    }
    if (reprintReason === "Other" && !reprintNote.trim()) {
      setReprintError("Enter a note when the reason is Other.");
      return;
    }

    const printWindow = window.open("", "_blank", "width=480,height=640");
    if (printWindow) {
      printWindow.document.write("<!doctype html><title>Preparing reprint…</title><body style=\"font-family:Arial,sans-serif;padding:24px\">Preparing reprint…</body>");
      printWindow.document.close();
    }

    setReprintSaving(true);
    setReprintError("");
    try {
      const result = await opsClient.labels.reprint(reprintLabel.id, {
        reprint_quantity: quantity,
        reprint_reason: reprintReason,
        reprint_note: reprintNote.trim(),
        printer_name: printerProfile.profile_name || "Browser Print",
      });
      const updated = result.label;
      setLabels((current) => current.map((row) => row.id === updated.id ? updated : row));
      printLabel(updated, printWindow, {
        copies: result.print?.quantity || quantity,
        mode: "reprint",
        operatorName: result.print?.printed_by_name || updated.last_reprinted_by_name,
      });
      setReprintLabel(null);
    } catch (err) {
      printWindow?.close();
      setReprintError(err.message || "Label could not be reprinted.");
    } finally {
      setReprintSaving(false);
    }
  };

  return (
    <div className="chefops-page labels-page p-4 space-y-4 max-w-lg mx-auto">
      <div className="chefops-sticky-tools chefops-labels-toolbar space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
          <h1 className="text-xl font-heading font-bold">Food Labels</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Create, print and review food labels by date.</p>
        </div>
        <div className="flex items-center gap-2">
          {canManageLabels && (
            <Button asChild size="sm" variant="outline" className="h-9 w-9 p-0" aria-label="Label settings">
              <Link to="/labels/settings"><Settings2 className="h-4 w-4" /></Link>
            </Button>
          )}
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Create
          </Button>
          </div>
        </div>

        <div className="space-y-1.5">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={labelSearch}
              onChange={(event) => setLabelSearch(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void findLabelFromSearch(); } }}
              className="pl-9"
              placeholder="Barcode or batch code"
            />
          </div>
          <input
            ref={labelCameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(event) => void scanExistingLabelPhoto(event)}
          />
          <Button
            type="button"
            variant="outline"
            className="h-10 w-10 p-0"
            aria-label="Scan label with camera"
            onClick={() => labelCameraInputRef.current?.click()}
            disabled={scanningLabelPhoto}
          >
            {scanningLabelPhoto ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 px-3"
            onClick={() => setDateFilterOpen((value) => !value)}
            aria-expanded={dateFilterOpen}
          >
            <CalendarRange className="mr-1.5 h-4 w-4" /> Dates
          </Button>
        </div>
        {labelScanError && <p className="text-xs text-destructive">{labelScanError}</p>}
        {dateFilterOpen && (
          <div className="rounded-2xl border border-border bg-card p-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>From</Label><Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></div>
              <div className="space-y-1.5"><Label>To</Label><Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" onClick={() => { const today = todayStr(); setFromDate(today); setToDate(today); }}>Today</Button>
              <Button type="button" onClick={() => { const next = { from: fromDate, to: toDate }; setAppliedRange(next); setDateFilterOpen(false); void loadLabels(next); }}>Apply dates</Button>
            </div>
          </div>
        )}
          <p className="text-[11px] text-muted-foreground">Showing {appliedRange.from} to {appliedRange.to}</p>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : visibleLabels.length === 0 ? (
        <div className="text-center py-12">
          <Tag className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No labels created yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {visibleLabels.map((label) => {
            const meta = parseLabelMeta(label.notes);
            return (
              <div key={label.id} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <p className="text-sm font-medium truncate">{displayLabelName(label)}</p>
                      <LabelActionBadge action={meta.action} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Use by: {formatDateTime(meta.expires_at || meta.calculated_expires_at || label.expiry_date)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{meta.storage_condition_display || storageLabel(label.storage_condition)} · Batch: {batchCodeFor(label)}</p>
                    {meta.source_label_id && <p className="text-xs font-medium mt-1">Source batch: {meta.source_serial_batch || meta.source_short_code || "Linked"}</p>}
                    {meta.source_usage_mode && <p className={`mt-1 text-[11px] font-medium ${String(meta.source_status || "active") === "depleted" ? "text-red-600" : "text-emerald-600"}`}>{String(meta.source_status || "active") === "depleted" ? "Source batch used up" : meta.source_remaining_qty != null ? `${meta.source_remaining_qty} ${meta.source_unit || "unit"} remaining` : "Source batch active"}</p>}
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" className="h-8 px-2 text-[11px]" onClick={() => setTraceLabel(label)}>View</Button>
                    <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={() => openReprint(label)} aria-label="Reprint label"><Printer className="h-4 w-4" /></Button>
                    <button onClick={() => deleteLabel(label.id)} className="text-muted-foreground hover:text-destructive p-1" aria-label="Delete label"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <LabelDrawer
        open={Boolean(traceLabel)}
        onOpenChange={(open) => { if (!open) setTraceLabel(null); }}
        title="Label details"
        subtitle="Batch, expiry and source history"
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {traceLabel && <TraceDetails label={traceLabel} onPrint={() => openReprint(traceLabel)} onFinish={() => finishSourceBatch(traceLabel)} />}
        </div>
      </LabelDrawer>

      <LabelDrawer
        open={Boolean(reprintLabel)}
        onOpenChange={(open) => { if (!open && !reprintSaving) setReprintLabel(null); }}
        title="Reprint labels"
        subtitle="Choose quantity and record why the reprint is needed"
      >
        {reprintLabel && (
          <form onSubmit={submitReprint} className="space-y-4 px-4 py-4">
            <div className="rounded-xl border bg-muted/35 p-3 space-y-2">
              <ReviewRow label="Product" value={displayLabelName(reprintLabel)} strong />
              <ReviewRow label="Batch" value={batchCodeFor(reprintLabel)} />
              <ReviewRow label="Original print" value={`${Number(reprintLabel.initial_print_quantity || parseLabelMeta(reprintLabel.notes).initial_print_quantity || 1)} label(s)`} />
              <ReviewRow label="Reprinted so far" value={`${Number(reprintLabel.total_reprint_quantity || parseLabelMeta(reprintLabel.notes).total_reprint_quantity || 0)} label(s)`} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reprint-quantity">Reprint quantity</Label>
              <div className="grid grid-cols-[44px_1fr_44px] gap-2">
                <Button type="button" variant="outline" className="h-10 p-0" onClick={() => setReprintQuantity(String(Math.max(1, Number(reprintQuantity || 1) - 1)))} aria-label="Decrease reprint quantity">−</Button>
                <Input id="reprint-quantity" type="number" inputMode="numeric" min="1" max="100" step="1" className="text-center" value={reprintQuantity} onChange={(event) => setReprintQuantity(event.target.value)} />
                <Button type="button" variant="outline" className="h-10 p-0" onClick={() => setReprintQuantity(String(Math.min(100, Number(reprintQuantity || 0) + 1)))} aria-label="Increase reprint quantity">+</Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reprint-reason">Reason</Label>
              <select id="reprint-reason" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={reprintReason} onChange={(event) => setReprintReason(event.target.value)}>
                <option value="">Select reason</option>
                {REPRINT_REASONS.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reprint-note">Additional note {reprintReason === "Other" ? "*" : ""}</Label>
              <Textarea id="reprint-note" value={reprintNote} onChange={(event) => setReprintNote(event.target.value)} maxLength={500} placeholder="Optional unless reason is Other" />
            </div>

            <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              Reprinted by <strong className="text-foreground">{user?.full_name || "—"}</strong>. Reprints do not deduct the source batch again.
            </div>
            {reprintError && <p className="text-sm text-destructive">{reprintError}</p>}
            <Button type="submit" className="h-12 w-full" disabled={reprintSaving}>
              {reprintSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Printer className="mr-2 h-4 w-4" />}
              Reprint {Number(reprintQuantity || 0) || 1} Label{Number(reprintQuantity || 0) === 1 ? "" : "s"}
            </Button>
          </form>
        )}
      </LabelDrawer>

      <LabelDrawer
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="Create Label"
        subtitle="Product → action → source batch → review and print"
      >
        {dialogOpen && (
          <LabelForm
            onDone={() => { setDialogOpen(false); loadLabels(); }}
            onPrint={printLabel}
            printerProfile={printerProfile}
          />
        )}
      </LabelDrawer>
    </div>
  );
}

function TraceDetails({ label, onPrint, onFinish }) {
  const meta = parseLabelMeta(label.notes);
  const traceable = Boolean(meta.source_label_id);
  return (
    <div className="space-y-3">
      <div className="rounded-xl border bg-muted/35 p-3 space-y-3">
        <ReviewRow label="Product" value={displayLabelName(label)} strong />
        <ReviewRow label="Process" value={`${meta.action || "—"}${meta.storage_condition_display ? ` · ${meta.storage_condition_display}` : ""}`} />
        <div className="grid grid-cols-2 gap-2">
          <DateTimeCard label="Made" value={meta.prepared_at || label.created_date || label.prep_date} />
          <DateTimeCard label="Use By" value={meta.expires_at || meta.calculated_expires_at || label.expiry_date} strong />
        </div>
        <ReviewRow label="Batch" value={batchCodeFor(label)} />
        <ReviewRow label="Barcode" value={label.barcode} />
        <ReviewRow label="Printed by" value={label.printed_by_name || meta.printed_by_name || "—"} />
        <ReviewRow label="Initial print" value={`${Number(label.initial_print_quantity || meta.initial_print_quantity || 1)} label(s)`} />
        <ReviewRow label="Total reprinted" value={`${Number(label.total_reprint_quantity || meta.total_reprint_quantity || 0)} label(s)`} />
        {Number(label.reprint_count || meta.reprint_count || 0) > 0 && <ReviewRow label="Last reprint" value={`${label.last_reprint_reason || meta.last_reprint_reason || "—"} · ${label.last_reprinted_by_name || meta.last_reprinted_by_name || "—"}`} />}
      </div>
      {traceable ? (
        <div className="rounded-xl border border-foreground p-3 space-y-2">
          <p className="text-sm font-semibold">Source batch</p>
          <ReviewRow label="Product" value={meta.source_product_name} />
          <ReviewRow label="Process" value={meta.source_action} />
          <ReviewRow label="Prepared" value={formatDateTime(meta.source_prepared_at)} />
          <ReviewRow label="Source use by" value={formatDateTime(meta.source_expires_at)} />
          <ReviewRow label="Source batch" value={meta.source_serial_batch || meta.source_short_code} strong />
          <ReviewRow label="Created by" value={meta.source_created_by} />
          {meta.expiry_limited_by_source && <p className="rounded-md bg-amber-100 px-2 py-1.5 text-xs font-medium text-amber-900">Finished use-by was limited by the source expiry.</p>}
        </div>
      ) : <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">This is a standard label with no linked source batch.</p>}
      {(meta.source_usage_mode || !meta.source_label_id) ? (
        <div className="rounded-xl border p-3">
          <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold">Source batch availability</p><p className="mt-0.5 text-xs text-muted-foreground">{meta.source_remaining_qty != null ? `${meta.source_remaining_qty} ${meta.source_unit || "unit"} remaining` : "Manual batch tracking"}</p></div><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${String(meta.source_status || "active") === "depleted" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>{String(meta.source_status || "active")}</span></div>
          {String(meta.source_status || "active") !== "depleted" ? <Button type="button" variant="outline" className="mt-3 w-full" onClick={onFinish}>Finish source batch</Button> : null}
        </div>
      ) : null}
      <Button className="w-full" onClick={onPrint}><Printer className="h-4 w-4 mr-2" /> Print Again</Button>
    </div>
  );
}

function LabelForm({ onDone, onPrint, printerProfile }) {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [recentLabels, setRecentLabels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [selectedProductId, setSelectedProductId] = useState("");
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [printQuantity, setPrintQuantity] = useState("1");
  const [manualExpiry, setManualExpiry] = useState("");
  const [sourceLabelId, setSourceLabelId] = useState("");
  const [sourceSearch, setSourceSearch] = useState("");
  const [searchingSource, setSearchingSource] = useState(false);
  const [scanningSourcePhoto, setScanningSourcePhoto] = useState(false);
  const sourceCameraInputRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [preparedAt, setPreparedAt] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setPreparedAt(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      opsClient.labels.catalog(),
      opsClient.entities.FoodLabel.list("-created_date", 250),
    ])
      .then(([catalogData, labels]) => {
        if (!active) return;
        setCatalog(catalogData);
        setRecentLabels(labels || []);
      })
      .catch((err) => {
        if (!active) return;
        setLoadError(err.message || "Unable to load label rules");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const productOptions = useMemo(() => productOptionsFromCatalog(catalog), [catalog]);
  const filteredProducts = useMemo(() => {
    const search = productSearch.trim().toLowerCase();
    if (!search) return productOptions;
    return productOptions.filter((product) => String(product.displayName || product.productName).toLowerCase().includes(search));
  }, [productOptions, productSearch]);

  const selectedProduct = useMemo(
    () => productOptions.find((product) => String(product.productId) === String(selectedProductId)) || null,
    [productOptions, selectedProductId],
  );

  const productRules = useMemo(
    () => (catalog?.rules || []).filter((rule) => String(rule.productId || rule.productName || rule.ruleId) === String(selectedProductId)),
    [catalog, selectedProductId],
  );

  const selectedRule = useMemo(
    () => productRules.find((rule) => String(rule.ruleKey || rule.ruleId) === String(selectedRuleId)) || null,
    [productRules, selectedRuleId],
  );

  useEffect(() => {
    setSelectedRuleId(productRules.length === 1 ? String(productRules[0].ruleKey || productRules[0].ruleId) : "");
    setQuantity("1");
    setPrintQuantity("1");
    setSourceLabelId("");
    setSourceSearch("");
    setManualExpiry("");
  }, [selectedProductId, productRules.length]);

  useEffect(() => {
    if (!selectedRule?.manualExpiryRequired) {
      setManualExpiry("");
      return;
    }
    const now = new Date();
    const suggested = new Date(now.getTime() + Math.max(60, Number(selectedRule.durationMinutes || 0)) * 60000);
    setManualExpiry(toLocalDateTimeInput(suggested));
  }, [selectedRule?.ruleKey, selectedRule?.manualExpiryRequired, selectedRule?.durationMinutes]);

  const isEligibleSource = (label) => {
    if (!selectedRule?.requiresSource || !label) return false;
    const meta = parseLabelMeta(label.notes);
    const allowedActions = String(selectedRule.allowedSourceActions || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (label.deleted_at) return false;
    const status = String(meta.source_status || meta.batch_status || "active").toLowerCase();
    const remaining = Number(meta.source_remaining_qty);
    if (["depleted", "expired", "void"].includes(status)) return false;
    if (meta.source_usage_mode === "tracked" && Number.isFinite(remaining) && remaining <= 0) return false;
    if (user?.outlet_id && label.outlet_id && String(label.outlet_id) !== String(user.outlet_id)) return false;
    if (selectedRule.sourceProductId && String(meta.product_id || "") !== String(selectedRule.sourceProductId)) return false;
    if (!selectedRule.sourceProductId && selectedRule.sourceProductName && !String(label.item_name || "").toLowerCase().includes(String(selectedRule.sourceProductName).toLowerCase())) return false;
    if (allowedActions.length && !allowedActions.includes(String(meta.action || "").toLowerCase())) return false;
    const expiry = sourceExpiry(label);
    const mode = normalizedExpiryMode(selectedRule.sourceExpiryMode);
    const expiryRequired = ["min", "minimum", "earliest", "cap", "cap_at_source", "source_cap", "source", "inherit", "same_as_source"].includes(mode);
    if (expiryRequired && !expiry) return false;
    if (expiry && expiry.getTime() <= Date.now()) return false;
    return true;
  };

  const sourceOptions = useMemo(
    () => selectedRule?.requiresSource ? recentLabels.filter(isEligibleSource) : [],
    [recentLabels, selectedRule, user?.outlet_id],
  );

  const filteredSourceOptions = useMemo(() => {
    const search = sourceSearch.trim().toLowerCase();
    if (!search) return sourceOptions;
    return sourceOptions.filter((label) => {
      const meta = parseLabelMeta(label.notes);
      return [
        label.id,
        label.item_name,
        label.serial_batch,
        label.barcode,
        meta.product_name,
        meta.action,
        meta.source_short_code,
        previewSourceCode(label),
      ].some((value) => String(value || "").toLowerCase().includes(search));
    });
  }, [sourceOptions, sourceSearch]);

  const selectedSource = useMemo(
    () => sourceOptions.find((label) => String(label.id) === String(sourceLabelId)) || null,
    [sourceOptions, sourceLabelId],
  );

  const calculatedExpiry = useMemo(
    () => calculatedExpiryFor(selectedRule, preparedAt, manualExpiry),
    [selectedRule, preparedAt, manualExpiry],
  );
  const effectiveExpiry = useMemo(
    () => effectiveExpiryFor(selectedRule, calculatedExpiry, selectedSource),
    [selectedRule, calculatedExpiry, selectedSource],
  );
  const expiryLimitedBySource = Boolean(
    calculatedExpiry && effectiveExpiry && effectiveExpiry.getTime() < calculatedExpiry.getTime(),
  );

  const selectProduct = (productId) => {
    setSelectedProductId(String(productId));
    setProductSearch("");
  };

  const selectSourceFromSearch = async (lookupValue = "") => {
    const rawQuery = String(lookupValue || sourceSearch).trim();
    const query = rawQuery.toLowerCase();
    if (!query || searchingSource) return;
    const exact = sourceOptions.find((label) => {
      const meta = parseLabelMeta(label.notes);
      return [label.id, label.serial_batch, label.barcode, meta.source_short_code, previewSourceCode(label)]
        .some((value) => String(value || "").toLowerCase() === query);
    });
    const localSelection = exact || filteredSourceOptions[0];
    if (localSelection) {
      setSourceLabelId(localSelection.id);
      setSourceSearch("");
      setError("");
      return;
    }

    setSearchingSource(true);
    setError("");
    try {
      const [byBarcode, byBatch, byId] = await Promise.all([
        opsClient.entities.FoodLabel.filter({ barcode: rawQuery }, "-created_date", 5),
        opsClient.entities.FoodLabel.filter({ serial_batch: rawQuery }, "-created_date", 5),
        opsClient.entities.FoodLabel.filter({ id: rawQuery }, "-created_date", 5),
      ]);
      const remoteCandidates = [...(byBarcode || []), ...(byBatch || []), ...(byId || [])]
        .filter((label, index, rows) => rows.findIndex((row) => row.id === label.id) === index);
      const remoteSelection = remoteCandidates.find(isEligibleSource);
      if (!remoteSelection) {
        setError("No eligible source batch matches this barcode or batch number.");
        return;
      }
      setRecentLabels((current) => current.some((row) => row.id === remoteSelection.id) ? current : [remoteSelection, ...current]);
      setSourceLabelId(remoteSelection.id);
      setSourceSearch("");
    } catch (lookupError) {
      setError(lookupError.message || "Source batch could not be found.");
    } finally {
      setSearchingSource(false);
    }
  };

  const scanSourceLabelPhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || scanningSourcePhoto) return;
    setScanningSourcePhoto(true);
    setError("");
    try {
      const code = await detectLookupCodeFromImage(file);
      if (!code) {
        setError("No barcode or batch code was detected. Move closer, keep the label flat and try again.");
        return;
      }
      setSourceSearch(code);
      await selectSourceFromSearch(code);
    } catch (scanError) {
      setError(scanError.message || "The source label image could not be read.");
    } finally {
      setScanningSourcePhoto(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    if (!selectedProduct || !selectedRule) {
      setError("Select a product and process first.");
      return;
    }
    if (selectedRule.requiresSource && !sourceLabelId) {
      setError("Scan or select the source batch used for this product.");
      return;
    }
    if (selectedRule.requiresQuantity && (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0)) {
      setError("Enter a valid quantity.");
      return;
    }
    if (selectedRule.manualExpiryRequired && !manualExpiry) {
      setError("This rule requires a manual use-by time.");
      return;
    }
    const copies = Number(printQuantity);
    if (!Number.isInteger(copies) || copies < 1 || copies > 100) {
      setError("Print quantity must be a whole number from 1 to 100.");
      return;
    }
    if (!effectiveExpiry || effectiveExpiry.getTime() <= preparedAt.getTime()) {
      setError("This rule does not produce a valid future Use By time. Check ExpiryRules.");
      return;
    }

    const printWindow = window.open("", "_blank", "width=480,height=640");
    if (printWindow) {
      printWindow.document.write("<!doctype html><title>Preparing label…</title><body style=\"font-family:Arial,sans-serif;padding:24px\">Preparing label…</body>");
      printWindow.document.close();
    }

    setSaving(true);
    try {
      const created = await opsClient.labels.create({
        rule_key: selectedRule.ruleKey || selectedRule.ruleId,
        rule_id: selectedRule.ruleId,
        product_id: selectedProduct.productId,
        outlet_id: user?.outlet_id || "",
        quantity: selectedRule.requiresQuantity ? Number(quantity) : 1,
        print_quantity: copies,
        printer_name: printerProfile?.profile_name || "Browser Print",
        manual_expiry_at: selectedRule.manualExpiryRequired ? new Date(manualExpiry).toISOString() : "",
        source_label_id: selectedRule.requiresSource ? sourceLabelId : "",
      });
      onPrint(created, printWindow, {
        copies: Number(created.initial_print_quantity || copies),
        mode: "print",
        operatorName: created.printed_by_name || user?.full_name,
      });
      onDone();
    } catch (err) {
      printWindow?.close();
      setError(err.message || "Failed to create label");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Loading product and expiry rules…</div>;
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
        <div className="flex items-center gap-2 font-medium text-destructive"><AlertCircle className="h-4 w-4" /> Label rules could not be loaded</div>
        <p className="mt-2 text-muted-foreground">{loadError}</p>
      </div>
    );
  }

  const reviewStep = selectedRule?.requiresSource ? 4 : 3;

  return (
    <form onSubmit={submit} className="labels-create-form space-y-5">
      <div className="labels-create-fields space-y-5">
      <section className="space-y-2">
        <StepHeader number={1} title="Choose product" subtitle="Start with the finished item you are labelling." />
        <Input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="Search product" autoComplete="off" />
        {productSearch && (
          <div className="max-h-44 overflow-y-auto rounded-lg border bg-background p-1">
            {filteredProducts.length ? filteredProducts.slice(0, 30).map((product) => (
              <button key={product.productId} type="button" className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => selectProduct(product.productId)}>
                {product.displayName || product.productName}
              </button>
            )) : <p className="px-3 py-4 text-center text-xs text-muted-foreground">No matching product</p>}
          </div>
        )}
        {!productSearch && (
          <select className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm" value={selectedProductId} onChange={(event) => selectProduct(event.target.value)}>
            <option value="">Select product</option>
            {productOptions.map((product) => <option key={product.productId} value={product.productId}>{product.displayName || product.productName}</option>)}
          </select>
        )}
        {selectedProduct && (
          <div className="flex items-start gap-2 rounded-lg bg-muted/60 p-3">
            <PackageSearch className="h-4 w-4 mt-0.5 text-muted-foreground" />
            <div className="min-w-0"><p className="text-sm font-medium">{selectedProduct.displayName || selectedProduct.productName}</p>{selectedProduct.note && <p className="text-xs text-muted-foreground mt-0.5">{selectedProduct.note}</p>}</div>
          </div>
        )}
      </section>

      {selectedProduct && (
        <section className="space-y-2 border-t pt-4">
          <StepHeader number={2} title="Choose process" subtitle="The process decides storage, expiry and required inputs." />
          <div className="grid grid-cols-1 gap-2">
            {productRules.map((rule) => {
              const selected = String(selectedRuleId) === String(rule.ruleKey || rule.ruleId);
              return (
                <button key={rule.ruleKey || `${rule.ruleId}-${rule.action}-${rule.storageCondition}`} type="button" onClick={() => setSelectedRuleId(String(rule.ruleKey || rule.ruleId))} className={`rounded-lg border p-3 text-left transition ${selected ? "border-foreground bg-foreground text-background" : "border-border bg-background hover:bg-muted"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold">{rule.action}</p>
                      <p className={`text-xs mt-0.5 ${selected ? "text-background/70" : "text-muted-foreground"}`}>{storageLabel(rule.storageCondition)} · {rule.manualExpiryRequired ? "Manual use-by" : (rule.note || durationLabel(rule.durationMinutes))}</p>
                      {rule.requiresSource && <p className={`text-[11px] mt-1 font-medium ${selected ? "text-background" : "text-foreground"}`}>Source batch required</p>}
                    </div>
                    {selected && <CheckCircle2 className="h-4 w-4 shrink-0" />}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {selectedRule?.requiresSource && (
        <section className="space-y-3 border-t pt-4">
          <StepHeader number={3} title="Link the source batch" subtitle={`Scan or select the ${selectedRule.sourceProductName || "source ingredient"} used today.`} />

          {selectedSource ? (
            <div className="rounded-xl border border-foreground bg-muted/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{displayLabelName(selectedSource)}</p>
                  <p className="text-xs text-muted-foreground mt-1">Prepared: {formatDateTime(parseLabelMeta(selectedSource.notes).prepared_at || selectedSource.created_date)}</p>
                  <p className="text-xs text-muted-foreground">Source use by: {formatDateTime(parseLabelMeta(selectedSource.notes).expires_at || selectedSource.expiry_date)}</p>
                  <p className="text-xs font-semibold mt-1">{previewSourceCode(selectedSource)}</p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => setSourceLabelId("")}>Change</Button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={sourceSearch}
                      onChange={(event) => setSourceSearch(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void selectSourceFromSearch();
                        }
                      }}
                      className="pl-9"
                      placeholder="Barcode or batch code"
                      autoComplete="off"
                      autoFocus
                    />
                  </div>
                  <input
                    ref={sourceCameraInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(event) => void scanSourceLabelPhoto(event)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 w-10 p-0"
                    aria-label="Scan source label with camera"
                    onClick={() => sourceCameraInputRef.current?.click()}
                    disabled={scanningSourcePhoto}
                  >
                    {scanningSourcePhoto ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void selectSourceFromSearch()} disabled={searchingSource}>{searchingSource ? <Loader2 className="h-4 w-4 animate-spin" /> : "Select"}</Button>
                </div>
                <p className="text-[11px] text-muted-foreground">Camera reads the barcode first and can fall back to OCR for the printed batch code.</p>
              </div>

              <div className="max-h-52 overflow-y-auto space-y-2">
                {filteredSourceOptions.slice(0, 30).map((label) => {
                  const meta = parseLabelMeta(label.notes);
                  return (
                    <button key={label.id} type="button" onClick={() => { setSourceLabelId(label.id); setSourceSearch(""); }} className="w-full rounded-lg border bg-background p-3 text-left hover:bg-muted">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{displayLabelName(label)}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{meta.action || "Label"} · Prepared {formatDateTime(meta.prepared_at || label.created_date)}</p>
                          <p className="mt-1 text-[11px] font-medium text-emerald-700">{meta.source_remaining_qty != null ? `${meta.source_remaining_qty} ${meta.source_unit || "unit"} remaining` : "Active batch"}</p>
                        </div>
                        <span className="text-[10px] font-semibold shrink-0">{previewSourceCode(label)}</span>
                      </div>
                    </button>
                  );
                })}
                {!filteredSourceOptions.length && <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-4 text-center text-xs text-destructive">No eligible, unexpired source batch is available. Create the source label first.</p>}
              </div>
            </>
          )}

          <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
            The source batch remains linked in the system. The printed label only shows the new batch code and barcode.
          </div>
        </section>
      )}

      {selectedRule && (!selectedRule.requiresSource || selectedSource) && (
        <section className="space-y-3 border-t pt-4">
          <StepHeader number={reviewStep} title="Confirm the automatic label" subtitle="Review the final values before printing." />

          {selectedRule.manualExpiryRequired && (
            <div className="space-y-1.5">
              <Label htmlFor="manual-expiry">Use-by date and time</Label>
              <Input id="manual-expiry" type="datetime-local" value={manualExpiry} min={toLocalDateTimeInput(preparedAt)} onChange={(event) => setManualExpiry(event.target.value)} required />
              <p className="text-xs text-muted-foreground">This rule is marked manual in ExpiryRules.</p>
            </div>
          )}

          {selectedRule.requiresQuantity && (
            <div className="space-y-1.5">
              <Label htmlFor="label-quantity">{selectedRule.quantityLabel || "Quantity"}</Label>
              <div className="flex items-center gap-2">
                <Input id="label-quantity" type="number" inputMode="decimal" min="0.01" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} required />
                {selectedRule.quantityUnit && <span className="min-w-16 text-sm text-muted-foreground">{selectedRule.quantityUnit}</span>}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="print-quantity">Print quantity</Label>
            <div className="grid grid-cols-[44px_1fr_44px] gap-2">
              <Button type="button" variant="outline" className="h-10 p-0" onClick={() => setPrintQuantity(String(Math.max(1, Number(printQuantity || 1) - 1)))} aria-label="Decrease print quantity">−</Button>
              <Input id="print-quantity" type="number" inputMode="numeric" min="1" max="100" step="1" className="text-center" value={printQuantity} onChange={(event) => setPrintQuantity(event.target.value)} required />
              <Button type="button" variant="outline" className="h-10 p-0" onClick={() => setPrintQuantity(String(Math.min(100, Number(printQuantity || 0) + 1)))} aria-label="Increase print quantity">+</Button>
            </div>
            <p className="text-xs text-muted-foreground">This prints {Number(printQuantity || 0) || 1} label(s). {selectedRule.requiresSource ? `Source usage: ${(Number(printQuantity || 0) || 1) * Number(selectedRule.consumePerLabel || 1)} ${selectedRule.sourceUnit || "unit"}.` : ""}</p>
          </div>

          <div className="rounded-xl border bg-muted/35 p-3 space-y-3">
            <ReviewRow label="Product" value={labelTitleFor(selectedRule, selectedProduct)} strong />
            <ReviewRow label="Action · Storage" value={`${selectedRule.action} · ${String(storageLabel(selectedRule.storageCondition)).replace(/^[^A-Za-z0-9]+/, "")}`} />
            <ReviewRow label="Print quantity" value={`${Number(printQuantity || 0) || 1} label(s)`} />
            <ReviewRow label="Printed by" value={user?.full_name || "—"} />
            <div className="grid grid-cols-2 gap-2">
              <DateTimeCard label="Made" value={preparedAt} />
              <DateTimeCard label="Use By" value={effectiveExpiry} strong />
            </div>
            {selectedSource && <ReviewRow label="Source batch" value={`${displayLabelName(selectedSource)} · ${previewSourceCode(selectedSource)}`} />}
            {expiryLimitedBySource && <div className="rounded-md bg-amber-100 px-2 py-1.5 text-xs font-medium text-amber-900">Use-by was shortened because the source batch expires earlier.</div>}
            {!selectedRule.manualExpiryRequired && <ReviewRow label="Expiry rule" value={selectedRule.note || durationLabel(selectedRule.durationMinutes)} />}
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
            <Clock3 className="h-4 w-4 mt-0.5 shrink-0" />
            <p>Made time, final use-by, batch, barcode and trace link are generated by the server. Staff cannot overwrite them.</p>
          </div>
        </section>
      )}

      </div>
      <div className="labels-create-actions sticky bottom-0 z-10 -mx-1 border-t bg-background/95 px-1 pb-[calc(.25rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
        <Button type="submit" className="h-12 w-full" disabled={saving || !selectedRule || !effectiveExpiry || (selectedRule?.requiresSource && !selectedSource)}>
          {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Printer className="h-4 w-4 mr-2" />}
          Create & Print {Number(printQuantity || 0) || 1} Label{Number(printQuantity || 0) === 1 ? "" : "s"}
        </Button>
      </div>
    </form>
  );
}

function StepHeader({ number, title, subtitle }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-background text-xs font-bold">{number}</span>
      <div><p className="text-sm font-semibold">{title}</p><p className="text-xs text-muted-foreground">{subtitle}</p></div>
    </div>
  );
}

function DateTimeCard({ label, value, strong = false }) {
  const time = formatLabelTime(value);
  return (
    <div className={`rounded-lg border bg-background p-2.5 ${strong ? "border-foreground" : ""}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        {time && <span className="text-xs font-bold tabular-nums">{time}</span>}
      </div>
      <p className={`mt-1 text-xs tabular-nums ${strong ? "font-bold" : "font-semibold"}`}>{formatLabelDate(value)}</p>
    </div>
  );
}

function ReviewRow({ label, value, strong = false }) {
  return (
    <div className="flex items-start justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-right ${strong ? "font-bold text-foreground" : "font-medium"}`}>{value || "—"}</span>
    </div>
  );
}
