// Video Downloader — uses Render backend (yt-dlp)
const RENDER_API = window.RENDER_API_URL || 'https://vera-media-tools-backend.onrender.com';

const urlInput      = document.getElementById('dl-url');
const fetchBtn      = document.getElementById('dl-fetch-btn');
const optionsEl     = document.getElementById('dl-options');
const typeSelect    = document.getElementById('dl-type');
const qualitySelect = document.getElementById('dl-quality');
const qualityGroup  = document.getElementById('dl-quality-group');
const progressCont  = document.getElementById('dl-progress-container');
const progressFill  = document.getElementById('dl-progress-fill');
const progressText  = document.getElementById('dl-progress-text');
const statusEl      = document.getElementById('dl-status');
const infoCard      = document.getElementById('dl-info-card');
const thumbEl       = document.getElementById('dl-thumb');
const titleEl       = document.getElementById('dl-title');
const uploaderEl    = document.getElementById('dl-uploader');
const durationEl    = document.getElementById('dl-duration');
const downloadBtn   = document.getElementById('dl-download-btn');

let currentVideoInfo = null;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#a12612' : '';
}

function showProgress(label) {
  progressCont.classList.remove('hidden');
  progressText.textContent = label;
}

function hideProgress() {
  progressCont.classList.add('hidden');
}

function formatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

// Hide quality when audio mode selected
typeSelect.addEventListener('change', () => {
  qualityGroup.style.display = typeSelect.value === 'audio' ? 'none' : '';
});

// ─── Fetch video info ───
fetchBtn.addEventListener('click', fetchInfo);
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchInfo(); });

async function fetchInfo() {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus('Please paste a video URL first.', true);
    return;
  }
  try { new URL(url); } catch { setStatus('That doesn\'t look like a valid URL.', true); return; }

  fetchBtn.disabled = true;
  infoCard.classList.add('hidden');
  optionsEl.style.display = 'none';
  showProgress('Fetching video info…');
  setStatus('');

  try {
    const resp = await fetch(`${RENDER_API}/api/info?url=${encodeURIComponent(url)}`);
    const data = await resp.json();

    if (!resp.ok) throw new Error(data.error || 'Failed to fetch video info.');

    currentVideoInfo = data;

    // Populate card
    thumbEl.src = data.thumbnail || '';
    thumbEl.style.display = data.thumbnail ? '' : 'none';
    titleEl.textContent = data.title;
    uploaderEl.textContent = data.uploader ? `by ${data.uploader}` : '';
    durationEl.textContent = data.duration ? `⏱ ${formatDuration(data.duration)}` : '';

    infoCard.classList.remove('hidden');
    optionsEl.style.display = 'flex';
    hideProgress();
    setStatus('Ready to download! Choose format and click Download.');

  } catch (err) {
    hideProgress();
    setStatus(err.message || 'Could not fetch video info.', true);
    console.error(err);
  } finally {
    fetchBtn.disabled = false;
  }
}

// ─── Download ───
downloadBtn.addEventListener('click', startDownload);

function startDownload() {
  const url = urlInput.value.trim();
  if (!url || !currentVideoInfo) return;

  const type = typeSelect.value;
  const quality = qualitySelect.value;

  // Build format string for yt-dlp
  let format = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
  if (type === 'video' && quality !== 'best') {
    format = `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${quality}][ext=mp4]/best[height<=${quality}]`;
  }

  const downloadUrl = `${RENDER_API}/api/download?` + new URLSearchParams({
    url, type, format,
  }).toString();

  setStatus(`⬇️ Starting download (${type === 'audio' ? 'MP3' : quality === 'best' ? 'Best MP4' : quality + 'p MP4'})…`);

  // Use an anchor tag to trigger browser download
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = type === 'audio'
    ? (currentVideoInfo.title + '.mp3').replace(/[\/\\:*?"<>|]/g, '_')
    : (currentVideoInfo.title + '.mp4').replace(/[\/\\:*?"<>|]/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();

  setStatus('✅ Download started! Check your downloads folder.');
}
