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

module.exports = { buildPDF, buildXLS, buildCSV };
