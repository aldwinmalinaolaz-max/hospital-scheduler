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
    // Every sheet, found through the workbook's relationships (hidden sheets are marked)
    const relsXml = await read('xl/_rels/workbook.xml.rels');
    const rels = relsXml ? Array.from(xml(relsXml).getElementsByTagName('Relationship')) : [];
    const sst = await read('xl/sharedStrings.xml');
    const shared = sst ? Array.from(xml(sst).getElementsByTagName('si')).map(texts) : [];
    const sheets = [];
    for (const [n, el] of Array.from(xml(wb).getElementsByTagName('sheet')).entries()) {
      const relId = el.getAttribute('r:id') || el.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      let path = `xl/worksheets/sheet${n + 1}.xml`;
      const target = rels.find((r) => r.getAttribute('Id') === relId)?.getAttribute('Target');
      if (target) path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      const sheetXml = await read(path);
      if (!sheetXml) continue;
      sheets.push({ name: el.getAttribute('name') || `Sheet${n + 1}`, hidden: !!el.getAttribute('state') && el.getAttribute('state') !== 'visible', rows: sheetRows(sheetXml, shared) });
    }
    if (!sheets.length) throw new Error('The sheets of this workbook could not be read.');
    const first = sheets.find((x) => !x.hidden) || sheets[0];
    return { sheet: first.name, rows: first.rows, sheets };
  }

  function sheetRows(sheetXml, shared) {
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
      // trailing empty cells are dropped (keeps large sheets small)
      let end = cells.length;
      while (end > 0 && !cells[end - 1]) end--;
      rows[rowNo - 1] = Array.from(cells.slice(0, end), (x) => x ?? '');
    }
    return Array.from(rows, (x) => x || []);
  }

  async function readFile(file) {
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.xls')) throw new Error('Old Excel files (.xls) cannot be read. In Excel choose File → Save As → Excel Workbook (.xlsx), then choose that file.');
    if (name.endsWith('.xlsx') || /spreadsheetml/.test(file.type)) return readXlsx(file);
    const rows = parseDelimited(await file.text());
    return { sheet: null, rows, sheets: [{ name: file.name || 'CSV', hidden: false, rows }] };
  }

  return { readFile, parseDelimited };
})();
