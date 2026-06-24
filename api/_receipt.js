const pdfmake = require("pdfmake");
const path = require("path");

const fontPath = path.join(__dirname, "fonts", "Alef-Regular.ttf");

// Allow local filesystem access for font loading
pdfmake.setLocalAccessPolicy(() => true);
pdfmake.setUrlAccessPolicy(() => false);

pdfmake.addFonts({
  Hebrew: {
    normal: fontPath,
    bold: fontPath,
    italics: fontPath,
    bolditalics: fontPath,
  },
});

function pad(n) {
  return String(n).padStart(6, "0");
}

module.exports = function generateReceiptPDF({ receiptNumber, customerName, paymentDate }) {
  const num = pad(receiptNumber);
  const date = paymentDate || new Date().toLocaleDateString("he-IL");

  const docDef = {
    pageSize: "A5",
    pageMargins: [40, 20, 40, 20],
    defaultStyle: { font: "Hebrew", fontSize: 11, rtl: true },

    content: [
      // ── Header ──────────────────────────────────────────────
      {
        canvas: [{ type: "rect", x: -40, y: -20, w: 419, h: 80, color: "#1a2744" }],
        margin: [0, 0, 0, 0],
      },
      {
        text: "קבלה",
        fontSize: 28,
        color: "#f0d080",
        alignment: "center",
        margin: [-40, -66, -40, 2],
      },
      {
        text: `מספר קבלה: ${num}`,
        fontSize: 12,
        color: "#ffffff",
        alignment: "center",
        margin: [-40, 0, -40, 18],
      },

      // ── Business ─────────────────────────────────────────────
      { text: "Kupernet", fontSize: 18, color: "#1a2744", alignment: "center", margin: [0, 4, 0, 4] },
      { text: "עוסק פטור מס׳ 036409084", fontSize: 10, color: "#6b7280", alignment: "center", margin: [0, 0, 0, 12] },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 339, y2: 0, lineWidth: 0.5, lineColor: "#e5e7eb" }], margin: [0, 0, 0, 12] },

      // ── Details table ────────────────────────────────────────
      {
        table: {
          widths: ["auto", "*"],
          body: [
            [
              { text: "תאריך",                          color: "#6b7280", alignment: "right", margin: [0, 4, 0, 4] },
              { text: date,                             color: "#1a1a2e", alignment: "left",  margin: [0, 4, 8, 4] },
            ],
            [
              { text: "שם המשלם",                       color: "#6b7280", alignment: "right", margin: [0, 4, 0, 4] },
              { text: customerName,                     color: "#1a1a2e", alignment: "left",  margin: [0, 4, 8, 4] },
            ],
            [
              { text: "סכום ששולם",                     color: "#6b7280", alignment: "right", margin: [0, 4, 0, 4] },
              { text: "תשעים ותשעה שקלים — 99 ש״ח",    color: "#1a1a2e", alignment: "left",  margin: [0, 4, 8, 4] },
            ],
            [
              { text: "אמצעי תשלום",                    color: "#6b7280", alignment: "right", margin: [0, 4, 0, 4] },
              { text: "PayPal",                         color: "#1a1a2e", alignment: "left",  margin: [0, 4, 8, 4] },
            ],
          ],
        },
        layout: "lightHorizontalLines",
        margin: [0, 0, 0, 12],
      },

      // ── Total ────────────────────────────────────────────────
      {
        table: {
          widths: ["auto", "*"],
          body: [[
            { text: "סה״כ שולם",  fontSize: 13, color: "#1a2744",                alignment: "right", margin: [0, 8, 0, 8] },
            { text: "99 ש״ח", fontSize: 16, color: "#c9993a", bold: true, alignment: "left",  margin: [8, 8, 4, 8] },
          ]],
        },
        layout: {
          fillColor: () => "#fdf5e0",
          hLineWidth: () => 0,
          vLineWidth: () => 0,
        },
        margin: [0, 0, 0, 16],
      },

      // ── Footer ───────────────────────────────────────────────
      { text: `מספר קבלה סידורי: ${num}`, fontSize: 9, color: "#6b7280", alignment: "center", margin: [0, 0, 0, 6] },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 339, y2: 0, lineWidth: 0.5, lineColor: "#d1d5db" }], margin: [0, 0, 0, 8] },
      { text: "קבלה זו מונפקת על ידי Kupernet Systems", fontSize: 9, color: "#9ca3af", alignment: "center" },
      { text: "rsvp.kupernet.com", fontSize: 9, color: "#9ca3af", alignment: "center" },
    ],
  };

  return pdfmake.createPdf(docDef).getBuffer();
};
