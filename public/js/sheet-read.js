// Reads a spreadsheet chosen in the browser: Excel (.xlsx, first sheet) or CSV / tab-separated
// text. Returns the rows as arrays of text. Excel files are unzipped with JSZip (served from
// /vendor/jszip) and read with the browser's XML parser; nothing is uploaded until imported.
const SheetRead = (() => {
  const loadZip = () =>
    new Promise((resolve, reject) => {
      if (window.JSZip) return resolve(window.JSZip);
      const s = document.createElement('script');
      s.src = '/vendor/jszip/jszip.min.js';
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => reject(new Error('The Excel reader could not be loaded. Check the connection and try again.'));
      document.head.appendChild(s);
    });

  // CSV or tab-separated text (as copied from Excel), with quoted cells
  function parseDelimited(text) {
    const src = String(text || '').replace(/^﻿/, '');
    const sep = (src.split('\n')[0].match(/\t/g) || []).length > (src.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"' && src[i + 1] === '"') (cell += '"'), i++;
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"' && cell === '') quoted = true;
      else if (c === sep) row.push(cell), (cell = '');
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += c;
    }
    row.push(cell);
    rows.push(row);
    return rows.map((r) => r.map((x) => x.trim()));
  }

  const colIndex = (ref) => {
    const letters = /^[A-Z]+/.exec(ref || '')?.[0] || 'A';
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const xml = (text) => new DOMParser().parseFromString(text, 'application/xml');
  const texts = (node) => Array.from(node.getElementsByTagName('t')).map((t) => t.textContent).join('');

  async function readXlsx(file) {
    const JSZip = await loadZip();
    let zip;
    try {
      zip = await JSZip.loadAsync(file);
    } catch {
      throw new Error('This file could not be opened as an Excel workbook (.xlsx).');
    }
    const read = async (path) => (zip.file(path) ? zip.file(path).async('string') : null);
    const wb = await read('xl/workbook.xml');
    if (!wb) throw new Error('This file is not an Excel workbook (.xlsx).');
    // The first sheet, found through the workbook's relationships
    const firstSheet = xml(wb).getElementsByTagName('sheet')[0];
    const relId = firstSheet?.getAttribute('r:id') || firstSheet?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let path = 'xl/worksheets/sheet1.xml';
    const rels = await read('xl/_rels/workbook.xml.rels');
    if (rels && relId) {
      const rel = Array.from(xml(rels).getElementsByTagName('Relationship')).find((r) => r.getAttribute('Id') === relId);
      const target = rel?.getAttribute('Target');
      if (target) path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    }
    const sheetXml = await read(path);
    if (!sheetXml) throw new Error('The first sheet of this workbook could not be read.');
    const sst = await read('xl/sharedStrings.xml');
    const shared = sst ? Array.from(xml(sst).getElementsByTagName('si')).map(texts) : [];
    const rows = [];
    for (const r of Array.from(xml(sheetXml).getElementsByTagName('row'))) {
      const rowNo = Number(r.getAttribute('r')) || rows.length + 1;
      const cells = [];
      for (const c of Array.from(r.getElementsByTagName('c'))) {
        const t = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
        let value;
        if (t === 's') value = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') value = texts(c);
        else if (t === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else value = v;
        cells[colIndex(c.getAttribute('r'))] = String(value).trim();
      }
      rows[rowNo - 1] = Array.from(cells, (x) => x ?? '');
    }
    return { sheet: firstSheet?.getAttribute('name') || 'Sheet1', rows: Array.from(rows, (x) => x || []) };
  }

  async function readFile(file) {
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.xls')) throw new Error('Old Excel files (.xls) cannot be read. In Excel choose File → Save As → Excel Workbook (.xlsx), then choose that file.');
    if (name.endsWith('.xlsx') || /spreadsheetml/.test(file.type)) return readXlsx(file);
    return { sheet: null, rows: parseDelimited(await file.text()) };
  }

  return { readFile, parseDelimited };
})();
