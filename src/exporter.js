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

module.exports = { buildXLS, buildCSV };
