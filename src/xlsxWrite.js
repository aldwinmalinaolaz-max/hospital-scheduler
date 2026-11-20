// A small Excel (.xlsx) writer for the templates staff download (e.g. the past attendance sheet).
// Sheets: { name, rows, cols (widths), freeze: 'D7', merges: ['A1:H1'], validations: [{ sqref, list }] }.
// A cell is text, a number, null, or { v, s } with s one of the styles below; dates are { v: 'YYYY-MM-DD', s: 'date' }.
const JSZip = require('jszip');

const STYLE = { plain: 0, title: 1, head: 2, date: 3, cell: 4, note: 5, name: 6, bold: 7 };
const escXml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
// Days since 1899-12-30 (how Excel stores dates)
const serial = (d) => Math.round((Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000);

function cellXml(c, ref) {
  if (c === null || c === undefined || c === '') return '';
  const o = typeof c === 'object' ? c : { v: c };
  const s = STYLE[o.s] || 0;
  const sa = s ? ` s="${s}"` : '';
  if (o.f) return `<c r="${ref}"${sa}><f>${escXml(o.f)}</f></c>`;
  if (o.v === null || o.v === undefined || o.v === '') return s ? `<c r="${ref}"${sa}/>` : '';
  if (o.s === 'date') return `<c r="${ref}"${sa}><v>${serial(o.v)}</v></c>`;
  if (typeof o.v === 'number') return `<c r="${ref}"${sa}><v>${o.v}</v></c>`;
  return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${escXml(o.v)}</t></is></c>`;
}

function sheetXml(sh) {
  const rows = sh.rows
    .map((r, i) => `<row r="${i + 1}"${sh.heights?.[i + 1] ? ` ht="${sh.heights[i + 1]}" customHeight="1"` : ''}>${(r || []).map((c, j) => cellXml(c, `${colName(j)}${i + 1}`)).join('')}</row>`)
    .join('');
  const cols = sh.cols?.length ? `<cols>${sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  let view = '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  if (sh.freeze) {
    const m = /^([A-Z]+)(\d+)$/.exec(sh.freeze);
    const x = m[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const y = Number(m[2]) - 1;
    view = `<sheetViews><sheetView workbookViewId="0"><pane xSplit="${x}" ySplit="${y}" topLeftCell="${sh.freeze}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>`;
  }
  const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const dv = sh.validations?.length
    ? `<dataValidations count="${sh.validations.length}">${sh.validations
        .map((v) => `<dataValidation type="list" errorStyle="warning" allowBlank="1" showErrorMessage="1" errorTitle="Code" error="Use P, X or an excuse code." sqref="${v.sqref}"><formula1>"${escXml(v.list.join(','))}"</formula1></dataValidation>`)
        .join('')}</dataValidations>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${view}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>${merges}${dv}<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup orientation="portrait" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="mmm d"/></numFmts>
<fonts count="4"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="12"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><i/><sz val="9"/><color rgb="FF555555"/><name val="Arial"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8F1EC"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="2" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" textRotation="90"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// Excel sheet names: at most 31 characters, none of []:*?/\ and unique
function sheetNames(names) {
  const used = new Set();
  return names.map((n) => {
    const base = String(n || 'Sheet').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let name = base;
    for (let i = 2; used.has(name.toUpperCase()); i++) name = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
    used.add(name.toUpperCase());
    return name;
  });
}

async function buildXlsx(sheets) {
  const names = sheetNames(sheets.map((s) => s.name));
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
  );
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${escXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file('xl/styles.xml', STYLES);
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildXlsx, colName, serial };
