// Minimal multi-step form controller. validate(step) returns an error message or ''.
function wizard({ total, validate, onEnter }) {
  let step = 1;
  const errorEl = $('#error');
  function go(n) {
    step = n;
    $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', Number(p.dataset.panel) !== n));
    $$('#steps [data-step]').forEach((s) => {
      const k = Number(s.dataset.step);
      s.className = k === n ? 'on' : k < n ? 'done' : '';
    });
    showError(errorEl, '');
    onEnter?.(n);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $$('[data-next]').forEach((b) =>
    b.addEventListener('click', () => {
      const err = validate(step);
      if (err) return showError(errorEl, err);
      if (step < total) go(step + 1);
    }),
  );
  $$('[data-prev]').forEach((b) => b.addEventListener('click', () => go(step - 1)));
  go(1);
  return { go, get step() { return step; } };
}

function requiredMissing(panel) {
  const missing = $$('[required]', panel).filter((el) => !el.value.trim());
  missing.forEach((el) => el.setAttribute('aria-invalid', 'true'));
  $$('[required]', panel).filter((el) => el.value.trim()).forEach((el) => el.removeAttribute('aria-invalid'));
  if (!missing.length) return '';
  const names = missing.map((el) => el.closest('label')?.querySelector('span')?.textContent || el.name);
  return `Please fill in: ${names.join(', ')}`;
}

function checkMobile(v) {
  const s = v.replace(/[\s\-().]/g, '');
  return /^09\d{9}$/.test(s) || /^\+?639\d{9}$/.test(s) || /^\+\d{10,15}$/.test(s);
}

function checkPastDate(v) {
  return !v || v <= new Date().toLocaleDateString('en-CA');
}
