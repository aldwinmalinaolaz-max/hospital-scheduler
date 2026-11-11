// Compares the text read from an ID photo (OCR) with the patient's name and birthdate.
// Shared by the request page, the Staff Panel (browser) and the server (Node), so all three
// reach the same result. OCR is imperfect, so the result is advice for staff, never a decision.
(function (root) {
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // Statuses, worst first
  const LABELS = {
    MISMATCH: 'Does not match',
    PARTIAL: 'Partly matched',
    UNREADABLE: 'ID not readable',
    MATCH: 'Matches',
  };

  const plain = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // Ñ → N, É → E
      .toUpperCase();
  const words = (s) => plain(s).replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  // Digits that OCR often reads in place of letters in names
  const asLetters = (w) => w.replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B').replace(/6/g, 'G');

  function distance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  // How many wrong letters OCR is allowed for a word of this length
  const allowed = (len) => (len <= 3 ? 0 : len <= 7 ? 1 : 2);
  const close = (want, got) => want === got || distance(want, got) <= allowed(want.length);

  // Is the (possibly multi-word) name somewhere in the OCR words? Also matches when OCR
  // joins or splits the words (DELACRUZ / DELA CRUZ / DE LA CRUZ).
  function findName(name, ocr) {
    const want = words(name);
    if (!want.length) return true;
    if (want.every((w) => ocr.some((o) => close(w, o)))) return true;
    const joined = want.join('');
    for (let i = 0; i < ocr.length; i++) {
      let s = '';
      for (let j = i; j < Math.min(ocr.length, i + 4); j++) {
        s += ocr[j];
        if (close(joined, s)) return true;
      }
    }
    return false;
  }

  const pad = (n) => String(n).padStart(2, '0');
  function validDate(y, m, d) {
    if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(y, m - 1, d);
    return dt.getMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
  }
  const monthNo = (w) => MONTHS.indexOf(w.slice(0, 3)) + 1;

  // Every date printed on the ID, in any of the usual formats (birthdate, issue and expiry dates)
  function findDates(text) {
    const t = plain(text).replace(/[O]/g, (c, i, s) => (/\d/.test(s[i - 1] || '') || /\d/.test(s[i + 1] || '') ? '0' : c));
    const out = new Set();
    const add = (v) => v && out.add(v);
    let m;
    const num = /(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})|(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4})/g;
    while ((m = num.exec(t))) {
      if (m[1]) add(validDate(+m[1], +m[2], +m[3]));
      else {
        add(validDate(+m[6], +m[4], +m[5])); // MM/DD/YYYY
        add(validDate(+m[6], +m[5], +m[4])); // DD/MM/YYYY
      }
    }
    const MON = '(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)';
    const sep = '[\\s.,/-]*';
    const forms = [
      [new RegExp(`${MON}${sep}(\\d{1,2})${sep}(\\d{4})`, 'g'), (x) => validDate(+x[3], monthNo(x[1]), +x[2])],
      [new RegExp(`(\\d{1,2})${sep}${MON}${sep}(\\d{4})`, 'g'), (x) => validDate(+x[3], monthNo(x[2]), +x[1])],
      [new RegExp(`(\\d{4})${sep}${MON}${sep}(\\d{1,2})`, 'g'), (x) => validDate(+x[1], monthNo(x[2]), +x[3])],
    ];
    for (const [re, fn] of forms) while ((m = re.exec(t))) add(fn(m));
    return [...out].sort();
  }

  const longDate = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
  };

  // patient: { last, first, middle, birthdate (YYYY-MM-DD) }
  // Returns { status, label, notes: [..], found: { last, first, middle, birthdate }, dates }
  function check(text, patient) {
    const ocr = words(text).map(asLetters);
    const letters = ocr.join('').replace(/[^A-Z]/g, '').length;
    if (letters < 20) {
      return {
        status: 'UNREADABLE',
        label: LABELS.UNREADABLE,
        notes: ['The text on the ID could not be read. The photo may be blurry, dark, too small or have glare.'],
        found: {},
        dates: [],
      };
    }
    const found = {
      last: findName(patient.last, ocr),
      first: findName(patient.first, ocr),
      middle: patient.middle ? findName(patient.middle, ocr) : null,
    };
    const dates = findDates(text);
    found.birthdate = !!patient.birthdate && dates.includes(patient.birthdate);
    const notes = [];
    const nm = (s) => plain(s).trim();
    if (!found.last) notes.push(`Last name "${nm(patient.last)}" was not found on the ID.`);
    if (!found.first) notes.push(`First name "${nm(patient.first)}" was not found on the ID.`);
    if (patient.middle && !found.middle) notes.push(`Middle name "${nm(patient.middle)}" was not found on the ID (some IDs show only the middle initial).`);
    if (patient.birthdate && !found.birthdate) {
      // Dates before the patient could have an ID are likely birthdates; later ones are issue/expiry dates
      const others = dates.filter((d) => d < `${new Date().getFullYear() - 1}`);
      notes.push(
        others.length
          ? `Birthdate ${longDate(patient.birthdate)} was not found on the ID. Date${others.length > 1 ? 's' : ''} read on the ID: ${others.map(longDate).join('; ')}.`
          : `Birthdate ${longDate(patient.birthdate)} was not found on the ID.`,
      );
    }
    let status = 'MATCH';
    if (!found.last || !found.first) status = 'MISMATCH';
    else if (!found.birthdate) status = 'PARTIAL';
    return { status, label: LABELS[status], notes, found, dates };
  }

  const api = { check, findDates, findName: (name, text) => findName(name, words(text).map(asLetters)), LABELS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IdMatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
