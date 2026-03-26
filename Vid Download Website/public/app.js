const form = document.getElementById("download-form");
const urlInput = document.getElementById("video-url");
const fetchButton = document.getElementById("fetch-button");
const resolutionSelect = document.getElementById("resolution");
const downloadButton = document.getElementById("download-button");
const directLinkButton = document.getElementById("direct-link-button");
const downloadMp3Button = document.getElementById("download-mp3-button");
const statusNode = document.getElementById("status");
const previewCard = document.getElementById("preview-card");
const thumbnail = document.getElementById("thumbnail");
const titleNode = document.getElementById("video-title");
const authorNode = document.getElementById("video-author");
const filesizeNode = document.getElementById("video-filesize");
const sourceLink = document.getElementById("video-source");
const progressContainer = document.getElementById("progress-container");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
if (!form) throw new Error('app.js loaded on wrong page');

let currentUrl = "";

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "Unknown size";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.style.color = isError ? "#a12612" : "";
}

function resetPreview() {
  previewCard.classList.add("hidden");
  titleNode.textContent = "";
  authorNode.textContent = "";
  filesizeNode.textContent = "";
  sourceLink.href = "#";
  thumbnail.removeAttribute("src");
}

function resetProgress() {
  progressContainer.classList.add("hidden");
  progressFill.style.width = "0%";
  progressText.textContent = "0%";
}

function fillResolutionOptions(resolutions) {
  resolutionSelect.innerHTML = "";

  if (!resolutions.length) {
    const option = document.createElement("option");
    option.textContent = "No standalone resolutions found";
    resolutionSelect.appendChild(option);
    resolutionSelect.disabled = true;
    downloadButton.disabled = true;
    directLinkButton.disabled = true;
    if (downloadMp3Button) downloadMp3Button.disabled = true;
    return;
  }

  for (const resolution of resolutions.slice().reverse()) {
    const option = document.createElement("option");
    option.value = resolution.value;
    const sizeText = resolution.filesize ? ` (${formatBytes(resolution.filesize)})` : "";
    option.textContent = resolution.label + sizeText;
    resolutionSelect.appendChild(option);
  }

  resolutionSelect.disabled = false;
  downloadButton.disabled = false;
  directLinkButton.disabled = false;
  if (downloadMp3Button) downloadMp3Button.disabled = false;
}

// Update displayed file size when resolution changes
resolutionSelect.addEventListener("change", () => {
  const resolution = resolutionSelect.value;
  if (!window.currentResolutions) return;
  const selected = window.currentResolutions.find(r => r.value === resolution);
  if (selected && selected.filesize) {
    filesizeNode.textContent = `Estimated size: ${formatBytes(selected.filesize)}`;
  } else {
    filesizeNode.textContent = "Size: Unknown";
  }
});

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed." }));
    throw new Error(error.error || "Request failed.");
  }

  return response;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  currentUrl = urlInput.value.trim();

  if (!currentUrl) {
    setStatus("Please paste a video link first.", true);
    return;
  }

  fetchButton.disabled = true;
  downloadButton.disabled = true;
  directLinkButton.disabled = true;
  if (downloadMp3Button) downloadMp3Button.disabled = true;
  resolutionSelect.disabled = true;
  setStatus("Reading video info and available resolutions...");
  resetPreview();

  try {
    const response = await postJson("/api/metadata", { url: currentUrl });
    const metadata = await response.json();

    window.currentResolutions = metadata.resolutions || [];
    fillResolutionOptions(window.currentResolutions);
    titleNode.textContent = metadata.title || "Untitled video";
    authorNode.textContent = metadata.uploader ? `By ${metadata.uploader}` : "Uploader unavailable";
    sourceLink.href = metadata.webpageUrl || currentUrl;
    thumbnail.src = metadata.thumbnail || "";
    previewCard.classList.remove("hidden");

    // Show file size for the default (first/highest) resolution
    const defaultRes = window.currentResolutions.length ? window.currentResolutions[window.currentResolutions.length - 1] : null;
    if (defaultRes && defaultRes.filesize) {
      filesizeNode.textContent = `Estimated size: ${formatBytes(defaultRes.filesize)}`;
    } else {
      filesizeNode.textContent = "";
    }

    setStatus("Link fetched. Pick a resolution and download.");
  } catch (error) {
    resetPreview();
    setStatus(error.message, true);
  } finally {
    fetchButton.disabled = false;
  }
});

downloadButton.addEventListener("click", async () => {
  const resolution = resolutionSelect.value;

  if (!currentUrl || !resolution) {
    setStatus("Fetch metadata before downloading.", true);
    return;
  }

  downloadButton.disabled = true;
  fetchButton.disabled = true;
  setStatus("Fetching best streams and downloading to server...");
  
  progressContainer.classList.remove("hidden");
  progressFill.style.width = "0%";
  progressText.textContent = "0%";

  const downloadId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  
  const pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/progress?id=${downloadId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'downloading') {
          setStatus("Downloading to server...");
          progressFill.style.width = `${data.percent}%`;
          progressText.textContent = `${data.percent.toFixed(1)}%`;
        } else if (data.status === 'merging') {
          setStatus("Merging high-quality video and audio...");
          progressFill.style.width = "100%";
          progressText.textContent = "Processing...";
        } else if (data.status === 'starting') {
          setStatus("Starting download...");
        }
      }
    } catch (err) {
      // ignore poll errors
    }
  }, 1000);

  try {
    const response = await postJson("/api/download", {
      url: currentUrl,
      resolution,
      downloadId
    });

    clearInterval(pollInterval);
    progressFill.style.width = "100%";
    progressText.textContent = "Complete!";
    setStatus("Sending file to browser. Browser save prompt will appear shortly...");

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const disposition = response.headers.get("Content-Disposition") || "";
    const nameMatch = disposition.match(/filename="(.+)"/i);

    link.href = objectUrl;
    link.download = nameMatch ? nameMatch[1] : `video-${resolution}p.mp4`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);

    setStatus("Download saved successfully.");
    setTimeout(resetProgress, 4000);
  } catch (error) {
    clearInterval(pollInterval);
    setStatus(error.message, true);
    resetProgress();
  } finally {
    downloadButton.disabled = false;
    fetchButton.disabled = false;
  }
});

directLinkButton.addEventListener("click", () => {
  const resolution = resolutionSelect.value;
  if (!window.currentResolutions || !resolution) return;
  
  const selected = window.currentResolutions.find(r => r.value === resolution);
  if (selected && selected.directUrl) {
    window.open(selected.directUrl, '_blank');
  } else {
    setStatus("No direct link available for this resolution.", true);
  }
});

// MP3 button (only on pages that have it — video to MP3 now has its own page)
if (downloadMp3Button) {
  downloadMp3Button.addEventListener("click", async () => {
    if (!currentUrl) {
      setStatus("Fetch metadata before downloading.", true);
      return;
    }

    downloadMp3Button.disabled = true;
    fetchButton.disabled = true;
    setStatus("Extracting audio as MP3...");

    progressContainer.classList.remove("hidden");
    progressFill.style.width = "0%";
    progressText.textContent = "0%";

    const downloadId = Date.now().toString(36) + Math.random().toString(36).slice(2);

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/progress?id=${downloadId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'downloading') {
            progressFill.style.width = `${data.percent}%`;
            progressText.textContent = `${data.percent.toFixed(1)}%`;
          }
        }
      } catch (err) {}
    }, 1000);

    try {
      const response = await postJson("/api/download-audio", {
        url: currentUrl,
        downloadId
      });

      clearInterval(pollInterval);
      progressFill.style.width = "100%";
      progressText.textContent = "Complete!";
      setStatus("Audio extracted! Downloading MP3...");

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const disposition = response.headers.get("Content-Disposition") || "";
      const nameMatch = disposition.match(/filename="(.+)"/i);

      link.href = objectUrl;
      link.download = nameMatch ? nameMatch[1] : "audio.mp3";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);

      setStatus("MP3 download saved successfully.");
      setTimeout(resetProgress, 4000);
    } catch (error) {
      clearInterval(pollInterval);
      setStatus(error.message, true);
      resetProgress();
    } finally {
      downloadMp3Button.disabled = false;
      fetchButton.disabled = false;
    }
  });
}
