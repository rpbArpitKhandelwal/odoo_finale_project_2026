/* DealFlow360 — dependency-free exporters: CSV, XLS (SpreadsheetML), PDF (hand-built) */
'use strict';

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/* ---------- CSV ---------- */
function buildCSV(headers, rows, footer) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const out = [headers.map(q).join(',')];
  for (const r of rows) out.push(r.map(q).join(','));
  if (footer) out.push(footer.map(q).join(','));
  return '\ufeff' + out.join('\r\n'); // BOM so Excel opens UTF-8 happily
}

/* ---------- XLS (SpreadsheetML 2003 — opens natively in Excel/LibreOffice) ---------- */
function buildXLS(title, headers, rows, footer) {
  const cell = (v) => {
    const num = Number(v);
    const isNum = v !== '' && v != null && !isNaN(num);
    return isNum ? `<Cell><Data ss:Type="Number">${num}</Data></Cell>` : `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`;
  };
  const row = (cells, style) => `<Row${style ? ` ss:StyleID="${style}"` : ''}>${cells.map(cell).join('')}</Row>`;
  let xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#E8EAF6" ss:Pattern="Solid"/></Style>
<Style ss:ID="t"><Font ss:Bold="1"/></Style></Styles>
<Worksheet ss:Name="Report"><Table>
<Row><Cell ss:StyleID="t"><Data ss:Type="String">${esc(title)}</Data></Cell></Row>
<Row></Row>
${row(headers, 'h')}
${rows.map((r) => row(r)).join('\n')}
${footer ? row(footer, 't') : ''}
</Table></Worksheet></Workbook>`;
  return xml;
}

/* ---------- PDF (minimal built-from-scratch generator: Helvetica, table layout) ---------- */
function buildPDF(title, headers, rows, footer, meta) {
  const PAGE_W = 842, PAGE_H = 595; // A4 landscape
  const M = 36;
  const colW = (PAGE_W - 2 * M) / headers.length;
  /* built-in Helvetica is WinAnsi-only: transliterate what we use, drop the rest */
  const pdfEsc = (s) => String(s ?? '')
    .replace(/₹/g, 'Rs.').replace(/→/g, '->').replace(/[–—]/g, '-').replace(/·/g, '-').replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let y = 0; const content = [];
  /* text: gray 0 = black (default), 1 = white — callers opt into light text with gray/white */
  const text = (x, yy, size, str, opts = {}) => {
    let out = pdfEsc(str);
    if (opts.maxW) {
      const maxChars = Math.max(4, Math.floor(opts.maxW / (size * 0.5))); // ~0.5em average glyph
      if (out.length > maxChars) out = `${out.slice(0, Math.max(3, maxChars - 3))}...`;
    }
    content.push({ t: 'Tj', x, y: yy, size, str: out, gray: opts.gray ?? (opts.white ? 1 : 0), bold: opts.bold });
  };
  const rect = (x, yy, w, h, gray) => content.push({ t: 're', x, y: yy, w, h, gray });

  // header band (near-black) with white title + light subtitle
  rect(0, PAGE_H - 70, PAGE_W, 70, 0.12);
  text(M, PAGE_H - 42, 17, title, { white: true, bold: true, maxW: PAGE_W - 2 * M });
  text(M, PAGE_H - 60, 9, `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC - ${rows.length} records`, { gray: 0.72, maxW: PAGE_W - 2 * M });
  y = PAGE_H - 96;
  // optional meta block (invoice documents: customer, dates, coverage note)
  if (Array.isArray(meta)) {
    for (const line of meta) {
      text(M, y, 9, line, { gray: 0.25, maxW: PAGE_W - 2 * M });
      y -= 13;
    }
    y -= 6;
  }
  // table header (black bold on light band)
  rect(M, y - 5, PAGE_W - 2 * M, 18, 0.9);
  headers.forEach((h, i) => text(M + 4 + i * colW, y + 7, 8, h, { bold: true, maxW: colW - 6 }));
  y -= 18;
  for (const r of rows) {
    if (y < 50) break; // single-page report (hackathon scale)
    r.forEach((c, i) => text(M + 4 + i * colW, y + 4, 8, c, { maxW: colW - 6 }));
    y -= 15;
  }
  if (footer) {
    y -= 4; rect(M, y - 2, PAGE_W - 2 * M, 16, 0.85);
    footer.forEach((c, i) => text(M + 4 + i * colW, y + 8, 8, c, { bold: true, maxW: colW - 6 }));
  }

  // ---- assemble PDF objects ----
  const objs = [];
  objs.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objs.push(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`);
  let s = '';
  for (const c of content) {
    if (c.t === 're') s += `q ${c.gray} g ${c.x} ${PAGE_H - c.y - c.h} ${c.w} ${c.h} re f Q\n`;
    else {
      const font = c.bold ? '/F2' : '/F1';
      s += `BT ${font} ${c.size} Tf ${c.gray.toFixed(2)} g 1 0 0 1 ${c.x} ${PAGE_H - c.y} Tm (${c.str}) Tj ET\n`;
    }
  }
  objs.push(`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`);
  objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}

/* ---------- dedicated INVOICE document (multi-page, colored, right-aligned money) ---------- */
const INK = [0.13, 0.11, 0.16];            // near-black text
const BRAND = [0.44, 0.29, 0.40];           // DealFlow purple
const BRAND_DARK = [0.31, 0.18, 0.37];
const MUTED = [0.45, 0.47, 0.51];
const HAIR = [0.85, 0.86, 0.88];
const RED = [0.72, 0.22, 0.28];
const GREEN = [0.06, 0.45, 0.24];
const AMBER = [0.68, 0.42, 0.10];

function buildInvoicePDF(d) {
  const W = 842, H = 595, M = 48;           // A4 landscape
  const R = W - M;                           // right edge anchor
  const estW = (s, size) => size * 0.5 * String(s).length;
  const pages = [];                          // each: array of ops strings
  let ops = [], y = 0;
  const esc = (s) => String(s ?? '')
    .replace(/₹/g, 'Rs.').replace(/→/g, '->').replace(/[–—]/g, '-').replace(/·/g, '-').replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const T = (x, yy, size, str, o = {}) => {
    const col = o.rgb || INK;
    ops.push(`BT /${o.bold ? 'F2' : 'F1'} ${size} Tf ${col.map((c) => c.toFixed(2)).join(' ')} rg 1 0 0 1 ${x.toFixed(1)} ${(H - yy).toFixed(1)} Tm (${esc(str)}) Tj ET`);
  };
  const TR = (rightX, yy, size, str, o = {}) => T(rightX - estW(str, size), yy, size, str, o); // right-aligned
  const rect = (x, yy, w, h, rgb) => ops.push(`q ${rgb.map((c) => c.toFixed(2)).join(' ')} rg ${x.toFixed(1)} ${(H - yy - h).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f Q`);
  const line = (x1, yy1, x2, yy2, rgb, wpt = 0.7) => ops.push(`q ${rgb.map((c) => c.toFixed(2)).join(' ')} RG ${wpt} w ${x1.toFixed(1)} ${(H - yy1).toFixed(1)} m ${x2.toFixed(1)} ${(H - yy2).toFixed(1)} l S Q`);

  const clip = (str, size, maxW) => { const m = Math.max(4, Math.floor(maxW / (size * 0.5))); return String(str).length > m ? String(str).slice(0, m - 3) + '...' : String(str); };

  /* ---------- header (every page) ---------- */
  const header = () => {
    rect(M, 40, 5, 42, BRAND);
    T(M + 14, 56, 15, d.company.name, { bold: true, rgb: BRAND_DARK });
    T(M + 14, 72, 8, d.company.tagline, { rgb: MUTED });
    TR(R, 52, 22, d.docTitle, { bold: true, rgb: BRAND_DARK });
    TR(R, 68, 9, d.invoice.number, { rgb: MUTED });
    line(M, 96, R, 96, HAIR, 1);
  };

  /* ---------- page 1: meta + bill to ---------- */
  header();
  y = 122;
  T(M, y, 7.5, 'BILL TO', { bold: true, rgb: MUTED });
  T(M, y + 15, 11, d.billTo.name, { bold: true });
  if (d.billTo.tier) T(M, y + 28, 8.5, `${d.billTo.tier} partner`, { rgb: MUTED });
  if (d.billTo.address) T(M, y + 40, 8.5, clip(d.billTo.address, 8.5, 300), { rgb: MUTED });
  // right meta column
  let my = y;
  const metaRows = d.metaRows || [];          // [[label, value]]
  for (const [k, v] of metaRows) {
    TR(R - 95, my, 8.5, k, { rgb: MUTED });
    TR(R, my, 8.5, v, { bold: true });
    my += 13;
  }
  // status badge under meta
  const badge = { paid: ['PAID', GREEN], open: ['DUE', AMBER], void: ['VOID', MUTED] }[d.invoice.status] || [String(d.invoice.status).toUpperCase(), MUTED];
  const bw = 16 + estW(badge[0], 9);
  rect(R - bw, my + 4, bw, 18, badge[1]);
  TR(R - 8, my + 16.5, 9, badge[0], { bold: true, rgb: [1, 1, 1] });

  /* ---------- items table ---------- */
  y = my + 42;
  const COLS = { qty: M + 420, unit: M + 520, disc: M + 600, amt: R };
  const tableHead = () => {
    line(M, y - 6, R, y - 6, BRAND_DARK, 1.2);
    T(M, y + 8, 7.5, 'DESCRIPTION', { bold: true, rgb: MUTED });
    TR(COLS.qty, y + 8, 7.5, 'QTY', { bold: true, rgb: MUTED });
    TR(COLS.unit, y + 8, 7.5, `UNIT (${d.currency})`, { bold: true, rgb: MUTED });
    TR(COLS.disc, y + 8, 7.5, 'DISC', { bold: true, rgb: MUTED });
    TR(COLS.amt, y + 8, 7.5, `AMOUNT (${d.currency})`, { bold: true, rgb: MUTED });
    y += 16;
  };
  tableHead();
  const fmt = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const it of d.items) {
    if (y > H - 150) { pages.push(ops); ops = []; y = 60; header(); tableHead(); }  // paginate
    T(M, y + 8, 9, clip(it.desc, 9, 380));
    TR(COLS.qty, y + 8, 9, String(it.qty));
    TR(COLS.unit, y + 8, 9, fmt(it.unit));
    TR(COLS.disc, y + 8, 9, it.disc);
    TR(COLS.amt, y + 8, 9, fmt(it.amount), { bold: true });
    y += 17;
    line(M, y - 3, R, y - 3, HAIR, 0.5);
  }

  /* ---------- totals block (right, like a real invoice) ---------- */
  y = Math.max(y + 10, H - 168);
  const TX = R - 250;                          // totals label column
  const tot = d.totals;
  TR(TX, y, 8.5, 'Subtotal', { rgb: MUTED }); TR(R, y, 8.5, fmt(tot.subtotal), {}); y += 14;
  if (tot.discount >= 0.5) { TR(TX, y, 8.5, 'Discount', { rgb: MUTED }); TR(R, y, 8.5, `- ${fmt(tot.discount)}`, { rgb: RED }); y += 14; }
  if (tot.tax > 0) { TR(TX, y, 8.5, 'Tax', { rgb: MUTED }); TR(R, y, 8.5, fmt(tot.tax), {}); y += 14; }
  // NET TOTAL band
  y += 4;
  rect(TX - 14, y - 6, R - TX + 14, 26, BRAND_DARK);
  TR(TX, y + 11, 9.5, d.totalLabel || 'NET TOTAL', { bold: true, rgb: [1, 1, 1] });
  TR(R - 12, y + 11, 12, fmt(tot.total), { bold: true, rgb: [1, 1, 1] });
  y += 34;
  TR(R, y, 7.5, `${d.invoice.number} - ${d.currency}`, { rgb: MUTED });

  /* ---------- footer ---------- */
  line(M, H - 42, R, H - 42, HAIR, 1);
  T(M, H - 30, 7.5, d.note ? clip(d.note, 7.5, 560) : '', { rgb: MUTED });
  TR(R, H - 30, 7.5, `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC - system generated`, { rgb: MUTED });
  T(M, H - 18, 7.5, 'Thank you for your business.', { rgb: MUTED });
  pages.push(ops);

  /* ---------- assemble multi-page PDF ---------- */
  const objs = [];
  const firstPageObj = 3;
  const contentObjs = pages.map((_, i) => firstPageObj + pages.length + i);   // content objects after page objects
  objs.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${firstPageObj + i} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((_, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${contentObjs[0] + 1} 0 R /F2 ${contentObjs[0] + 2} 0 R >> >> /Contents ${contentObjs[i]} 0 R >>`);
  });
  pages.forEach((p) => {
    const s = p.join('\n');
    objs.push(`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`);
  });
  objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}

module.exports = { buildPDF, buildXLS, buildCSV, buildInvoicePDF };
