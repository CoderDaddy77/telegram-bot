// Image Compressor — client-side using Canvas + binary search for target KB
const dropZone = document.getElementById('comp-drop-zone');
const fileInput = document.getElementById('comp-input');
const fileInfo = document.getElementById('comp-file-info');
const filenameEl = document.getElementById('comp-filename');
const originalSizeEl = document.getElementById('comp-original-size');
const originalDimsEl = document.getElementById('comp-original-dims');
const changeBtn = document.getElementById('comp-change-btn');
const controls = document.getElementById('comp-controls');
const targetKbInput = document.getElementById('comp-target-kb');
const qualitySlider = document.getElementById('comp-quality-slider');
const qualityVal = document.getElementById('comp-quality-val');
const formatSelect = document.getElementById('comp-format');
const compBtn = document.getElementById('comp-btn');
const statusNode = document.getElementById('comp-status');
const resultSection = document.getElementById('comp-result');
const previewOriginal = document.getElementById('comp-preview-original');
const previewOutput = document.getElementById('comp-preview-output');
const resultOriginalSize = document.getElementById('comp-result-original-size');
const resultOutputSize = document.getElementById('comp-result-output-size');
const savingsText = document.getElementById('comp-savings-text');

const tabTarget = document.getElementById('tab-target');
const tabQuality = document.getElementById('tab-quality');
const panelTarget = document.getElementById('comp-target-mode');
const panelQuality = document.getElementById('comp-quality-mode');

let originalImage = null;
let originalFile = null;
let currentMode = 'target'; // 'target' | 'quality'

function fmt(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

function setStatus(msg, isError = false) {
  statusNode.textContent = msg;
  statusNode.style.color = isError ? '#a12612' : '';
}

// Mode tabs
tabTarget.addEventListener('click', () => {
  currentMode = 'target';
  tabTarget.classList.add('active');
  tabQuality.classList.remove('active');
  panelTarget.classList.remove('hidden');
  panelQuality.classList.add('hidden');
});

tabQuality.addEventListener('click', () => {
  currentMode = 'quality';
  tabQuality.classList.add('active');
  tabTarget.classList.remove('active');
  panelQuality.classList.remove('hidden');
  panelTarget.classList.add('hidden');
});

// Quality slider label
qualitySlider.addEventListener('input', () => {
  qualityVal.textContent = qualitySlider.value;
});

// Preset buttons
document.querySelectorAll('.comp-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    targetKbInput.value = btn.dataset.kb;
    // Switch to target mode
    if (currentMode !== 'target') tabTarget.click();
  });
});

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('Please select a valid image file (PNG, JPEG, WebP).', true);
    return;
  }

  originalFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      originalImage = img;
      filenameEl.textContent = file.name;
      originalSizeEl.textContent = `Size: ${fmt(file.size)}`;
      originalDimsEl.textContent = `Dimensions: ${img.naturalWidth} × ${img.naturalHeight} px`;
      previewOriginal.src = e.target.result;

      // Default target = 50% of original size
      const defaultKb = Math.max(10, Math.round(file.size / 1024 / 2));
      targetKbInput.value = defaultKb;

      dropZone.classList.add('hidden');
      fileInfo.classList.remove('hidden');
      controls.classList.remove('hidden');
      resultSection.classList.add('hidden');
      setStatus('Set your target size or quality, then click Compress & Download.');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
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
  originalImage = null;
  originalFile = null;
  fileInfo.classList.add('hidden');
  controls.classList.add('hidden');
  resultSection.classList.add('hidden');
  dropZone.classList.remove('hidden');
  setStatus('Select an image to begin.');
});

// Canvas helper: render image to blob at a given quality
function imageToBlob(img, mimeType, quality) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // White background for JPEG (no transparency)
    if (mimeType === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.drawImage(img, 0, 0);
    canvas.toBlob(resolve, mimeType, quality);
  });
}

// Binary search: find quality that produces blob <= targetBytes, as close as possible
async function compressToTargetKB(img, mimeType, targetBytes) {
  if (mimeType === 'image/png') {
    // PNG is lossless — we can't target a size, just return as-is
    return await imageToBlob(img, mimeType, 1);
  }

  let lo = 0.01, hi = 1.0, bestBlob = null;

  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const blob = await imageToBlob(img, mimeType, mid);
    if (blob.size <= targetBytes) {
      lo = mid;
      bestBlob = blob;
    } else {
      hi = mid;
    }
  }

  // If even quality=0.01 is too large, return it anyway (can't compress further)
  if (!bestBlob) {
    bestBlob = await imageToBlob(img, mimeType, 0.01);
  }
  return bestBlob;
}

compBtn.addEventListener('click', async () => {
  if (!originalImage) { setStatus('Please upload an image first.', true); return; }

  const format = formatSelect.value;
  const mimeType = format === 'png' ? 'image/png'
    : format === 'webp' ? 'image/webp'
    : 'image/jpeg';
  const ext = format === 'jpeg' ? 'jpg' : format;
  const baseName = (originalFile?.name || 'image').replace(/\.[^.]+$/, '');

  compBtn.disabled = true;
  resultSection.classList.add('hidden');

  let blob;

  if (currentMode === 'target') {
    const targetKb = parseInt(targetKbInput.value);
    if (!targetKb || targetKb < 1) {
      setStatus('Please enter a valid target size in KB.', true);
      compBtn.disabled = false;
      return;
    }

    if (format === 'png') {
      setStatus('PNG is lossless — compressing at best settings…');
    } else {
      setStatus(`Finding quality to hit ≤ ${targetKb} KB — binary searching…`);
    }

    const targetBytes = targetKb * 1024;
    blob = await compressToTargetKB(originalImage, mimeType, targetBytes);
  } else {
    const quality = parseInt(qualitySlider.value) / 100;
    setStatus('Compressing at selected quality…');
    blob = await imageToBlob(originalImage, mimeType, quality);
  }

  if (!blob) { setStatus('Compression failed. Try a different format.', true); compBtn.disabled = false; return; }

  // Show result
  const outputUrl = URL.createObjectURL(blob);
  previewOutput.src = outputUrl;

  const originalBytes = originalFile.size;
  const outputBytes = blob.size;
  const saved = originalBytes - outputBytes;
  const savedPct = ((saved / originalBytes) * 100).toFixed(1);

  resultOriginalSize.textContent = fmt(originalBytes);
  resultOutputSize.textContent = fmt(outputBytes) + ` (${outputBytes < 1024 ? outputBytes + ' B' : ''})`;

  if (saved > 0) {
    savingsText.textContent = `✅ Saved ${fmt(saved)} (${savedPct}% smaller)`;
    savingsText.style.color = '#16a34a';
  } else {
    savingsText.textContent = `⚠️ Output is ${fmt(-saved)} larger than original. Try JPEG or WebP.`;
    savingsText.style.color = '#d97706';
  }

  resultSection.classList.remove('hidden');

  // Download
  const a = document.createElement('a');
  a.href = outputUrl;
  a.download = `${baseName}-compressed.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setStatus(`✅ Done! Output: ${fmt(outputBytes)}`);
  compBtn.disabled = false;
});
