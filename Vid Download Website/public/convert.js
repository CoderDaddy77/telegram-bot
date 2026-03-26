const dropZone = document.getElementById('drop-zone');
const wavInput = document.getElementById('wav-input');
const convertInfo = document.getElementById('convert-info');
const convertFilename = document.getElementById('convert-filename');
const convertFilesize = document.getElementById('convert-filesize');
const changeBtn = document.getElementById('convert-change-btn');
const convertButton = document.getElementById('convert-button');
const bitrateSelect = document.getElementById('mp3-bitrate');
const convertStatus = document.getElementById('convert-status');
const progressContainer = document.getElementById('convert-progress-container');
const progressFill = document.getElementById('convert-progress-fill');
const progressText = document.getElementById('convert-progress-text');

let selectedFile = null;

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function setStatus(msg, isError = false) {
  convertStatus.textContent = msg;
  convertStatus.style.color = isError ? '#a12612' : '';
}

function resetProgress() {
  progressContainer.classList.add('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '0%';
}

function loadFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.wav')) {
    setStatus('Please select a valid .wav file.', true);
    return;
  }

  selectedFile = file;
  convertFilename.textContent = file.name;
  convertFilesize.textContent = fmtSize(file.size);

  // Hide drop zone, show file info
  dropZone.classList.add('hidden');
  convertInfo.classList.remove('hidden');

  convertButton.disabled = false;
  setStatus('Ready to convert. Pick a bitrate and click Convert to MP3.');
}

// Drop zone click
dropZone.addEventListener('click', () => wavInput.click());
wavInput.addEventListener('change', () => {
  if (wavInput.files[0]) loadFile(wavInput.files[0]);
});

// Drag and drop
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

// Upload Another button — reset everything
changeBtn.addEventListener('click', () => {
  selectedFile = null;
  wavInput.value = '';
  convertFilename.textContent = '';
  convertFilesize.textContent = '';

  convertInfo.classList.add('hidden');
  dropZone.classList.remove('hidden');

  convertButton.disabled = true;
  resetProgress();
  setStatus('Select a WAV file to begin.');
});

// Convert button
convertButton.addEventListener('click', async () => {
  if (!selectedFile) { setStatus('Please select a file first.', true); return; }

  convertButton.disabled = true;
  changeBtn.disabled = true;
  setStatus('Uploading and converting…');

  progressContainer.classList.remove('hidden');
  progressFill.style.width = '10%';
  progressText.textContent = 'Uploading…';

  const formData = new FormData();
  formData.append('audio', selectedFile);
  formData.append('bitrate', bitrateSelect.value);

  try {
    const response = await fetch('/api/convert', { method: 'POST', body: formData });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Conversion failed.' }));
      throw new Error(err.error || 'Conversion failed.');
    }

    progressFill.style.width = '100%';
    progressText.textContent = 'Complete!';
    setStatus('Conversion complete — downloading MP3…');

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const disp = response.headers.get('Content-Disposition') || '';
    const nameMatch = disp.match(/filename="(.+)"/i);
    a.href = url;
    a.download = nameMatch ? nameMatch[1] : selectedFile.name.replace(/\.wav$/i, '.mp3');
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    setStatus('✅ MP3 downloaded successfully!');
    setTimeout(resetProgress, 4000);
  } catch (err) {
    setStatus(err.message, true);
    resetProgress();
  } finally {
    convertButton.disabled = false;
    changeBtn.disabled = false;
  }
});
