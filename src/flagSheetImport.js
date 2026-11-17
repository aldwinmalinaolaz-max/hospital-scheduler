// Reading past flag ceremony attendance sheets (the HR grid typed in Excel): a NAME OF EMPLOYEE
// column, one column per ceremony date ("Jan. 2", "2-Jan", "1/2", 2026-01-02 or an Excel date)
// and a code per employee and date (P, X or an excuse code such as LEAVE or OB).
// Pure functions; the route in routes/adminFlag.js matches the employees and saves the result.

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad = (n) => String(n).padStart(2, '0');
const monthOf = (word) => MONTHS[String(word || '').toUpperCase().slice(0, 3)] || null;
const validDay = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const fullYear = (y) => (y < 100 ? 2000 + y : y);

// A column title read as a date: { month, day, year } (year null when the title has none)
function headerDate(text) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s))) return { year: +m[1], month: +m[2], day: +m[3] };
  // Excel stores dates as days since 1899-12-30 (a date-formatted title cell reads as a number)
  if (/^\d{5}(\.0+)?$/.test(s) && +s > 36000 && +s < 73000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86400000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }
  // Jan. 2 · January 2 · Sept. 13, 2026 · Jan 2 Ret.
  if ((m = /^([A-Za-z]{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?(?:\s+(?:ret|rais)\.?)?$/i.exec(s)) && monthOf(m[1])) {
    return { year: m[3] ? +m[3] : null, month: monthOf(m[1]), day: +m[2] };
  }
  // 2-Jan · 2 Jan 2026 · 02-Jan-26
  if ((m = /^(\d{1,2})[- ]([A-Za-z]{3,9})\.?(?:[- ,]+(\d{2}|\d{4}))?$/.exec(s)) && monthOf(m[2])) {
    return { year: m[3] ? fullYear(+m[3]) : null, month: monthOf(m[2]), day: +m[1] };
  }
  // 1/2 · 1/2/2026 (month first, as in the Philippines)
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(s))) return { year: m[3] ? fullYear(+m[3]) : null, month: +m[1], day: +m[2] };
  return null;
}

// Gives each date column its date: titles without a year take the chosen year, moving to the next
// year when the months go back (a sheet from December to January)
function resolveDates(cols, year) {
  let y = year;
  let lastMonth = 0;
  return cols.map((c) => {
    if (c.parsed.year) {
      y = c.parsed.year;
    } else if (c.parsed.month < lastMonth) y++;
    lastMonth = c.parsed.month;
    const yy = c.parsed.year || y;
    const ok = validDay(yy, c.parsed.month, c.parsed.day);
    return { ...c, date: ok ? `${yy}-${pad(c.parsed.month)}-${pad(c.parsed.day)}` : null };
  });
}

const NAME_TITLE = /^(NAME|NAMES|NAME OF (THE )?EMPLOYEES?|EMPLOYEES? NAME|EMPLOYEE|FULL ?NAME)$/;
const NO_TITLE = /^(EMP(LOYEE)?\.? ?(NO|NUMBER|ID|#)\.?|ID ?(NO|NUMBER)\.?)$/;
const KNOWN_TITLE = /^(NO\.?|#|NR\.?|DESIGNATION|POSITION|TOTAL.*|UNIT|DIVISION|DEPARTMENT|SECTION|REMARKS?|SIGNATURE|EMPLOYMENT.*|STATUS)$/;
const title = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

// The rows of the sheet (arrays of cell text) → { entries, ignored, problems }. A row with a
// NAME OF EMPLOYEE title starts a table (the printout repeats it for each division); rows without
// any code (division titles, totals, blank rows) are skipped.
function readGrid(rows, year) {
  const entries = [];
  const ignored = new Set();
  const problems = [];
  let head = null;
  rows.forEach((raw, i) => {
    const cells = (Array.isArray(raw) ? raw : []).map((v) => String(v ?? '').trim());
    const nameCol = cells.findIndex((c) => NAME_TITLE.test(title(c)));
    if (nameCol >= 0) {
      const dateCols = [];
      let noCol = null;
      cells.forEach((c, j) => {
        if (j === nameCol || !c) return;
        const t = title(c);
        if (NO_TITLE.test(t)) noCol = j;
        else if (KNOWN_TITLE.test(t)) return;
        else {
          const parsed = headerDate(c);
          if (parsed) dateCols.push({ col: j, label: c, parsed });
          else ignored.add(c);
        }
      });
      head = { nameCol, noCol, dates: resolveDates(dateCols, year), line: i + 1 };
      for (const d of head.dates) if (!d.date) problems.push(`Row ${i + 1}: “${d.label}” is not a valid date.`);
      if (!head.dates.length) problems.push(`Row ${i + 1}: no date columns were found next to the name column.`);
      return;
    }
    if (!head) return;
    const name = cells[head.nameCol] || '';
    const employeeNo = head.noCol == null ? '' : cells[head.noCol] || '';
    if (!name && !employeeNo) return;
    if (/^(TOTAL|PREPARED|NOTED|CERTIFIED|APPROVED)/i.test(name)) return;
    const codes = head.dates.map((d) => ({ date: d.date, label: d.label, code: cells[d.col] || '' }));
    if (!codes.some((c) => c.code)) return;
    entries.push({ line: i + 1, name, employee_no: employeeNo, codes });
  });
  return { entries, ignored: [...ignored], problems, found: !!head };
}

// P / X / an excuse code, as typed on the sheet ("O.B.", "leave", "✓")
function readCode(v, excuseCodes) {
  const s = String(v ?? '').toUpperCase().replace(/[\s.]/g, '');
  if (!s) return { kind: 'BLANK' };
  if (['P', 'PRESENT', '/', '✓', '✔', '√'].includes(s)) return { kind: 'P' };
  if (['X', 'A', 'ABSENT', 'ABS'].includes(s)) return { kind: 'X' };
  if (excuseCodes.includes(s)) return { kind: 'EXCUSED', code: s };
  if (s === 'OTHER' && excuseCodes.includes('EXC')) return { kind: 'EXCUSED', code: 'EXC' };
  return null;
}

// Names: "ROJAS-TURCO, HANNAH M." → last ROJASTURCO, first HANNAH (middle initials and Jr./III dropped)
const key = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
const SUFFIX = /^(JR|SR|II|III|IV|V)\.?$/i;
function splitName(text) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const strip = (tokens) => tokens.filter((t) => !SUFFIX.test(t.replace(/,$/, '')));
  if (s.includes(',')) {
    const [last, ...rest] = s.split(',');
    let first = strip(rest.join(' ').trim().split(' ').filter(Boolean));
    // trailing middle initials ("M.", "DC.") when the first name has more than that
    while (first.length > 1 && /^[A-Za-z]{1,2}\.?$/.test(first[first.length - 1])) first = first.slice(0, -1);
    return { last: key(strip(last.trim().split(' ')).join(' ')), first: key(first.join(' ')) };
  }
  let tokens = strip(s.split(' '));
  if (tokens.length < 2) return { last: key(s), first: '' };
  const last = tokens[tokens.length - 1];
  tokens = tokens.slice(0, -1);
  while (tokens.length > 1 && /^[A-Za-z]{1,2}\.?$/.test(tokens[tokens.length - 1])) tokens = tokens.slice(0, -1);
  return { last: key(last), first: key(tokens.join(' ')) };
}
const employeeKey = (e) => ({
  last: key(String(e.last_name || '').split(' ').filter((t) => !SUFFIX.test(t)).join(' ')),
  first: key(String(e.first_name || '').split(' ').filter((t) => !SUFFIX.test(t)).join(' ')),
});

// Finds the employee for a sheet row → { employee } | { candidates } (several) | {} (none)
function makeMatcher(employees, cleanNo) {
  const byNo = new Map(employees.map((e) => [e.employee_no, e]));
  const byLast = new Map();
  for (const e of employees) {
    const k = employeeKey(e);
    if (!byLast.has(k.last)) byLast.set(k.last, []);
    byLast.get(k.last).push({ e, first: k.first });
  }
  return (entry) => {
    if (entry.employee_no) {
      const e = byNo.get(cleanNo(entry.employee_no) || entry.employee_no);
      if (e) return { employee: e };
    }
    const n = splitName(entry.name);
    if (!n || !n.last) return {};
    const same = byLast.get(n.last) || [];
    let hits = same.filter((x) => x.first === n.first);
    if (!hits.length && n.first) hits = same.filter((x) => x.first && (x.first.startsWith(n.first) || n.first.startsWith(x.first)));
    if (!hits.length && !n.first && same.length === 1) hits = same;
    if (hits.length === 1) return { employee: hits[0].e };
    return hits.length ? { candidates: hits.map((x) => x.e) } : {};
  };
}

module.exports = { headerDate, resolveDates, readGrid, readCode, splitName, makeMatcher };
