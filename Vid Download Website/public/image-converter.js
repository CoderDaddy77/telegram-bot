// Image Format Converter — client-side using Canvas API
// Convert between PNG, JPEG, WebP, BMP

const dropZone = document.getElementById('imgconv-drop');
const fileInput = document.getElementById('imgconv-input');
const fileInfo = document.getElementById('imgconv-file-info');
const filenameEl = document.getElementById('imgconv-filename');
const filesizeEl = document.getElementById('imgconv-filesize');
const changeBtn = document.getElementById('imgconv-change-btn');
const controlsEl = document.getElementById('imgconv-controls');
const formatSelect = document.getElementById('imgconv-format');
const qualitySlider = document.getElementById('imgconv-quality');
const qualityVal = document.getElementById('imgconv-quality-val');
const qualityControl = document.getElementById('imgconv-quality-control');
const convertBtn = document.getElementById('imgconv-btn');
const statusNode = document.getElementById('imgconv-status');
const resultSection = document.getElementById('imgconv-result');
const previewOriginal = document.getElementById('imgconv-preview-original');
const previewOutput = document.getElementById('imgconv-preview-output');
const resultOriginalSize = document.getElementById('imgconv-result-original-size');
const resultOutputSize = document.getElementById('imgconv-result-output-size');

let originalFile = null;
let originalImage = null;

function setStatus(msg, isError = false) {
  statusNode.textContent = msg;
  statusNode.style.color = isError ? '#a12612' : '';
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

// Quality slider
qualitySlider.addEventListener('input', () => {
  qualityVal.textContent = qualitySlider.value;
});

// Show/hide quality based on format
formatSelect.addEventListener('change', () => {
  const fmt = formatSelect.value;
  if (fmt === 'png' || fmt === 'bmp') {
    qualityControl.classList.add('hidden');
  } else {
    qualityControl.classList.remove('hidden');
  }
});

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('Please select a valid image file.', true);
    return;
  }

  originalFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      originalImage = img;
      filenameEl.textContent = `${file.name} (${img.naturalWidth}×${img.naturalHeight})`;
      filesizeEl.textContent = `Size: ${fmtSize(file.size)}`;
      previewOriginal.src = e.target.result;

      dropZone.classList.add('hidden');
      fileInfo.classList.remove('hidden');
      controlsEl.classList.remove('hidden');
      resultSection.classList.add('hidden');

      // Auto-select a different format than source
      const ext = file.name.toLowerCase().match(/\.(png|jpe?g|webp|bmp)$/);
      if (ext) {
        const srcFmt = ext[1] === 'jpg' ? 'jpeg' : ext[1];
        if (srcFmt === 'png') formatSelect.value = 'jpeg';
        else if (srcFmt === 'jpeg') formatSelect.value = 'png';
        else if (srcFmt === 'webp') formatSelect.value = 'png';
        else if (srcFmt === 'bmp') formatSelect.value = 'png';
      }
      formatSelect.dispatchEvent(new Event('change'));

      setStatus('Choose output format and click Convert & Download.');
    };
    img.onerror = () => setStatus('Failed to load image.', true);
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Drop zone events
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
  originalFile = null;
  originalImage = null;
  fileInfo.classList.add('hidden');
  controlsEl.classList.add('hidden');
  resultSection.classList.add('hidden');
  dropZone.classList.remove('hidden');
  setStatus('Select an image to begin.');
});

// Convert
convertBtn.addEventListener('click', () => {
  if (!originalImage) { setStatus('Please upload an image first.', true); return; }

  convertBtn.disabled = true;
  setStatus('Converting…');

  const format = formatSelect.value;
  const quality = parseInt(qualitySlider.value) / 100;

  const canvas = document.createElement('canvas');
  canvas.width = originalImage.naturalWidth;
  canvas.height = originalImage.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // White background for JPEG
  if (format === 'jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.drawImage(originalImage, 0, 0);

  const mimeMap = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp' };
  const extMap = { png: 'png', jpeg: 'jpg', webp: 'webp', bmp: 'bmp' };
  const mime = mimeMap[format];

  canvas.toBlob((blob) => {
    if (!blob) {
      setStatus('Conversion failed. Try a different format.', true);
      convertBtn.disabled = false;
      return;
    }

    const url = URL.createObjectURL(blob);
    previewOutput.src = url;

    resultOriginalSize.textContent = `${fmtSize(originalFile.size)} (${originalFile.type.split('/')[1].toUpperCase()})`;
    resultOutputSize.textContent = `${fmtSize(blob.size)} (${format.toUpperCase()})`;
    resultSection.classList.remove('hidden');

    // Download
    const baseName = originalFile.name.replace(/\.[^.]+$/, '');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.${extMap[format]}`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setStatus(`✅ Converted! ${fmtSize(originalFile.size)} → ${fmtSize(blob.size)}`);
    convertBtn.disabled = false;
  }, mime, (format === 'jpeg' || format === 'webp') ? quality : undefined);
});
