const form = document.getElementById('mp3-form');
const urlInput = document.getElementById('mp3-url');
const fetchButton = document.getElementById('mp3-fetch-button');
const metaSection = document.getElementById('mp3-meta');
const downloadRow = document.getElementById('mp3-download-row');
const downloadButton = document.getElementById('mp3-download-button');
const thumbnail = document.getElementById('mp3-thumbnail');
const titleNode = document.getElementById('mp3-video-title');
const authorNode = document.getElementById('mp3-video-author');
const statusNode = document.getElementById('mp3-status');
const progressContainer = document.getElementById('mp3-progress-container');
const progressFill = document.getElementById('mp3-progress-fill');
const progressText = document.getElementById('mp3-progress-text');

let currentUrl = '';

function setStatus(msg, isError = false) {
  statusNode.textContent = msg;
  statusNode.style.color = isError ? '#a12612' : '';
}

function resetProgress() {
  progressContainer.classList.add('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '0%';
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Request failed.' }));
    throw new Error(err.error || 'Request failed.');
  }
  return response;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  currentUrl = urlInput.value.trim();
  if (!currentUrl) { setStatus('Please paste a video URL.', true); return; }

  fetchButton.disabled = true;
  downloadRow.classList.add('hidden');
  metaSection.classList.add('hidden');
  setStatus('Fetching video info…');

  try {
    const res = await postJson('/api/metadata', { url: currentUrl });
    const data = await res.json();

    titleNode.textContent = data.title || 'Untitled';
    authorNode.textContent = data.uploader ? `By ${data.uploader}` : '';
    thumbnail.src = data.thumbnail || '';
    metaSection.classList.remove('hidden');
    downloadRow.classList.remove('hidden');
    setStatus('Ready! Click Download MP3 to extract audio.');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    fetchButton.disabled = false;
  }
});

downloadButton.addEventListener('click', async () => {
  if (!currentUrl) { setStatus('Fetch a video first.', true); return; }

  downloadButton.disabled = true;
  fetchButton.disabled = true;
  setStatus('Extracting MP3 audio…');

  progressContainer.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '0%';

  const downloadId = Date.now().toString(36) + Math.random().toString(36).slice(2);

  const poll = setInterval(async () => {
    try {
      const res = await fetch(`/api/progress?id=${downloadId}`);
      if (res.ok) {
        const d = await res.json();
        if (d.status === 'downloading') {
          progressFill.style.width = `${d.percent}%`;
          progressText.textContent = `${d.percent.toFixed(1)}%`;
        }
      }
    } catch {}
  }, 1000);

  try {
    const response = await postJson('/api/download-audio', { url: currentUrl, downloadId });
    clearInterval(poll);
    progressFill.style.width = '100%';
    progressText.textContent = 'Complete!';
    setStatus('MP3 ready — saving to your device…');

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const disp = response.headers.get('Content-Disposition') || '';
    const nameMatch = disp.match(/filename="(.+)"/i);
    a.href = objectUrl;
    a.download = nameMatch ? nameMatch[1] : 'audio.mp3';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);

    setStatus('✅ MP3 downloaded successfully!');
    setTimeout(resetProgress, 4000);
  } catch (err) {
    clearInterval(poll);
    setStatus(err.message, true);
    resetProgress();
  } finally {
    downloadButton.disabled = false;
    fetchButton.disabled = false;
  }
});
