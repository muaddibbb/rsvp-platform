const PDFDocument = require("pdfkit");
const path = require("path");

const FONT = path.join(__dirname, "fonts", "Alef-Regular.ttf");

// Right-align Hebrew text (PDFKit RTL helper)
function rtl(doc, text, y, opts = {}) {
  doc.text(text, 50, y, { align: "right", lineBreak: false, width: 495, ...opts });
}

function pad(n) {
  return String(n).padStart(6, "0");
}

function todayHebrew() {
  return new Date().toLocaleDateString("he-IL", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

module.exports = function generateReceiptPDF({ receiptNumber, customerName, paymentDate }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 40, info: { Title: "קבלה" } });
    doc.registerFont("Heebo", FONT);

    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - 80; // usable width
    const date = paymentDate || todayHebrew();
    const num = pad(receiptNumber);

    // ── Header band ──────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 80).fill("#1a2744");
    doc.font("Heebo").fontSize(26).fillColor("#f0d080");
    doc.text("קבלה", 0, 18, { align: "center", width: doc.page.width });
    doc.fontSize(12).fillColor("#ffffff");
    doc.text(`מספר קבלה: ${num}`, 0, 50, { align: "center", width: doc.page.width });

    doc.fillColor("#1a2744");

    // ── Business block ───────────────────────────────────────────
    let y = 100;
    doc.font("Heebo").fontSize(18).text("Kupernet", 0, y, { align: "center", width: doc.page.width });
    y += 24;
    doc.fontSize(10).fillColor("#6b7280");
    doc.text(`עוסק פטור מס׳ 036409084`, 0, y, { align: "center", width: doc.page.width });
    y += 30;

    // ── Divider ──────────────────────────────────────────────────
    doc.moveTo(40, y).lineTo(doc.page.width - 40, y).strokeColor("#e5e7eb").stroke();
    y += 16;

    // ── Details table ────────────────────────────────────────────
    const rows = [
      ["תאריך", date],
      ["שם המשלם", customerName],
      ["סכום ששולם", "תשעים ותשעה שקלים — 99 ש״ח"],
      ["אמצעי תשלום", "PayPal"],
    ];

    doc.fontSize(11).fillColor("#1a2744");
    rows.forEach(([label, value]) => {
      // label on right, value on left (RTL receipt layout)
      doc.font("Heebo").fillColor("#6b7280").text(label, 40, y, { width: 120, align: "right", lineBreak: false });
      doc.fillColor("#1a1a2e").text(value, 170, y, { width: W - 120, align: "right", lineBreak: false });
      y += 24;
    });

    y += 8;
    doc.moveTo(40, y).lineTo(doc.page.width - 40, y).strokeColor("#e5e7eb").stroke();
    y += 20;

    // ── Amount highlight ─────────────────────────────────────────
    doc.rect(40, y, W + 8, 36).fill("#fdf5e0");
    doc.font("Heebo").fontSize(13).fillColor("#1a2744");
    doc.text("סה״כ שולם:", 50, y + 10, { width: 120, align: "right", lineBreak: false });
    doc.fontSize(15).fillColor("#c9993a");
    doc.text("99 ש״ח", 0, y + 8, { align: "center", width: doc.page.width });
    y += 56;

    // ── Footer ───────────────────────────────────────────────────
    doc.fontSize(9).fillColor("#9ca3af");
    doc.text("קבלה זו מונפקת ע״י Kupernet Systems", 0, y, { align: "center", width: doc.page.width });
    doc.text("rsvp.kupernet.com", 0, y + 14, { align: "center", width: doc.page.width });

    doc.end();
  });
};
