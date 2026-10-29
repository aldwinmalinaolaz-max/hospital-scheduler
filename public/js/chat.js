// FAQ assistant chat window for the public pages.
(() => {
  const ICON_CHAT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  const ICON_SEND =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';

  const root = document.createElement('div');
  root.className = 'chat no-print';
  root.innerHTML = `
    <button type="button" class="chat-toggle" aria-expanded="false" aria-controls="chatPanel">${ICON_CHAT}<span>Questions? Ask us</span></button>
    <section class="chat-panel" id="chatPanel" role="dialog" aria-label="Frequently asked questions" hidden>
      <header class="chat-head">
        <img src="/img/logo.png" alt="" width="34" height="34">
        <div><b>FAQ Assistant</b><small>Answers to common questions</small></div>
        <button type="button" class="chat-close" aria-label="Close">${ICON_CLOSE}</button>
      </header>
      <div class="chat-log" aria-live="polite"></div>
      <form class="chat-form" autocomplete="off">
        <input type="text" name="q" maxlength="300" placeholder="Type your question…" aria-label="Type your question" data-nocaps>
        <button type="submit" aria-label="Send">${ICON_SEND}</button>
      </form>
    </section>`;
  document.body.appendChild(root);

  const toggle = root.querySelector('.chat-toggle');
  const panel = root.querySelector('.chat-panel');
  const log = root.querySelector('.chat-log');
  const form = root.querySelector('.chat-form');
  const input = form.q;
  let started = false;

  function addBubble(who, text) {
    const div = document.createElement('div');
    div.className = `chat-msg ${who}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function addLink(bubble, link) {
    const a = document.createElement('a');
    a.className = 'chat-link';
    a.href = link.url;
    a.textContent = `${link.label} →`;
    if (/^https:/i.test(link.url)) (a.target = '_blank'), (a.rel = 'noopener');
    bubble.appendChild(a);
  }

  function addChips(title, questions) {
    if (!questions?.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'chat-chips';
    if (title) {
      const p = document.createElement('p');
      p.textContent = title;
      wrap.appendChild(p);
    }
    for (const q of questions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = q.question;
      b.addEventListener('click', () => ask({ faq_id: q.id }, q.question));
      wrap.appendChild(b);
    }
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
  }

  async function ask(body, shown) {
    addBubble('me', shown);
    const typing = addBubble('bot typing', '…');
    try {
      const r = await api('/faq/ask', { method: 'POST', body });
      typing.remove();
      const bubble = addBubble('bot', r.answer);
      if (r.link) addLink(bubble, r.link);
      addChips(r.matched ? 'Related questions' : 'You might be looking for', r.related);
    } catch (err) {
      typing.remove();
      addBubble('bot', err.message || 'Sorry, something went wrong. Please try again.');
    }
  }

  async function start() {
    started = true;
    addBubble('bot', 'Hi! I can answer common questions about requesting medical records and OPD appointments. Choose a question or type your own.');
    try {
      const { questions } = await api('/faq');
      addChips('', questions.slice(0, 6));
    } catch {
      // Suggestions are optional; typing still works
    }
  }

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    root.classList.toggle('open', open);
    if (open) {
      if (!started) start();
      input.focus();
    } else {
      toggle.focus();
    }
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden));
  root.querySelector('.chat-close').addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', (e) => e.key === 'Escape' && setOpen(false));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    ask({ message: text }, text);
  });
})();
