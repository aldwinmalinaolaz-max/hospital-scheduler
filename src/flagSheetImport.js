// Reading past flag ceremony attendance sheets (the HR grid typed in Excel): a NAME OF EMPLOYEE
// column, one column per ceremony date ("Jan. 2", "2-Jan", "1/2", 2026-01-02 or an Excel date)
// and a code per employee and date (P, X or an excuse code such as LEAVE or OB).
// Pure functions; the route in routes/adminFlag.js matches the employees and saves the result.

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad = (n) => String(n).padStart(2, '0');
const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
// "Jan", "JANUARY", "Sept" → 1..12 (the word must be the start of a month's name, so "Remarks" is not March)
const monthOf = (word) => {
  const w = String(word || '').toUpperCase();
  const m = MONTHS[w.slice(0, 3)];
  return m && w.length >= 3 && MONTH_NAMES[m - 1].startsWith(w) ? m : null;
};
// A month heading over the day columns: "JANUARY", "Jan.", "JANUARY 2026", "January, 2026"
function monthTitle(text) {
  const m = /^([A-Za-z]{3,9})\.?,?(?:\s+(\d{4}))?$/.exec(String(text ?? '').trim());
  return m && monthOf(m[1]) ? { month: monthOf(m[1]), year: m[2] ? +m[2] : null } : null;
}
// A day number under a month heading: 1..31 (also "2nd")
const dayNum = (text) => {
  const m = /^(\d{1,2})(?:st|nd|rd|th)?\.?$/i.exec(String(text ?? '').trim());
  return m && +m[1] >= 1 && +m[1] <= 31 ? +m[1] : null;
};
const validDay = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const fullYear = (y) => (y < 100 ? 2000 + y : y);

// A column title read as a date: { month, day, year } (year null when the title has none)
function headerDate(text) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ').replace(/^DATE\s*:?\s*/i, '');
  if (!s) return null;
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s))) return { year: +m[1], month: +m[2], day: +m[3] };
  // Excel stores dates as days since 1899-12-30 (a date-formatted title cell reads as a number)
  if (/^\d{5}(\.\d+)?$/.test(s) && +s > 36000 && +s < 73000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86400000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }
  // Jan. 2 · January 2 · Sept. 13, 2026 · Jan 2 Ret.
  if ((m = /^([A-Za-z]{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?(?:\s+(?:ret|rais)\.?)?$/i.exec(s)) && monthOf(m[1])) {
    return { year: m[3] ? +m[3] : null, month: monthOf(m[1]), day: +m[2] };
  }
  // Jan-02 · January-2-2026
  if ((m = /^([A-Za-z]{3,9})\.?-(\d{1,2})(?:-(\d{2}|\d{4}))?$/.exec(s)) && monthOf(m[1])) {
    return { year: m[3] ? fullYear(+m[3]) : null, month: monthOf(m[1]), day: +m[2] };
  }
  // 2-Jan · 2 Jan 2026 · 02-Jan-26
  if ((m = /^(\d{1,2})[- ]([A-Za-z]{3,9})\.?(?:[- ,]+(\d{2}|\d{4}))?$/.exec(s)) && monthOf(m[2])) {
    return { year: m[3] ? fullYear(+m[3]) : null, month: monthOf(m[2]), day: +m[1] };
  }
  // 1/2 · 1/2/2026 (month first, as in the Philippines)
  if ((m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(s))) return { year: m[3] ? fullYear(+m[3]) : null, month: +m[1], day: +m[2] };
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
    // Excel dates read as numbers (46129) are shown as "Apr. 17" in messages
    const label = /^\d{5}(\.\d+)?$/.test(String(c.label).trim()) ? `${MONTH_NAMES[c.parsed.month - 1].slice(0, 3)}. ${c.parsed.day}` : c.label;
    return { ...c, label, date: ok ? `${yy}-${pad(c.parsed.month)}-${pad(c.parsed.day)}` : null };
  });
}

const NAME_TITLE = /^(NAME|NAMES|NAME OF (THE )?EMPLOYEES?|EMPLOYEES? NAME|EMPLOYEE|FULL ?NAME)$/;
const NO_TITLE = /^(EMP(LOYEE)?\.? ?(NO|NUMBER|ID|#)\.?|ID ?(NO|NUMBER)\.?)$/;
const KNOWN_TITLE = /^(NO\.?|#|NR\.?|DESIGNATION|POSITION|TOTAL.*|UNIT|DIVISION|DEPARTMENT|SECTION|REMARKS?|SIGNATURE|EMPLOYMENT.*|STATUS)$/;
const title = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

// The rows of the sheet (arrays of cell text) → { entries, ignored, problems }. A row with a
// NAME OF EMPLOYEE title starts a table (the printout repeats it for each division); rows without
// any code (division titles, totals, blank rows) are skipped.
// The date columns of a table whose name title is on row i. Dates can be on that row ("Jan. 2"),
// or split over two rows: a month heading (often a merged cell, so it covers the blank cells to
// its right) with day numbers on the row below; up to two rows above and below are read.
function headerColumns(rows, i, nameCol, endCol = Infinity) {
  const get = (r) => (Array.isArray(rows[r]) ? rows[r] : []).map((v) => String(v ?? '').trim());
  const isDateish = (c) => headerDate(c) || monthTitle(c) || dayNum(c);
  const inside = (j) => j > nameCol && j < endCol;
  const above = [i - 2, i - 1].filter((r) => r >= 0 && !get(r)[nameCol] && get(r).some((c, j) => inside(j) && (monthTitle(c) || headerDate(c))));
  const below = [];
  for (const r of [i + 1, i + 2]) {
    const c = get(r);
    if (c[nameCol] || !c.some((x, j) => inside(j) && isDateish(x))) break;
    if (c.some((x, j) => inside(j) && x && !isDateish(x) && !KNOWN_TITLE.test(title(x)))) break; // a data row
    below.push(r);
  }
  const band = [...above, i, ...below];
  const width = Math.min(endCol, Math.max(...band.map((r) => get(r).length)));
  const cols = [];
  for (let j = nameCol + 1; j < width; j++) {
    let found = null;
    for (const [bi, r] of band.entries()) {
      const c = get(r)[j];
      if (!c) continue;
      const full = headerDate(c);
      if (full && !(dayNum(c) && !/[^\d]/.test(c))) {
        found = { col: j, label: c, parsed: full };
        break;
      }
      const day = dayNum(c);
      if (day) {
        // the month: the nearest month heading above, at this column or to its left (merged cell)
        for (const r2 of band.slice(0, bi).reverse()) {
          const row = get(r2);
          let k = j;
          while (k > nameCol && !row[k]) k--;
          const mt = k > nameCol ? monthTitle(row[k]) : null;
          if (mt) {
            found = { col: j, label: `${MONTH_NAMES[mt.month - 1].slice(0, 3)}. ${day}`, parsed: { year: mt.year, month: mt.month, day } };
            break;
          }
        }
        if (found) break;
      }
    }
    if (found) cols.push(found);
  }
  return { cols, skip: below.length, rowsRead: band };
}

// The rows of one sheet (arrays of cell text) → { entries, ignored, problems, found }. A row with a
// NAME OF EMPLOYEE title starts a table (the printout repeats it for each division; some sheets
// have several tables side by side, each with its own name column); rows without any code
// (division titles, totals, blank rows) are skipped. `sheet` names the sheet in messages.
function readGrid(rows, year, sheet = '') {
  const entries = [];
  const ignored = new Set();
  const problems = [];
  const at = (i) => (sheet ? `${sheet}, row ${i + 1}` : `Row ${i + 1}`);
  let heads = null;
  let found = false;
  let skip = 0;
  rows.forEach((raw, i) => {
    if (skip > 0) return void skip--; // the day-number rows of a two-row heading
    const cells = (Array.isArray(raw) ? raw : []).map((v) => String(v ?? '').trim());
    const nameCols = cells.map((c, j) => (NAME_TITLE.test(title(c)) ? j : -1)).filter((j) => j >= 0);
    if (nameCols.length) {
      found = true;
      heads = nameCols.map((nameCol, k) => {
        const end = nameCols[k + 1] ?? Infinity;
        const start = k ? nameCols[k - 1] + 1 : 0;
        const band = headerColumns(rows, i, nameCol, end);
        const dateAt = new Set(band.cols.map((c) => c.col));
        let noCol = null;
        cells.forEach((c, j) => {
          if (j < start || j >= end || j === nameCol || !c || dateAt.has(j)) return;
          const t = title(c);
          if (NO_TITLE.test(t)) noCol = j;
          else if (j > nameCol && !KNOWN_TITLE.test(t) && !monthTitle(c)) ignored.add(c);
        });
        skip = Math.max(skip, band.skip);
        const dates = resolveDates(band.cols, year);
        for (const d of dates) if (!d.date) problems.push(`${at(i)}: “${d.label}” is not a valid date.`);
        if (!dates.length) {
          const seen = band.rowsRead.flatMap((r) => (rows[r] || []).map((v) => String(v ?? '').trim()).filter((v, j) => v && j > nameCol && j < end)).slice(0, 12);
          problems.push(
            `${at(i)}: no ceremony dates were found in the columns after “${cells[nameCol]}”` +
              (seen.length ? ` (titles read there: ${seen.map((v) => `“${v}”`).join(', ')})` : ' (those title cells are empty)') +
              '. Put the dates in the column titles, e.g. Jan. 2, 1/2/2026 or an Excel date, or day numbers (2, 9, 16…) under a month row (JANUARY).',
          );
        }
        return { nameCol, noCol, dates };
      });
      return;
    }
    if (!heads) return;
    // The signature block ("Prepared by:", "Reviewed by:") ends the table: the names under it are signatories
    if (cells.some((c) => /^(PREPARED|REVIEWED|NOTED|CERTIFIED|APPROVED|CHECKED|VERIFIED|SUBMITTED|ATTESTED)\b.*\bBY\b|^CERTIFIED CORRECT/i.test(c))) {
      heads = null;
      return;
    }
    for (const head of heads) {
      const name = cells[head.nameCol] || '';
      const employeeNo = head.noCol == null ? '' : cells[head.noCol] || '';
      if (!name && !employeeNo) continue;
      if (/^(TOTAL|PREPARED|NOTED|CERTIFIED|APPROVED)/i.test(name)) continue;
      // the legend under a table ("Legend:", "X – On duty but did not attend"); employees may follow it
      if (/^LEGEND\b/i.test(name) || (/^[A-Z]{1,8}\s*[–—=:-]\s+\S/i.test(name) && !name.includes(','))) continue;
      const codes = head.dates.map((d) => ({ date: d.date, label: d.label, code: cells[d.col] || '' }));
      if (!codes.some((c) => c.code)) continue;
      entries.push({ line: i + 1, where: at(i), name, employee_no: employeeNo, codes });
    }
  });
  return { entries, ignored: [...ignored], problems, found };
}

// P / X / an excuse code, as typed on the sheet ("O.B.", "leave", "✓")
// How a code is compared: capitals, without spaces and dots ("o.b." = OB, "P M" = PM)
const normCode = (v) => String(v ?? '').toUpperCase().replace(/[\s.]/g, '');
function readCode(v, excuseCodes) {
  const s = normCode(v);
  if (!s) return { kind: 'BLANK' };
  if (['P', 'PRESENT', '1', '/', '✓', '✔', '√'].includes(s)) return { kind: 'P' };
  if (['X', 'A', 'ABSENT', 'ABS'].includes(s)) return { kind: 'X' };
  if (excuseCodes.includes(s)) return { kind: 'EXCUSED', code: s };
  if (s === 'OTHER' && excuseCodes.includes('EXC')) return { kind: 'EXCUSED', code: 'EXC' };
  return null;
}

// Names: "ROJAS-TURCO, HANNAH M." → last ROJASTURCO, first HANNAH (middle initials and Jr./III dropped)
const key = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
const SUFFIX = /^(JR|SR|II|III|IV|V)\.?$/i;
function splitName(text) {
  let s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  // "Barandino. Oliver Paolo G." (a dot typed for the comma)
  if (!s.includes(',')) s = s.replace(/^([^\s.]{3,})\.\s+/, '$1, ');
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
// Without a comma the order is unknown ("Hannah M. Rojas-Turco" or "Esperat Benzeth H."): every
// way of splitting the words into first and last name is tried
function nameReadings(text) {
  const main = splitName(text);
  if (!main) return [];
  let s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s.includes(',')) s = s.replace(/^([^\s.]{3,})\.\s+/, '$1, ');
  if (s.includes(',')) return [main];
  let tokens = s.split(' ').filter((t) => !SUFFIX.test(t));
  while (tokens.length > 2 && /^[A-Za-z]{1,2}\.?$/.test(tokens[tokens.length - 1])) tokens = tokens.slice(0, -1);
  const out = [main];
  for (let k = 1; k < tokens.length; k++) {
    const a = tokens.slice(0, k).filter((t, i, arr) => !(i === arr.length - 1 && arr.length > 1 && /^[A-Za-z]{1,2}\.$/.test(t)));
    const b = tokens.slice(k);
    out.push({ first: key(a.join(' ')), last: key(b.join(' ')) }, { last: key(a.join(' ')), first: key(b.join(' ')) });
  }
  return out;
}
const employeeKey = (e) => {
  let first = String(e.first_name || '').split(' ').filter((t) => t && !SUFFIX.test(t));
  while (first.length > 1 && /^[A-Za-z]{1,2}\.?$/.test(first[first.length - 1])) first = first.slice(0, -1);
  return { last: key(String(e.last_name || '').split(' ').filter((t) => !SUFFIX.test(t)).join(' ')), first: key(first.join(' ')) };
};

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
    const readings = nameReadings(entry.name).filter((n) => n.last);
    if (!readings.length) return {};
    const uniq = (xs) => [...new Map(xs.map((x) => [x.e.id, x])).values()];
    // exact first names first, then a first name that starts the other ("RENE" / "RENE BOY")
    let hits = uniq(readings.flatMap((n) => (byLast.get(n.last) || []).filter((x) => x.first === n.first)));
    if (!hits.length) hits = uniq(readings.flatMap((n) => (n.first ? (byLast.get(n.last) || []).filter((x) => x.first && (x.first.startsWith(n.first) || n.first.startsWith(x.first))) : [])));
    if (!hits.length && !readings[0].first && (byLast.get(readings[0].last) || []).length === 1) hits = byLast.get(readings[0].last);
    if (hits.length === 1) return { employee: hits[0].e };
    return hits.length ? { candidates: hits.map((x) => x.e) } : {};
  };
}

module.exports = { normCode, headerDate, resolveDates, readGrid, readCode, splitName, makeMatcher };
