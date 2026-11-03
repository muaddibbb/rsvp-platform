const path = require("path");

const FONT_PATH = path.join(__dirname, "fonts", "Alef-Regular.ttf");

// Replace spaces with non-breaking space so pdfkit keeps Hebrew words in one glyph run
function h(str) {
  return str.replace(/ /g, " ");
}

function pad(n) {
  return String(n).padStart(6, "0");
}

function generateReceiptPDF({ receiptNumber, customerName, paymentDate, isRefund = false }) {
  const PDFDocument = require("pdfkit");

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A5",
      margins: { top: 20, bottom: 20, left: 40, right: 40 },
    });

    doc.registerFont("Heb", FONT_PATH);
    doc.font("Heb");

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const num = pad(receiptNumber);
    const date = paymentDate || new Date().toLocaleDateString("he-IL");

    const W  = doc.page.width;   // ~419pt for A5
    const ML = 40;
    const MR = 40;
    const CW = W - ML - MR;      // ~339pt

    // Draw Hebrew text on the right and a number/label on the left, centered together.
    // Two separate text() calls so the gap is physical (bidi never touches it).
    const drawCentered = (hebrewText, numberText, y, fontSize, hebColor, numColor) => {
      doc.fontSize(fontSize);
      const hw = doc.widthOfString(hebrewText);
      const nw = doc.widthOfString(numberText);
      const sw = doc.widthOfString(" ");
      const totalW = hw + sw + nw;
      const startX = (W - totalW) / 2;
      // number on the left
      doc.fillColor(numColor);
      doc.text(numberText, startX, y, { width: nw, align: "left", lineBreak: false });
      // Hebrew on the right (right-aligned within its measured width)
      doc.fillColor(hebColor);
      doc.text(hebrewText, startX + nw + sw, y, { width: hw, align: "right", lineBreak: false });
    };

    // ── Header ────────────────────────────────────────────────
    doc.rect(0, 0, W, 80).fill(isRefund ? "#7f1d1d" : "#1a2744");

    doc.fontSize(28).fillColor(isRefund ? "#fca5a5" : "#f0d080");
    doc.text(isRefund ? h("קבלת זיכוי") : "קבלה", 0, 18, { width: W, align: "center" });

    const receiptLabel = isRefund ? h("זיכוי מספר") : h("קבלה מספר");
    drawCentered(receiptLabel, num, 52, 12, "#ffffff", "#ffffff");

    // ── Business ──────────────────────────────────────────────
    let y = 98;

    doc.fontSize(18).fillColor("#1a2744");
    doc.text("Kupernet", 0, y, { width: W, align: "center" });
    y += 26;

    drawCentered(h("עוסק פטור מספר"), "036409084", y, 10, "#6b7280", "#6b7280");
    y += 18;

    doc.moveTo(ML, y).lineTo(W - MR, y).lineWidth(0.5).strokeColor("#e5e7eb").stroke();
    y += 14;

    // ── Detail table ──────────────────────────────────────────
    const LABEL_W = 100;
    const GAP     = 10;
    const VALUE_W = CW - LABEL_W - GAP;
    const LABEL_X = W - MR - LABEL_W;   // right column
    const VALUE_X = ML;                  // left column

    const drawRow = (label, value) => {
      doc.fontSize(11);
      const lh = doc.heightOfString(label, { width: LABEL_W });
      const vh = doc.heightOfString(value, { width: VALUE_W });
      const rh = Math.max(lh, vh);

      doc.fillColor("#6b7280");
      doc.text(label, LABEL_X, y, { width: LABEL_W, align: "right", lineBreak: false });

      doc.fillColor("#1a1a2e");
      doc.text(value, VALUE_X, y, { width: VALUE_W, align: "right", lineBreak: false });

      y += rh + 12;
      doc.moveTo(ML, y - 5).lineTo(W - MR, y - 5).lineWidth(0.3).strokeColor("#e5e7eb").stroke();
    };

    // Amount row: draw the number and "ש״ח" as separate calls with a physical gap so the space never drops.
    const drawAmountRow = (rowY) => {
      doc.fontSize(11);
      const numTxt = "99";
      const shekTxt = h("ש״ח");
      const dashTxt = " — ";
      const wordsTxt = h("תשעים ותשעה שקלים");
      const nw = doc.widthOfString(numTxt);
      const sw = doc.widthOfString(" ");
      const shw = doc.widthOfString(shekTxt);
      const dw = doc.widthOfString(dashTxt);
      const ww = doc.widthOfString(wordsTxt);
      const rowH = doc.heightOfString(wordsTxt, { width: VALUE_W });

      doc.fillColor("#6b7280");
      doc.text(h("סכום ששולם"), LABEL_X, rowY, { width: LABEL_W, align: "right", lineBreak: false });

      // Value: ש״ח on left, the number to its right, then " — ", then the words.
      doc.fillColor("#1a1a2e");
      let vx = VALUE_X;
      doc.text(shekTxt, vx, rowY, { lineBreak: false });
      vx += shw + sw;
      doc.text(numTxt, vx, rowY, { lineBreak: false });
      vx += nw;
      doc.text(dashTxt, vx, rowY, { lineBreak: false });
      vx += dw;
      doc.text(wordsTxt, vx, rowY, { width: VALUE_W - (vx - VALUE_X), align: "right", lineBreak: false });

      return rowH + 12;
    };

    drawRow(isRefund ? h("תאריך הזיכוי") : "תאריך", date);
    drawRow(isRefund ? h("שם מקבל הזיכוי") : h("שם המשלם"), h(customerName));
    const amtH = drawAmountRow(y);
    doc.moveTo(ML, y + amtH - 5).lineTo(W - MR, y + amtH - 5).lineWidth(0.3).strokeColor("#e5e7eb").stroke();
    y += amtH;
    drawRow(isRefund ? h("סיבת הזיכוי") : h("אמצעי תשלום"), isRefund ? h("ביטול עסקה") : "PayPal");

    // ── Total ─────────────────────────────────────────────────
    y += 4;
    doc.rect(ML, y, CW, 40).fill("#fdf5e0");

    doc.fontSize(13).fillColor("#1a2744");
    doc.text(isRefund ? h("סה״כ זוכה") : h("סה״כ שולם"), LABEL_X, y + 12, { width: LABEL_W, align: "right" });

    // "99 ש״ח" — position explicitly so space is physical
    doc.fontSize(16).fillColor("#c9993a");
    const totNum = "99";
    const totHeb = h("ש״ח");
    const tsp = doc.widthOfString(" ");
    const tnw = doc.widthOfString(totNum);
    const thw = doc.widthOfString(totHeb);
    // ש״ח on the left, 99 on the right (right-aligned as a unit in the value column)
    const totNumX = VALUE_X + VALUE_W - tnw;
    const totHebX = totNumX - tsp - thw;
    doc.text(totHeb, totHebX, y + 10, { lineBreak: false });
    doc.text(totNum, totNumX, y + 10, { lineBreak: false });
    y += 48;

    // ── Footer ────────────────────────────────────────────────
    doc.fontSize(9).fillColor("#6b7280");
    drawCentered(h("מספר קבלה סידורי") + ":", num, y, 9, "#6b7280", "#6b7280");
    y += 14;

    doc.moveTo(ML, y).lineTo(W - MR, y).lineWidth(0.5).strokeColor("#d1d5db").stroke();
    y += 8;

    doc.fillColor("#9ca3af");
    doc.fontSize(9);
    doc.text(h("קבלה זו מונפקת על ידי"), 0, y, { width: W, align: "center" });
    y += 13;
    doc.text("Kupernet Systems", 0, y, { width: W, align: "center" });
    y += 13;
    doc.text("rsvp.kupernet.com", 0, y, { width: W, align: "center" });

    doc.end();
  });
}

// ── Shared receipt data (one source for the admin download and the e-mailed copy) ───────────────────

const RECEIPT_TZ = "Asia/Jerusalem";

// The receipt date: a stored timestamp shown as a he-IL date in Israel time (a server running in UTC
// would print the previous day for payments made after 21:00 UTC). No/invalid timestamp: today.
function formatPaymentDate(ts) {
  let d = ts ? new Date(ts) : new Date();
  if (Number.isNaN(d.getTime())) d = new Date();
  return d.toLocaleDateString("he-IL", { timeZone: RECEIPT_TZ });
}

// The stored receipt number of a paid event. Order of preference:
//  1. the number already on the row (events.receipt_number),
//  2. the SQL function assign_receipt_number(p_slug): idempotent, gapless counter (needs the migration),
//  3. the old rule, "how many paid events were paid up to this one" (same numbers the backfill produces).
// `supabase` is the caller's client. Never throws for a missing migration.
async function receiptNumberFor(supabase, event) {
  if (event && event.receipt_number != null) return event.receipt_number;
  try {
    const { data, error } = await supabase.rpc("assign_receipt_number", { p_slug: event.slug });
    if (!error && data != null) return Number(data);
    if (error) console.error("assign_receipt_number unavailable, using the count fallback:", error.code || "", error.message || "");
  } catch (e) {
    console.error("assign_receipt_number error, using the count fallback:", e && e.message);
  }
  if (!event.paid_at) return 1;
  const { count } = await supabase.from("events").select("*", { count: "exact", head: true }).lte("paid_at", event.paid_at);
  return count || 1;
}

// Inputs for generateReceiptPDF. `event` needs: slug, customer_name, paid_at and, when known,
// receipt_number and refunded_at. A refund copy reuses the receipt number and is dated refunded_at.
async function buildReceipt(supabase, event, { isRefund = false } = {}) {
  const receiptNumber = await receiptNumberFor(supabase, event);
  return {
    receiptNumber,
    customerName: event.customer_name,
    paymentDate: formatPaymentDate(isRefund ? event.refunded_at : event.paid_at),
    isRefund,
  };
}

module.exports = generateReceiptPDF;
module.exports.generateReceiptPDF = generateReceiptPDF;
module.exports.buildReceipt = buildReceipt;
module.exports.receiptNumberFor = receiptNumberFor;
module.exports.formatPaymentDate = formatPaymentDate;
