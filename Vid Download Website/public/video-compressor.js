// Video Compressor — client-side logic
const $ = (id) => document.getElementById(id);

// Source tabs
const tabUpload = $('vc-tab-upload');
const tabUrl = $('vc-tab-url');
const srcUpload = $('vc-source-upload');
const srcUrl = $('vc-source-url');

// Upload elements
const dropZone = $('vc-drop-zone');
const fileInput = $('vc-file-input');
const fileInfo = $('vc-file-info');
const filenameEl = $('vc-filename');
const originalSizeEl = $('vc-original-size');
const changeBtn = $('vc-change-btn');

// URL elements
const urlInput = $('vc-url-input');
const fetchBtn = $('vc-fetch-btn');
const urlInfo = $('vc-url-info');
const urlTitle = $('vc-url-title');
const urlDuration = $('vc-url-duration');

// Compression controls
const controls = $('vc-controls');
const modeTarget = $('vc-mode-target');
const modePercent = $('vc-mode-percent');
const modeCrf = $('vc-mode-crf');
const panelTarget = $('vc-panel-target');
const panelPercent = $('vc-panel-percent');
const panelCrf = $('vc-panel-crf');
const targetMbInput = $('vc-target-mb');
const reducePctInput = $('vc-reduce-pct');
const pctHint = $('vc-pct-hint');
const crfSlider = $('vc-crf-slider');
const crfVal = $('vc-crf-val');
const crfDesc = $('vc-crf-desc');
const compressBtn = $('vc-compress-btn');

// Progress
const progressContainer = $('vc-progress-container');
const progressFill = $('vc-progress-fill');
const progressText = $('vc-progress-text');

// Status + result
const statusNode = $('vc-status');
const resultSection = $('vc-result');
const resultOriginal = $('vc-result-original');
const resultCompressed = $('vc-result-compressed');
const savingsText = $('vc-savings-text');

let selectedFile = null;
let originalBytes = 0;
let currentSource = 'upload'; // 'upload' | 'url'
let currentMode = 'target'; // 'target' | 'percent' | 'crf'
let urlMetadata = null;

function fmt(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

function setStatus(msg, isError = false) {
  statusNode.textContent = msg;
  statusNode.style.color = isError ? '#a12612' : '';
}

function formatDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── Source Tab Switching ───
tabUpload.addEventListener('click', () => {
  currentSource = 'upload';
  tabUpload.classList.add('active');
  tabUrl.classList.remove('active');
  srcUpload.classList.remove('hidden');
  srcUrl.classList.add('hidden');
  // Show controls if file is loaded
  if (selectedFile) controls.classList.remove('hidden');
  else controls.classList.add('hidden');
  resultSection.classList.add('hidden');
});

tabUrl.addEventListener('click', () => {
  currentSource = 'url';
  tabUrl.classList.add('active');
  tabUpload.classList.remove('active');
  srcUrl.classList.remove('hidden');
  srcUpload.classList.add('hidden');
  // Show controls if URL metadata is loaded
  if (urlMetadata) controls.classList.remove('hidden');
  else controls.classList.add('hidden');
  resultSection.classList.add('hidden');
});

// ─── Mode Tab Switching ───
function switchMode(mode) {
  currentMode = mode;
  [modeTarget, modePercent, modeCrf].forEach(btn => btn.classList.remove('active'));
  [panelTarget, panelPercent, panelCrf].forEach(p => p.classList.add('hidden'));
  if (mode === 'target') { modeTarget.classList.add('active'); panelTarget.classList.remove('hidden'); }
  if (mode === 'percent') { modePercent.classList.add('active'); panelPercent.classList.remove('hidden'); updatePctHint(); }
  if (mode === 'crf') { modeCrf.classList.add('active'); panelCrf.classList.remove('hidden'); }
}

modeTarget.addEventListener('click', () => switchMode('target'));
modePercent.addEventListener('click', () => switchMode('percent'));
modeCrf.addEventListener('click', () => switchMode('crf'));

// ─── CRF Slider ───
function updateCrfDesc() {
  const v = parseInt(crfSlider.value);
  crfVal.textContent = v;
  if (v <= 22) crfDesc.textContent = '(Near-lossless, larger file)';
  else if (v <= 28) crfDesc.textContent = '(Great quality — recommended)';
  else if (v <= 35) crfDesc.textContent = '(Good quality, much smaller)';
  else if (v <= 42) crfDesc.textContent = '(Decent, very small file)';
  else crfDesc.textContent = '(Low quality, tiny file)';
}
crfSlider.addEventListener('input', updateCrfDesc);

// ─── Percent Hint ───
function updatePctHint() {
  if (originalBytes > 0) {
    const pct = parseInt(reducePctInput.value) || 50;
    const targetBytes = originalBytes * (1 - pct / 100);
    pctHint.textContent = `~${fmt(targetBytes)} target from ${fmt(originalBytes)} original`;
  } else {
    pctHint.textContent = '';
  }
}
reducePctInput.addEventListener('input', updatePctHint);

// ─── Preset Buttons ───
document.querySelectorAll('.vc-preset-mb').forEach(btn => {
  btn.addEventListener('click', () => {
    targetMbInput.value = btn.dataset.mb;
    if (currentMode !== 'target') switchMode('target');
  });
});
document.querySelectorAll('.vc-preset-pct').forEach(btn => {
  btn.addEventListener('click', () => {
    reducePctInput.value = btn.dataset.pct;
    if (currentMode !== 'percent') switchMode('percent');
    updatePctHint();
  });
});

// ─── File Upload / Drop ───
function loadFile(file) {
  if (!file) return;
  const videoTypes = ['video/mp4', 'video/x-matroska', 'video/quicktime', 'video/avi', 'video/webm'];
  const ext = file.name.split('.').pop().toLowerCase();
  const validExts = ['mp4', 'mkv', 'mov', 'avi', 'webm'];
  if (!videoTypes.includes(file.type) && !validExts.includes(ext)) {
    setStatus('Please select a valid video file (MP4, MKV, MOV, AVI, WEBM).', true);
    return;
  }

  selectedFile = file;
  originalBytes = file.size;
  filenameEl.textContent = file.name;
  originalSizeEl.textContent = `Size: ${fmt(file.size)}`;

  // Default target = 50% of original
  const defaultMb = Math.max(1, Math.round(file.size / 1048576 / 2));
  targetMbInput.value = defaultMb;

  dropZone.classList.add('hidden');
  fileInfo.classList.remove('hidden');
  controls.classList.remove('hidden');
  resultSection.classList.add('hidden');
  updatePctHint();
  setStatus('Choose compression settings, then click Compress & Download.');
}

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

changeBtn.addEventListener('click', () => {
  fileInput.value = '';
  selectedFile = null;
  originalBytes = 0;
  fileInfo.classList.add('hidden');
  controls.classList.add('hidden');
  resultSection.classList.add('hidden');
  dropZone.classList.remove('hidden');
  setStatus('Upload a video or paste a link to begin.');
});

// ─── URL Fetch ───
fetchBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) { setStatus('Please enter a video URL.', true); return; }

  fetchBtn.disabled = true;
  setStatus('Fetching video info…');
  urlMetadata = null;

  try {
    const resp = await fetch('/api/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to fetch metadata');

    urlMetadata = data;
    urlTitle.textContent = data.title || 'Video';
    urlDuration.textContent = data.duration ? `Duration: ${formatDuration(data.duration)}` : '';
    urlInfo.classList.remove('hidden');
    controls.classList.remove('hidden');
    resultSection.classList.add('hidden');
    // We don't know exact file size from metadata, but we can estimate
    originalBytes = 0; // Will be determined server-side
    setStatus('Choose compression settings, then click Compress & Download.');
  } catch (err) {
    setStatus(err.message, true);
    urlInfo.classList.add('hidden');
    controls.classList.add('hidden');
  } finally {
    fetchBtn.disabled = false;
  }
});

// ─── Progress Polling ───
let pollInterval = null;

function startProgressPoll(compId) {
  progressContainer.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '0%';

  pollInterval = setInterval(async () => {
    try {
      const resp = await fetch(`/api/progress?id=${compId}`);
      if (!resp.ok) return;
      const data = await resp.json();

      if (data.status === 'compressing' || data.status === 'downloading') {
        const pct = Math.min(Math.round(data.percent || 0), 99);
        progressFill.style.width = pct + '%';
        progressText.textContent = data.status === 'downloading'
          ? `Downloading… ${pct}%`
          : `Compressing… ${pct}%`;
      } else if (data.status === 'completed') {
        progressFill.style.width = '100%';
        progressText.textContent = 'Complete!';
        stopProgressPoll();
      }
    } catch { /* ignore */ }
  }, 600);
}

function stopProgressPoll() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

// ─── Compress ───
compressBtn.addEventListener('click', async () => {
  if (currentSource === 'upload' && !selectedFile) {
    setStatus('Please upload a video first.', true); return;
  }
  if (currentSource === 'url' && !urlMetadata) {
    setStatus('Please fetch a video URL first.', true); return;
  }

  // Compute target/crf
  let targetMb = null;
  let crf = null;

  if (currentMode === 'target') {
    targetMb = parseFloat(targetMbInput.value);
    if (!targetMb || targetMb < 1) { setStatus('Please enter a valid target size in MB.', true); return; }
    // Warn if target is bigger than original
    if (currentSource === 'upload' && selectedFile && targetMb >= selectedFile.size / 1048576) {
      const cappedMb = Math.max(1, Math.round(selectedFile.size / 1048576 * 0.7));
      setStatus(`⚠️ Target (${targetMb} MB) is bigger than your file (${fmt(selectedFile.size)}). Auto-setting to ${cappedMb} MB.`);
      targetMb = cappedMb;
      targetMbInput.value = cappedMb;
    }
  } else if (currentMode === 'percent') {
    const pct = parseInt(reducePctInput.value);
    if (!pct || pct < 10 || pct > 90) { setStatus('Please enter a percentage between 10 and 90.', true); return; }
    if (currentSource === 'upload' && selectedFile) {
      targetMb = Math.max(1, (selectedFile.size / 1048576) * (1 - pct / 100));
      targetMb = Math.round(targetMb * 100) / 100;
    } else {
      // For URL mode without known file size, use percentage as approximate CRF mapping
      // Map 10-90% reduction to CRF 22-42
      crf = Math.round(22 + (pct / 90) * 20);
    }
  } else if (currentMode === 'crf') {
    crf = parseInt(crfSlider.value);
  }

  compressBtn.disabled = true;
  resultSection.classList.add('hidden');
  const compId = `vc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  setStatus('Starting compression…');
  startProgressPoll(compId);

  try {
    let response;

    if (currentSource === 'upload') {
      const formData = new FormData();
      formData.append('video', selectedFile);
      formData.append('compressionId', compId);
      if (targetMb) formData.append('targetMb', String(targetMb));
      if (crf) formData.append('crf', String(crf));

      response = await fetch('/api/compress-video', {
        method: 'POST',
        body: formData
      });
    } else {
      response = await fetch('/api/compress-video-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: urlInput.value.trim(),
          compressionId: compId,
          targetMb: targetMb || null,
          crf: crf || null
        })
      });
    }

    stopProgressPoll();
    progressFill.style.width = '100%';
    progressText.textContent = 'Complete!';

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Compression failed' }));
      throw new Error(err.error || 'Something went wrong');
    }

    // Get file size from header
    const contentLength = parseInt(response.headers.get('Content-Length') || '0');
    const origSize = parseInt(response.headers.get('X-Original-Size') || '0');

    // Download the blob
    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const disposition = response.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
    const downloadName = filenameMatch ? filenameMatch[1] : 'compressed-video.mp4';

    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();

    // Show result
    const compressedSize = blob.size;
    const displayOriginal = origSize || originalBytes;

    if (displayOriginal > 0) {
      resultOriginal.textContent = fmt(displayOriginal);
      resultCompressed.textContent = fmt(compressedSize);

      const saved = displayOriginal - compressedSize;
      const savedPct = ((saved / displayOriginal) * 100).toFixed(1);

      if (saved > 0) {
        savingsText.textContent = `✅ Saved ${fmt(saved)} (${savedPct}% smaller)`;
        savingsText.style.color = '#16a34a';
      } else {
        savingsText.textContent = `⚠️ Output is ${fmt(-saved)} larger — try higher compression.`;
        savingsText.style.color = '#d97706';
      }
      resultSection.classList.remove('hidden');
    }

    setStatus(`✅ Done! Compressed to ${fmt(compressedSize)}`);
  } catch (err) {
    stopProgressPoll();
    setStatus(err.message || 'Compression failed.', true);
    progressContainer.classList.add('hidden');
  } finally {
    compressBtn.disabled = false;
  }
});
