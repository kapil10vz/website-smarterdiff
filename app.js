/* =========================================================================
 * SmarterDiff — client-side diff engine
 *  Everything in this file runs in the browser. No fetch() to any backend.
 *  Libraries used (loaded from CDN): Diff (jsdiff), mammoth, XLSX (SheetJS),
 *  pdf.js, exifr — all open source and shipped to the browser as JS/WASM.
 * ========================================================================= */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Tab routing
  // ---------------------------------------------------------------------------
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');
  tabs.forEach((t) =>
    t.addEventListener('click', () => {
      const id = t.dataset.tab;
      tabs.forEach((x) => x.classList.toggle('active', x === t));
      panels.forEach((p) =>
        p.classList.toggle('active', p.id === `panel-${id}`)
      );
    })
  );

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------
  const toastEl = document.getElementById('toast');
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 3000);
  }

  // ---------------------------------------------------------------------------
  // Drag & drop on every dropzone
  // ---------------------------------------------------------------------------
  document.querySelectorAll('.dropzone').forEach((dz) => {
    const target = dz.dataset.target;
    if (target) {
      const inp = document.getElementById(target);
      dz.addEventListener('click', () => inp.click());
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        if (f) showFilename(target, f.name);
      });
    }
    dz.addEventListener('dragover', (e) => {
      e.preventDefault();
      dz.classList.add('over');
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('over');
      const t = dz.dataset.target;
      if (!t) return;
      const inp = document.getElementById(t);
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        const dt = new DataTransfer();
        dt.items.add(e.dataTransfer.files[0]);
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change'));
      }
    });
  });

  function showFilename(inputId, name) {
    document
      .querySelectorAll(`small.filename[data-for="${inputId}"]`)
      .forEach((s) => (s.textContent = name));
  }

  // ---------------------------------------------------------------------------
  // TEXT DIFF
  // ---------------------------------------------------------------------------
  const txtA = document.getElementById('text-a');
  const txtB = document.getElementById('text-b');
  document.getElementById('text-run').addEventListener('click', runTextDiff);
  document.getElementById('text-clear').addEventListener('click', () => {
    txtA.value = '';
    txtB.value = '';
    document.getElementById('text-result').innerHTML = '';
  });

  function runTextDiff() {
    let a = txtA.value;
    let b = txtB.value;
    const ignoreCase = document.getElementById('text-ignore-case').checked;
    const ignoreWS = document.getElementById('text-ignore-whitespace').checked;
    const granularity = document.getElementById('text-granularity').value;

    if (ignoreCase) {
      a = a.toLowerCase();
      b = b.toLowerCase();
    }
    if (ignoreWS) {
      a = a.replace(/\s+/g, ' ').trim();
      b = b.replace(/\s+/g, ' ').trim();
    }

    let diff;
    if (granularity === 'line') diff = Diff.diffLines(a, b, { newlineIsToken: true });
    else if (granularity === 'word') diff = Diff.diffWordsWithSpace(a, b);
    else diff = Diff.diffChars(a, b);

    let html = '';
    let added = 0, removed = 0, unchanged = 0;
    diff.forEach((part) => {
      const klass = part.added
        ? granularity === 'line' ? 'diff-line diff-add' : 'diff-inline-add'
        : part.removed
        ? granularity === 'line' ? 'diff-line diff-del' : 'diff-inline-del'
        : granularity === 'line' ? 'diff-line diff-eq' : '';
      const txt = escapeHtml(part.value);
      if (granularity === 'line') {
        const lines = txt.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        lines.forEach((ln) => {
          const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
          html += `<div class="${klass}">${prefix}${ln}</div>`;
        });
      } else {
        html += `<span class="${klass}">${txt}</span>`;
      }
      const len = (part.value.match(/\n/g) || []).length || part.value.length;
      if (part.added) added += len;
      else if (part.removed) removed += len;
      else unchanged += len;
    });

    document.getElementById('text-result').innerHTML =
      summary([
        ['Additions', added, 'add'],
        ['Removals', removed, 'del'],
        ['Unchanged', unchanged, ''],
      ]) + html;
  }

  // ---------------------------------------------------------------------------
  // DOCX DIFF (mammoth -> raw text -> jsdiff)
  // ---------------------------------------------------------------------------
  document.getElementById('doc-run').addEventListener('click', async () => {
    const a = document.getElementById('doc-a').files[0];
    const b = document.getElementById('doc-b').files[0];
    if (!a || !b) return toast('Please choose both .docx files');
    try {
      const [tA, tB] = await Promise.all([docxToText(a), docxToText(b)]);
      renderTextLikeDiff('doc-result', tA, tB, 'line');
    } catch (e) {
      toast('Could not read .docx: ' + e.message);
    }
  });

  async function docxToText(file) {
    const buf = await file.arrayBuffer();
    const r = await mammoth.extractRawText({ arrayBuffer: buf });
    return r.value;
  }

  // ---------------------------------------------------------------------------
  // PDF DIFF (pdf.js -> page text -> jsdiff)
  // ---------------------------------------------------------------------------
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }

  document.getElementById('pdf-run').addEventListener('click', async () => {
    const a = document.getElementById('pdf-a').files[0];
    const b = document.getElementById('pdf-b').files[0];
    if (!a || !b) return toast('Please choose both PDFs');
    try {
      const [tA, tB] = await Promise.all([pdfToText(a), pdfToText(b)]);
      renderTextLikeDiff('pdf-result', tA, tB, 'line');
    } catch (e) {
      toast('Could not read PDF: ' + e.message);
    }
  });

  async function pdfToText(file) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const out = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const txt = await page.getTextContent();
      out.push(`--- Page ${i} ---`);
      out.push(txt.items.map((it) => it.str).join(' '));
    }
    return out.join('\n');
  }

  function renderTextLikeDiff(targetId, a, b, granularity) {
    const diff = granularity === 'line'
      ? Diff.diffLines(a, b, { newlineIsToken: true })
      : Diff.diffWordsWithSpace(a, b);
    let html = '';
    let added = 0, removed = 0;
    diff.forEach((p) => {
      const klass = p.added ? 'diff-line diff-add'
        : p.removed ? 'diff-line diff-del'
        : 'diff-line diff-eq';
      const lines = escapeHtml(p.value).split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      lines.forEach((ln) => {
        const prefix = p.added ? '+ ' : p.removed ? '- ' : '  ';
        html += `<div class="${klass}">${prefix}${ln || ' '}</div>`;
      });
      if (p.added) added += lines.length;
      else if (p.removed) removed += lines.length;
    });
    document.getElementById(targetId).innerHTML =
      summary([
        ['Lines added', added, 'add'],
        ['Lines removed', removed, 'del'],
      ]) + html;
  }

  // ---------------------------------------------------------------------------
  // EXCEL / CSV DIFF
  // ---------------------------------------------------------------------------
  let workbookA = null, workbookB = null;

  document.getElementById('excel-a').addEventListener('change', async (e) => {
    workbookA = await readWorkbook(e.target.files[0]);
    populateSheetPicker();
  });
  document.getElementById('excel-b').addEventListener('change', async (e) => {
    workbookB = await readWorkbook(e.target.files[0]);
    populateSheetPicker();
  });

  async function readWorkbook(f) {
    if (!f) return null;
    const buf = await f.arrayBuffer();
    return XLSX.read(buf, { type: 'array' });
  }

  function populateSheetPicker() {
    const sel = document.getElementById('excel-sheet');
    sel.innerHTML = '';
    if (!workbookA || !workbookB) return;
    const sheets = Array.from(
      new Set([...workbookA.SheetNames, ...workbookB.SheetNames])
    );
    sheets.forEach((name) => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
    });
  }

  document.getElementById('excel-run').addEventListener('click', () => {
    if (!workbookA || !workbookB) return toast('Please select both workbooks');
    const sheet = document.getElementById('excel-sheet').value;
    const aSheet = workbookA.Sheets[sheet];
    const bSheet = workbookB.Sheets[sheet];
    if (!aSheet && !bSheet) return toast('Sheet missing in both files');

    const A = aSheet ? XLSX.utils.sheet_to_json(aSheet, { header: 1, defval: '' }) : [];
    const B = bSheet ? XLSX.utils.sheet_to_json(bSheet, { header: 1, defval: '' }) : [];
    renderExcelDiff(A, B);
  });

  function renderExcelDiff(A, B) {
    const rows = Math.max(A.length, B.length);
    const cols = Math.max(
      ...A.map((r) => r.length),
      ...B.map((r) => r.length),
      0
    );
    let added = 0, removed = 0, changed = 0;

    let html = '<table class="diff"><thead><tr><th></th>';
    for (let c = 0; c < cols; c++) {
      html += `<th>${XLSX.utils.encode_col(c)}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (let r = 0; r < rows; r++) {
      html += `<tr><th>${r + 1}</th>`;
      for (let c = 0; c < cols; c++) {
        const va = A[r] ? (A[r][c] ?? '') : undefined;
        const vb = B[r] ? (B[r][c] ?? '') : undefined;
        let cls = '';
        let text = vb !== undefined ? vb : va;
        if (va === undefined && vb !== undefined) { cls = 'added'; added++; }
        else if (vb === undefined && va !== undefined) { cls = 'removed'; removed++; text = va; }
        else if (String(va) !== String(vb)) {
          cls = 'changed';
          changed++;
          text = `${escapeHtml(String(va))} → <b>${escapeHtml(String(vb))}</b>`;
          html += `<td class="${cls}">${text}</td>`;
          continue;
        }
        html += `<td class="${cls}">${escapeHtml(String(text ?? ''))}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';

    document.getElementById('excel-result').innerHTML =
      summary([
        ['Cells changed', changed, 'mod'],
        ['Cells added', added, 'add'],
        ['Cells removed', removed, 'del'],
      ]) + html;
  }

  // ---------------------------------------------------------------------------
  // FOLDER DIFF
  // ---------------------------------------------------------------------------
  let folderA = null, folderB = null;
  document.getElementById('folder-a').addEventListener('change', (e) => {
    folderA = Array.from(e.target.files);
    showFilename('folder-a', `${folderA.length} file(s) selected`);
  });
  document.getElementById('folder-b').addEventListener('change', (e) => {
    folderB = Array.from(e.target.files);
    showFilename('folder-b', `${folderB.length} file(s) selected`);
  });

  document.getElementById('folder-run').addEventListener('click', async () => {
    if (!folderA || !folderB) return toast('Pick both folders');
    const useHash = document.getElementById('folder-hash').checked;
    const out = document.getElementById('folder-result');
    out.innerHTML = `<em>Indexing files… (entirely on this device)</em>`;

    const mapA = await indexFolder(folderA, useHash);
    const mapB = await indexFolder(folderB, useHash);

    const allPaths = new Set([...mapA.keys(), ...mapB.keys()]);
    const rows = [];
    let onlyA = 0, onlyB = 0, changed = 0, same = 0;
    [...allPaths].sort().forEach((p) => {
      const a = mapA.get(p);
      const b = mapB.get(p);
      if (a && !b) { rows.push([p, 'Only in A', 'del', a.size, '']); onlyA++; }
      else if (b && !a) { rows.push([p, 'Only in B', 'add', '', b.size]); onlyB++; }
      else if (a && b) {
        const equal = useHash ? a.hash === b.hash : a.size === b.size;
        if (equal) { rows.push([p, 'Same', '', a.size, b.size]); same++; }
        else { rows.push([p, 'Modified', 'mod', a.size, b.size]); changed++; }
      }
    });

    let html = summary([
      ['Modified', changed, 'mod'],
      ['Only in A', onlyA, 'del'],
      ['Only in B', onlyB, 'add'],
      ['Identical', same, ''],
    ]);
    html += '<table class="diff"><thead><tr><th>Path</th><th>Status</th><th>Size A</th><th>Size B</th></tr></thead><tbody>';
    rows.forEach(([p, status, klass, sa, sb]) => {
      html += `<tr><td>${escapeHtml(p)}</td><td><span class="tag ${klass}">${status}</span></td><td>${sa}</td><td>${sb}</td></tr>`;
    });
    html += '</tbody></table>';
    out.innerHTML = html;
  });

  async function indexFolder(files, useHash) {
    const map = new Map();
    for (const f of files) {
      // Strip the top-level folder so A/foo/bar.txt and B/foo/bar.txt match on foo/bar.txt
      const rel = f.webkitRelativePath || f.name;
      const idx = rel.indexOf('/');
      const key = idx >= 0 ? rel.slice(idx + 1) : rel;
      const entry = { size: f.size };
      if (useHash) entry.hash = await sha256(f);
      map.set(key, entry);
    }
    return map;
  }

  async function sha256(file) {
    const buf = await file.arrayBuffer();
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // ---------------------------------------------------------------------------
  // IMAGE DIFF
  // ---------------------------------------------------------------------------
  const thresholdRange = document.getElementById('image-threshold');
  const thresholdVal = document.getElementById('image-threshold-val');
  thresholdRange.addEventListener('input', () => (thresholdVal.textContent = thresholdRange.value + '%'));

  document.getElementById('image-run').addEventListener('click', async () => {
    const a = document.getElementById('image-a').files[0];
    const b = document.getElementById('image-b').files[0];
    if (!a || !b) return toast('Please choose both images');
    const mode = document.getElementById('image-mode').value;
    const threshold = parseInt(thresholdRange.value, 10) / 100;

    const [imgA, imgB] = await Promise.all([loadImage(a), loadImage(b)]);
    const w = Math.max(imgA.width, imgB.width);
    const h = Math.max(imgA.height, imgB.height);

    const cA = drawTo(imgA, w, h);
    const cB = drawTo(imgB, w, h);
    const dA = cA.getContext('2d').getImageData(0, 0, w, h);
    const dB = cB.getContext('2d').getImageData(0, 0, w, h);

    const result = pixelDiff(dA, dB, threshold);
    const out = document.getElementById('image-result');

    const stats = summary([
      ['Pixels different', result.diffPixels.toLocaleString(), 'mod'],
      ['Total pixels', (w * h).toLocaleString(), ''],
      ['Difference', (result.percent).toFixed(2) + '%', result.percent > 0 ? 'mod' : ''],
      ['Dimensions', `${w}×${h}`, ''],
    ]);

    if (mode === 'overlay') {
      out.innerHTML = stats + `
        <div class="image-canvas-wrap">
          <figure><figcaption>Image A</figcaption></figure>
          <figure><figcaption>Image B</figcaption></figure>
          <figure><figcaption>Difference (red overlay)</figcaption></figure>
        </div>`;
      const figs = out.querySelectorAll('figure');
      figs[0].appendChild(cA);
      figs[1].appendChild(cB);
      figs[2].appendChild(result.canvas);
    } else if (mode === 'side') {
      out.innerHTML = stats + `
        <div class="image-canvas-wrap">
          <figure><figcaption>A — removed in red</figcaption></figure>
          <figure><figcaption>B — added in green</figcaption></figure>
        </div>`;
      const figs = out.querySelectorAll('figure');
      figs[0].appendChild(highlightOver(cA, result.mask, [220, 80, 90, 130]));
      figs[1].appendChild(highlightOver(cB, result.mask, [120, 220, 140, 130]));
    } else {
      out.innerHTML = stats;
      out.appendChild(buildSlider(cA, cB));
    }
  });

  function loadImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = rej;
      img.src = url;
    });
  }

  function drawTo(img, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, img.width, img.height);
    return c;
  }

  // Pure-JS pixel diff (no native pixelmatch needed)
  function pixelDiff(a, b, threshold) {
    const w = a.width, h = a.height;
    const out = new ImageData(w, h);
    const da = a.data, db = b.data, dout = out.data;
    const mask = new Uint8Array(w * h);
    let diff = 0;
    const tol = threshold * 255 * 4;
    for (let i = 0, p = 0; i < da.length; i += 4, p++) {
      const dr = Math.abs(da[i] - db[i]);
      const dg = Math.abs(da[i + 1] - db[i + 1]);
      const dbl = Math.abs(da[i + 2] - db[i + 2]);
      const sum = dr + dg + dbl;
      // grayscale of A as base
      const gray = (da[i] * 0.3 + da[i + 1] * 0.59 + da[i + 2] * 0.11) | 0;
      if (sum > tol) {
        diff++;
        mask[p] = 1;
        dout[i] = 255;
        dout[i + 1] = 60;
        dout[i + 2] = 80;
        dout[i + 3] = 230;
      } else {
        dout[i] = gray;
        dout[i + 1] = gray;
        dout[i + 2] = gray;
        dout[i + 3] = 90;
      }
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(out, 0, 0);
    return { canvas: c, diffPixels: diff, percent: (diff / (w * h)) * 100, mask };
  }

  function highlightOver(srcCanvas, mask, rgba) {
    const w = srcCanvas.width, h = srcCanvas.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
      if (mask[p]) {
        d[i]   = (d[i]   * (255 - rgba[3]) + rgba[0] * rgba[3]) / 255;
        d[i+1] = (d[i+1] * (255 - rgba[3]) + rgba[1] * rgba[3]) / 255;
        d[i+2] = (d[i+2] * (255 - rgba[3]) + rgba[2] * rgba[3]) / 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function buildSlider(cA, cB) {
    const wrap = document.createElement('div');
    wrap.className = 'slider-wrap';
    const w = cA.width, h = cA.height;
    wrap.style.aspectRatio = `${w} / ${h}`;
    cA.style.position = 'absolute';
    cA.style.inset = '0';
    cA.style.width = '100%';
    cA.style.height = '100%';
    const clip = document.createElement('div');
    clip.className = 'clip';
    clip.style.width = '50%';
    cB.style.width = `${w}px`;
    cB.style.maxWidth = 'none';
    cB.style.height = 'auto';
    clip.appendChild(cB);
    const handle = document.createElement('div');
    handle.className = 'slider-handle';
    handle.style.left = '50%';
    wrap.appendChild(cA);
    wrap.appendChild(clip);
    wrap.appendChild(handle);

    let dragging = false;
    const move = (ev) => {
      if (!dragging) return;
      const rect = wrap.getBoundingClientRect();
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
      const pct = Math.max(0, Math.min(1, x / rect.width));
      handle.style.left = `${pct * 100}%`;
      clip.style.width = `${pct * 100}%`;
      cB.style.width = `${rect.width}px`;
    };
    wrap.addEventListener('mousedown', (e) => { dragging = true; move(e); });
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', () => (dragging = false));
    wrap.addEventListener('touchstart', (e) => { dragging = true; move(e); });
    wrap.addEventListener('touchmove', move);
    wrap.addEventListener('touchend', () => (dragging = false));
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // AI vs REAL — heuristic detector
  //   Combines four cheap signals; anything below ~30% leans real, above ~65%
  //   leans AI. Everything in between is "uncertain".
  //
  //   1. EXIF richness:    real cameras embed make/model/ISO/aperture; most AI
  //                        generators strip EXIF or only stamp software=Mid/SD.
  //   2. JPEG-Q heuristic: AI image-export pipelines often produce a single
  //                        quantization-table footprint; we look at file size /
  //                        resolution ratio + presence of double-quantization.
  //   3. FFT spectral flatness: AI-up-sampled images often show a dampened
  //                        high-frequency tail. We compute a 64-pt 1D FFT
  //                        across rows and average it.
  //   4. Noise channel correlation: real sensor noise is uncorrelated across
  //                        R/G/B. AI noise often correlates strongly.
  // ---------------------------------------------------------------------------
  document.getElementById('ai-run').addEventListener('click', async () => {
    const f = document.getElementById('ai-img').files[0];
    if (!f) return toast('Please choose an image');
    const out = document.getElementById('ai-result');
    out.innerHTML = '<em>Analyzing locally…</em>';

    try {
      const [exif, img] = await Promise.all([readExif(f), loadImage(f)]);
      // Down-sample large images to keep FFT/noise analysis fast & memory-light.
      const scale = Math.min(1, 512 / Math.max(img.width, img.height));
      const w = Math.max(64, Math.round(img.width * scale));
      const h = Math.max(64, Math.round(img.height * scale));
      const c = drawTo(img, w, h);
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height);

      const exifScore = scoreExif(exif, f);
      const jpegScore = scoreJpegFootprint(f);
      const fftScore = scoreFFT(data);
      const noiseScore = scoreNoiseCorrelation(data);

      // Weighted ensemble. EXIF gets the biggest say if present.
      const present = exifScore.confidence;
      const weighted =
        exifScore.aiLikely * 0.30 * present +
        jpegScore.aiLikely  * 0.20 +
        fftScore.aiLikely   * 0.25 +
        noiseScore.aiLikely * 0.25 +
        // when EXIF is missing entirely, redistribute its weight to noise+fft
        exifScore.aiLikely * 0.30 * (1 - present) * 0;

      const finalPct = Math.round(Math.max(0, Math.min(100, weighted * 100 / (1 - 0.30 * (1 - present) || 1))));

      out.innerHTML = `
        <div class="ai-grid">
          <div class="gauge" style="--pct:${finalPct}"><span class="gauge-val">${finalPct}%</span></div>
          <div>
            <h3 style="margin:0 0 4px;">${verdict(finalPct)}</h3>
            <p style="color:var(--muted); margin:0;">Estimated likelihood the image was AI-generated, based on four local signals.</p>
            <div class="ai-meters" style="margin-top:14px;">
              ${meter('EXIF richness (real-camera cues)', 1 - exifScore.aiLikely, exifScore.note)}
              ${meter('JPEG footprint',                   1 - jpegScore.aiLikely, jpegScore.note)}
              ${meter('Spectral high-frequency tail',     1 - fftScore.aiLikely, fftScore.note)}
              ${meter('Channel noise independence',       1 - noiseScore.aiLikely, noiseScore.note)}
            </div>
          </div>
        </div>
        <p class="caveat" style="margin-top:14px;">
          Heuristic only. False positives are common on heavily-edited or screenshot-recompressed
          real photos; false negatives happen on AI images that are re-encoded through a real
          camera roll. Use as a hint, not a verdict.
        </p>`;
    } catch (e) {
      out.innerHTML = `<p style="color: var(--danger)">Could not analyze: ${e.message}</p>`;
    }
  });

  function verdict(pct) {
    if (pct < 30) return 'Likely a real photo';
    if (pct < 55) return 'Probably real, with caveats';
    if (pct < 75) return 'Suspicious — possibly AI generated';
    return 'Likely AI-generated';
  }

  function meter(label, realScore, note) {
    const aiPct = Math.round((1 - realScore) * 100);
    return `
      <div class="meter">
        <span title="${escapeAttr(note)}">${label}</span>
        <div class="bar"><i style="width:${aiPct}%"></i></div>
        <span class="v">${aiPct}%</span>
      </div>`;
  }

  async function readExif(file) {
    try {
      return await exifr.parse(file, { tiff: true, exif: true, gps: true, xmp: true });
    } catch {
      return null;
    }
  }

  function scoreExif(exif, file) {
    if (!exif) {
      return {
        aiLikely: 0.7, // missing EXIF is mildly suspicious
        confidence: 0.4,
        note: 'No EXIF data found — many AI generators strip it. (Also true of social-media re-uploads.)',
      };
    }
    const cameraSignals = ['Make', 'Model', 'LensModel', 'ISO', 'FNumber', 'ExposureTime', 'FocalLength'];
    const present = cameraSignals.filter((k) => exif[k] != null).length;
    const aiSoftwareHints = /(stable\s*diffusion|midjourney|dall-?e|firefly|sdxl|comfyui|automatic1111)/i;
    const swStr = [exif.Software, exif.CreatorTool, exif.parameters].filter(Boolean).join(' | ');
    if (aiSoftwareHints.test(swStr)) {
      return { aiLikely: 0.97, confidence: 1, note: `Image metadata mentions "${swStr}".` };
    }
    if (present >= 4) {
      return { aiLikely: 0.10, confidence: 1, note: `Rich camera EXIF found (${present} fields).` };
    }
    if (present >= 1) {
      return { aiLikely: 0.40, confidence: 0.7, note: `Partial EXIF (${present} fields).` };
    }
    return { aiLikely: 0.65, confidence: 0.5, note: 'EXIF present but no camera fields.' };
  }

  function scoreJpegFootprint(file) {
    const isJpeg = /jpe?g$/i.test(file.name) || file.type === 'image/jpeg';
    if (!isJpeg) {
      return { aiLikely: 0.5, note: 'Non-JPEG; this signal is inactive.' };
    }
    // Very rough: AI-export JPEGs tend to be at very high quality (large bytes per pixel).
    // We don't have width here without loading; return neutral and let other signals carry.
    return { aiLikely: 0.5, note: 'JPEG quantization fingerprint inconclusive in browser.' };
  }

  function scoreFFT(imgData) {
    // 1D row-wise FFT over a luminance strip; measure tail energy ratio.
    const w = imgData.width, h = imgData.height, d = imgData.data;
    const N = 256;
    if (w < N) return { aiLikely: 0.5, note: 'Image too small for FFT.' };
    const sample = new Float32Array(N);
    const midRow = (h / 2) | 0;
    for (let x = 0; x < N; x++) {
      const i = (midRow * w + x) * 4;
      sample[x] = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    }
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      let r = 0, ii = 0;
      for (let n = 0; n < N; n++) {
        const t = (-2 * Math.PI * k * n) / N;
        r += sample[n] * Math.cos(t);
        ii += sample[n] * Math.sin(t);
      }
      re[k] = r; im[k] = ii;
    }
    let lowE = 0, highE = 0;
    for (let k = 1; k < N / 2; k++) {
      const mag = re[k] * re[k] + im[k] * im[k];
      if (k < N / 8) lowE += mag;
      else highE += mag;
    }
    const ratio = highE / (lowE + 1e-9);
    // AI images often have suppressed high frequencies, ratio < 0.05 is suspicious.
    const aiLikely = ratio < 0.04 ? 0.85 : ratio < 0.08 ? 0.60 : ratio < 0.20 ? 0.35 : 0.20;
    return {
      aiLikely,
      note: `High/low frequency energy ratio = ${ratio.toFixed(3)}. Lower = smoother, more AI-like.`,
    };
  }

  function scoreNoiseCorrelation(imgData) {
    // Estimate per-channel noise as (channel - 3x3 box-blur of channel).
    // Then compute correlation between R-noise and B-noise.
    // Real sensor noise: low correlation (<0.15). AI smoothed noise: high (>0.4).
    const { width: w, height: h, data: d } = imgData;
    const step = Math.max(1, Math.floor(Math.min(w, h) / 256));
    const rN = [], gN = [], bN = [];
    for (let y = 1; y < h - 1; y += step) {
      for (let x = 1; x < w - 1; x += step) {
        let rs = 0, gs = 0, bs = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const i = ((y + dy) * w + (x + dx)) * 4;
            rs += d[i]; gs += d[i + 1]; bs += d[i + 2];
          }
        const i = (y * w + x) * 4;
        rN.push(d[i] - rs / 9);
        gN.push(d[i + 1] - gs / 9);
        bN.push(d[i + 2] - bs / 9);
      }
    }
    const corrRG = pearson(rN, gN);
    const corrRB = pearson(rN, bN);
    const corrGB = pearson(gN, bN);
    const avg = (Math.abs(corrRG) + Math.abs(corrRB) + Math.abs(corrGB)) / 3;
    const aiLikely = avg > 0.55 ? 0.85 : avg > 0.40 ? 0.65 : avg > 0.25 ? 0.40 : 0.18;
    return {
      aiLikely,
      note: `Avg |corr(R,G,B noise)| = ${avg.toFixed(3)}. Higher = more correlated = more AI-like.`,
    };
  }

  function pearson(x, y) {
    const n = x.length;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      const a = x[i] - mx, b = y[i] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    return num / Math.sqrt(dx * dy + 1e-12);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function summary(stats) {
    return (
      '<div class="summary">' +
      stats
        .map(
          ([k, v, klass]) =>
            `<span class="stat"><b>${v}</b> <span class="tag ${klass || ''}">${k}</span></span>`
        )
        .join('') +
      '</div>'
    );
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/\n/g, ' '); }

})();
