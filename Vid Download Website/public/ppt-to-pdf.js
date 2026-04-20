// ─── Render backend URL ───
// Replace with your actual Render URL after deploying
// e.g. https://vera-media-tools-backend.onrender.com
const RENDER_API = window.RENDER_API_URL || 'https://vera-media-tools-backend.onrender.com';

// PPT to PDF — tries Render backend first (LibreOffice quality)
// Falls back to client-side canvas rendering if server unreachable

const dropZone = document.getElementById('ppt-drop');
const fileInput = document.getElementById('ppt-input');
const fileInfo = document.getElementById('ppt-file-info');
const filenameEl = document.getElementById('ppt-filename');
const filesizeEl = document.getElementById('ppt-filesize');
const changeBtn = document.getElementById('ppt-change-btn');
const controlsEl = document.getElementById('ppt-controls');
const convertBtn = document.getElementById('ppt-btn');
const statusNode = document.getElementById('ppt-status');
const progressContainer = document.getElementById('ppt-progress-container');
const progressFill = document.getElementById('ppt-progress-fill');
const progressText = document.getElementById('ppt-progress-text');
const slidesPreview = document.getElementById('ppt-slides-preview');
const slidesGrid = document.getElementById('ppt-slides-grid');

let selectedFile = null;

function setStatus(msg, isError = false) {
  statusNode.textContent = msg;
  statusNode.style.color = isError ? '#a12612' : '';
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

function resetProgress() {
  progressContainer.classList.add('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '0%';
}

function setProgress(pct, label) {
  progressContainer.classList.remove('hidden');
  progressFill.style.width = pct + '%';
  progressText.textContent = label || pct + '%';
}

async function loadFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.pptx')) {
    setStatus('Please select a valid .pptx file.', true);
    return;
  }
  selectedFile = file;
  filenameEl.textContent = file.name;
  filesizeEl.textContent = `Size: ${fmtSize(file.size)}`;
  dropZone.classList.add('hidden');
  fileInfo.classList.remove('hidden');
  controlsEl.classList.remove('hidden');
  setStatus('File loaded. Click Convert to PDF.');
}

// Drop zone
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

// Upload Another
changeBtn.addEventListener('click', () => {
  fileInput.value = '';
  selectedFile = null;
  fileInfo.classList.add('hidden');
  controlsEl.classList.add('hidden');
  slidesPreview.classList.add('hidden');
  slidesGrid.innerHTML = '';
  dropZone.classList.remove('hidden');
  resetProgress();
  setStatus('Select a PPTX file to begin.');
});

// ─── Convert via Render backend ───
async function convertViaServer(file) {
  setProgress(10, 'Uploading to server…');
  setStatus('Uploading file to server (LibreOffice quality)…');

  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${RENDER_API}/api/ppt-to-pdf`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Server error' }));
    throw new Error(err.error || `Server returned ${response.status}`);
  }

  setProgress(80, 'Downloading PDF…');

  const blob = await response.blob();
  const outputName = file.name.replace(/\.pptx$/i, '.pdf');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = outputName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  setProgress(100, 'Complete!');
  setStatus(`✅ PDF downloaded! (${fmtSize(blob.size)}) — converted via LibreOffice`);
  setTimeout(resetProgress, 4000);
}

// ─── Client-side fallback (Canvas + jsPDF) ───
async function convertClientSide(file) {
  setProgress(5, 'Reading file…');
  setStatus('Converting in browser (client-side)…');

  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  setProgress(15, 'Parsing slides…');

  const presXml = await zip.file('ppt/presentation.xml')?.async('text');
  if (!presXml) throw new Error('Invalid PPTX file — missing presentation.xml');

  const presDoc = new DOMParser().parseFromString(presXml, 'application/xml');
  const sldSz = presDoc.querySelector('sldSz');
  const slideW = sldSz ? parseInt(sldSz.getAttribute('cx')) : 9144000;
  const slideH = sldSz ? parseInt(sldSz.getAttribute('cy')) : 6858000;
  const slideWPx = slideW / 914400 * 96;
  const slideHPx = slideH / 914400 * 96;

  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => parseInt(a.match(/slide(\d+)/)[1]) - parseInt(b.match(/slide(\d+)/)[1]));

  if (slideFiles.length === 0) throw new Error('No slides found in PPTX file.');

  const mediaFiles = {};
  for (const mf of Object.keys(zip.files).filter(f => f.startsWith('ppt/media/'))) {
    const blob = await zip.file(mf).async('blob');
    mediaFiles[mf.split('/').pop()] = URL.createObjectURL(blob);
  }

  async function getSlideRels(num) {
    const relsFile = zip.file(`ppt/slides/_rels/slide${num}.xml.rels`);
    if (!relsFile) return {};
    const doc = new DOMParser().parseFromString(await relsFile.async('text'), 'application/xml');
    const rels = {};
    doc.querySelectorAll('Relationship').forEach(r => {
      rels[r.getAttribute('Id')] = r.getAttribute('Target').replace('../', '').replace('media/', '');
    });
    return rels;
  }

  function parseColor(node) {
    if (!node) return '#000000';
    const s = node.querySelector('srgbClr');
    if (s) return '#' + s.getAttribute('val');
    const sc = node.querySelector('schemeClr');
    if (sc) {
      const m = { dk1:'#000000',lt1:'#FFFFFF',accent1:'#4472C4',accent2:'#ED7D31',tx1:'#000000',bg1:'#FFFFFF' };
      return m[sc.getAttribute('val')] || '#333333';
    }
    return '#000000';
  }

  const canvases = [];
  slidesGrid.innerHTML = '';

  for (let i = 0; i < slideFiles.length; i++) {
    setProgress(15 + (i / slideFiles.length) * 60, `Rendering slide ${i+1}/${slideFiles.length}…`);

    const slideDoc = new DOMParser().parseFromString(await zip.file(slideFiles[i]).async('text'), 'application/xml');
    const rels = await getSlideRels(i + 1);
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = slideWPx * scale;
    canvas.height = slideHPx * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, slideWPx, slideHPx);
    const bgFill = slideDoc.querySelector('bg > bgPr > solidFill');
    if (bgFill) { ctx.fillStyle = parseColor(bgFill); ctx.fillRect(0, 0, slideWPx, slideHPx); }

    const shapes = slideDoc.querySelectorAll('spTree > sp, spTree > pic');
    for (const shape of shapes) {
      const off = shape.querySelector('off');
      const ext = shape.querySelector('ext');
      if (!off || !ext) continue;
      const x = parseInt(off.getAttribute('x')||0)/914400*96;
      const y = parseInt(off.getAttribute('y')||0)/914400*96;
      const w = parseInt(ext.getAttribute('cx')||0)/914400*96;
      const h = parseInt(ext.getAttribute('cy')||0)/914400*96;
      const blip = shape.querySelector('blipFill > blip');
      if (blip) {
        const id = blip.getAttribute('r:embed') || blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','embed');
        if (id && rels[id] && mediaFiles[rels[id]]) {
          try {
            const img = await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=mediaFiles[rels[id]]; });
            ctx.drawImage(img, x, y, w, h);
          } catch {}
        }
        continue;
      }
      const sf = shape.querySelector('spPr > solidFill');
      if (sf) { ctx.fillStyle = parseColor(sf); ctx.fillRect(x, y, w, h); }
      const txBody = shape.querySelector('txBody');
      if (txBody) {
        let ty = y + 8;
        txBody.querySelectorAll('p').forEach(p => {
          let text = '', sz = 18, color = '#000', bold = false, italic = false;
          p.querySelectorAll('r').forEach(r => {
            const rPr = r.querySelector('rPr');
            const t = r.querySelector('t');
            if (!t) return;
            if (rPr) {
              sz = rPr.getAttribute('sz') ? parseInt(rPr.getAttribute('sz'))/100 : sz;
              bold = rPr.getAttribute('b') === '1';
              italic = rPr.getAttribute('i') === '1';
              const fc = rPr.querySelector('solidFill');
              if (fc) color = parseColor(fc);
            }
            text += t.textContent;
          });
          if (text.trim()) {
            ctx.font = `${italic?'italic ':''}${bold?'bold ':''}${sz}px Arial, sans-serif`;
            ctx.fillStyle = color;
            ctx.textBaseline = 'top';
            const words = text.split(' ');
            let line = '';
            const lh = sz * 1.3;
            for (const word of words) {
              const test = line + (line?' ':'') + word;
              if (ctx.measureText(test).width > w-16 && line) { ctx.fillText(line, x+8, ty); ty += lh; line = word; }
              else line = test;
            }
            if (line) { ctx.fillText(line, x+8, ty); ty += lh; }
          } else { ty += sz*1.3; }
        });
      }
    }

    canvases.push(canvas);
    const thumb = document.createElement('div');
    thumb.className = 'ppt-slide-thumb';
    thumb.innerHTML = `<span class="ppt-slide-num">${i+1}</span>`;
    const tc = document.createElement('canvas');
    tc.width = 200;
    tc.height = Math.round(200 * slideHPx / slideWPx);
    tc.getContext('2d').drawImage(canvas, 0, 0, tc.width, tc.height);
    thumb.prepend(tc);
    slidesGrid.appendChild(thumb);
  }

  slidesPreview.classList.remove('hidden');
  setProgress(80, 'Building PDF…');

  const { jsPDF } = window.jspdf;
  const pdfW = slideWPx * 0.75, pdfH = slideHPx * 0.75;
  const pdf = new jsPDF({ unit: 'pt', format: [pdfW, pdfH] });
  for (let i = 0; i < canvases.length; i++) {
    if (i > 0) pdf.addPage([pdfW, pdfH]);
    pdf.addImage(canvases[i].toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pdfW, pdfH);
    setProgress(80 + (i/canvases.length*18), `Page ${i+1}…`);
  }

  pdf.save(file.name.replace(/\.pptx$/i, '.pdf'));
  Object.values(mediaFiles).forEach(u => URL.revokeObjectURL(u));
  setProgress(100, 'Complete!');
  setStatus(`✅ PDF generated (${canvases.length} slides) — browser mode`);
  setTimeout(resetProgress, 4000);
}

// ─── Main convert handler ───
convertBtn.addEventListener('click', async () => {
  if (!selectedFile) { setStatus('Please upload a file first.', true); return; }
  convertBtn.disabled = true;
  changeBtn.disabled = true;

  try {
    // Try Render backend first (better quality via LibreOffice)
    try {
      await convertViaServer(selectedFile);
    } catch (serverErr) {
      console.warn('Server conversion failed, falling back to browser:', serverErr.message);
      setStatus('Server busy, switching to browser mode…');
      await convertClientSide(selectedFile);
    }
  } catch (err) {
    setStatus('Conversion failed: ' + (err.message || err), true);
    resetProgress();
  } finally {
    convertBtn.disabled = false;
    changeBtn.disabled = false;
  }
});

function loadImageAsync(src) {
  return new Promise((res, rej) => { const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=src; });
}
