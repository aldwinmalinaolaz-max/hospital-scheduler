// Reads the text on an ID photo with OCR (Tesseract.js), entirely in this browser: the photo is
// not sent anywhere for reading. The OCR files are served from this site (/vendor/tesseract) and
// downloaded the first time only (about 8 MB, then cached by the browser).
const IdOcr = (() => {
  const base = `${location.origin}/vendor/tesseract/`;
  let workerPromise = null;
  let onProgress = null;
  let queue = Promise.resolve();

  const loadScript = () =>
    new Promise((resolve, reject) => {
      if (window.Tesseract) return resolve();
      const s = document.createElement('script');
      s.src = `${base}tesseract.min.js`;
      s.onload = resolve;
      s.onerror = () => reject(new Error('The ID reader could not be loaded.'));
      document.head.appendChild(s);
    });

  function getWorker() {
    if (!workerPromise) {
      workerPromise = (async () => {
        await loadScript();
        return window.Tesseract.createWorker('eng', 1, {
          workerPath: `${base}worker.min.js`,
          corePath: base,
          langPath: `${base}lang`,
          gzip: false,
          logger: (m) => onProgress?.(m),
        });
      })();
      workerPromise.catch(() => (workerPromise = null));
    }
    return workerPromise;
  }

  // Returns the text read from the image (a data URL or image URL). One image at a time.
  function read(image, progress) {
    const job = queue.then(async () => {
      onProgress = progress;
      try {
        const worker = await getWorker();
        const { data } = await worker.recognize(image);
        return data.text || '';
      } finally {
        onProgress = null;
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  // A friendly progress line from Tesseract's log messages
  function progressText(m) {
    if (!m) return 'Reading your ID…';
    if (/loading|initializ/i.test(m.status)) return 'Preparing the ID reader… (first time only, may take a minute on mobile data)';
    if (m.status === 'recognizing text') return `Reading your ID… ${Math.round((m.progress || 0) * 100)}%`;
    return 'Reading your ID…';
  }

  // HTML for the result shown to the requester under their ID photo
  function requesterNote(res) {
    if (!res || !res.status) return '';
    if (res.status === 'MATCH') {
      return '<div class="alert ok small"><b>✓ ID check passed.</b> The name and birthdate on your ID match the patient details you entered.</div>';
    }
    if (res.status === 'UNREADABLE') {
      return `<div class="alert warn small"><b>We could not read your ID.</b> Please retake the photo: front side only, all four corners visible, good light, no glare or blur.
        You can still submit — HHIMS staff will check your ID.</div>`;
    }
    return `<div class="alert warn small"><b>Please check — your ID does not fully match the patient details:</b>
      <ul class="list-tight">${res.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      Make sure the patient's name and birthdate above are spelled exactly as on the ID, or retake a clearer photo of the front of the ID.
      Digital copies are only for the patient's own ID. You can still submit — HHIMS staff will review it, and a mismatch may delay your request.</div>`;
  }

  return { read, progressText, requesterNote };
})();
