// FFmpeg.wasm Loader — loads from LOCAL files only (no CDN, no CORS, no Tracking Prevention)
// All FFmpeg files are served from /ffmpeg-wasm/ on the same origin.
// Same-origin scripts can create Workers freely — no CORS issues.
// Includes download progress tracking for the ~30 MB WASM engine.

(function () {
  let ffmpegInstance = null;
  let loadPromise = null;

  // Load a <script> tag (idempotent — won't add twice)
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-ff="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.setAttribute('data-ff', src);
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load: ' + src));
      document.head.appendChild(s);
    });
  }

  // ─── Fetch Progress Bar UI ───
  // Creates and manages an overlay progress bar for the initial WASM download
  let fetchBarEl = null;
  let fetchBarFill = null;
  let fetchBarText = null;
  let fetchBarContainer = null;

  function createFetchBar() {
    // Container that sits inside the panel
    fetchBarContainer = document.createElement('div');
    fetchBarContainer.id = 'ffmpeg-fetch-bar';
    fetchBarContainer.innerHTML = `
      <div class="ffmpeg-fetch-inner">
        <div class="ffmpeg-fetch-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </div>
        <div class="ffmpeg-fetch-content">
          <div class="ffmpeg-fetch-title">Downloading Video Engine</div>
          <div class="ffmpeg-fetch-subtitle" id="ffmpeg-fetch-text">Preparing download…</div>
          <div class="ffmpeg-fetch-track">
            <div class="ffmpeg-fetch-fill" id="ffmpeg-fetch-fill"></div>
          </div>
          <div class="ffmpeg-fetch-stats">
            <span id="ffmpeg-fetch-size">0 MB / ~30 MB</span>
            <span id="ffmpeg-fetch-speed"></span>
          </div>
        </div>
      </div>
    `;

    // Inject styles if not already present
    if (!document.getElementById('ffmpeg-fetch-styles')) {
      const style = document.createElement('style');
      style.id = 'ffmpeg-fetch-styles';
      style.textContent = `
        #ffmpeg-fetch-bar {
          margin: 16px 0;
          animation: ffetchSlideIn 400ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        @keyframes ffetchSlideIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes ffetchSlideOut {
          from { opacity: 1; transform: translateY(0); max-height: 200px; margin: 16px 0; }
          to   { opacity: 0; transform: translateY(-8px); max-height: 0; margin: 0; overflow: hidden; }
        }
        .ffmpeg-fetch-inner {
          display: flex;
          align-items: flex-start;
          gap: 14px;
          padding: 18px 20px;
          background: linear-gradient(135deg, rgba(139, 92, 246, 0.06) 0%, rgba(99, 102, 241, 0.04) 100%);
          border: 1px solid rgba(139, 92, 246, 0.18);
          border-radius: 14px;
          backdrop-filter: blur(8px);
        }
        .ffmpeg-fetch-icon {
          flex-shrink: 0;
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(139, 92, 246, 0.12);
          border-radius: 10px;
          color: #7c3aed;
          animation: ffetchPulse 2s ease-in-out infinite;
        }
        @keyframes ffetchPulse {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.05); }
        }
        .ffmpeg-fetch-content {
          flex: 1;
          min-width: 0;
        }
        .ffmpeg-fetch-title {
          font-size: 0.9rem;
          font-weight: 700;
          color: #1e1b4b;
          margin-bottom: 2px;
          font-family: 'Space Mono', monospace;
        }
        .ffmpeg-fetch-subtitle {
          font-size: 0.8rem;
          color: #6b7280;
          margin-bottom: 10px;
        }
        .ffmpeg-fetch-track {
          width: 100%;
          height: 8px;
          background: rgba(139, 92, 246, 0.1);
          border-radius: 8px;
          overflow: hidden;
          position: relative;
        }
        .ffmpeg-fetch-fill {
          height: 100%;
          width: 0%;
          background: linear-gradient(90deg, #7c3aed, #6366f1, #8b5cf6);
          background-size: 200% 100%;
          border-radius: 8px;
          transition: width 300ms ease;
          animation: ffetchShimmer 2s linear infinite;
          position: relative;
        }
        .ffmpeg-fetch-fill::after {
          content: '';
          position: absolute;
          top: 0;
          right: 0;
          width: 20px;
          height: 100%;
          background: rgba(255,255,255,0.4);
          border-radius: 0 8px 8px 0;
          filter: blur(4px);
        }
        @keyframes ffetchShimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .ffmpeg-fetch-stats {
          display: flex;
          justify-content: space-between;
          margin-top: 6px;
          font-size: 0.72rem;
          color: #6b7280;
          font-variant-numeric: tabular-nums;
          font-family: 'Space Mono', monospace;
        }
        .ffmpeg-fetch-complete .ffmpeg-fetch-inner {
          background: linear-gradient(135deg, rgba(22, 163, 74, 0.06) 0%, rgba(34, 197, 94, 0.04) 100%);
          border-color: rgba(22, 163, 74, 0.2);
        }
        .ffmpeg-fetch-complete .ffmpeg-fetch-icon {
          background: rgba(22, 163, 74, 0.12);
          color: #16a34a;
          animation: none;
        }
        .ffmpeg-fetch-complete .ffmpeg-fetch-fill {
          background: #16a34a;
          animation: none;
        }
        .ffmpeg-fetch-complete .ffmpeg-fetch-title {
          color: #14532d;
        }
      `;
      document.head.appendChild(style);
    }

    return fetchBarContainer;
  }

  function showFetchBar() {
    if (fetchBarContainer) return; // Already showing
    createFetchBar();
    fetchBarFill = document.getElementById('ffmpeg-fetch-fill');
    fetchBarText = document.getElementById('ffmpeg-fetch-text');

    // Insert into the page — find the panel or status element to attach near
    const panel = document.querySelector('.panel');
    const wasmNotice = document.querySelector('.wasm-notice');
    if (wasmNotice && wasmNotice.parentNode) {
      wasmNotice.parentNode.insertBefore(fetchBarContainer, wasmNotice.nextSibling);
    } else if (panel) {
      panel.prepend(fetchBarContainer);
    } else {
      document.body.appendChild(fetchBarContainer);
    }
  }

  function updateFetchBar(loaded, total) {
    if (!fetchBarFill) return;
    const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    fetchBarFill.style.width = pct + '%';

    const sizeEl = document.getElementById('ffmpeg-fetch-size');
    const speedEl = document.getElementById('ffmpeg-fetch-speed');
    const loadedMB = (loaded / 1048576).toFixed(1);
    const totalMB = total > 0 ? (total / 1048576).toFixed(1) : '~30';

    if (sizeEl) sizeEl.textContent = `${loadedMB} MB / ${totalMB} MB`;
    if (fetchBarText) fetchBarText.textContent = `Downloading WebAssembly engine… ${pct}%`;
  }

  function completeFetchBar() {
    if (!fetchBarContainer) return;
    if (fetchBarFill) fetchBarFill.style.width = '100%';
    if (fetchBarText) fetchBarText.textContent = 'Engine loaded — ready to process!';
    fetchBarContainer.classList.add('ffmpeg-fetch-complete');

    const sizeEl = document.getElementById('ffmpeg-fetch-size');
    if (sizeEl) sizeEl.textContent = '✅ Cached for future use';

    const speedEl = document.getElementById('ffmpeg-fetch-speed');
    if (speedEl) speedEl.textContent = '';

    const iconSvg = fetchBarContainer.querySelector('.ffmpeg-fetch-icon svg');
    if (iconSvg) {
      iconSvg.innerHTML = '<polyline points="20 6 9 17 4 12"/>';
    }

    // Fade out after 3 seconds
    setTimeout(() => {
      if (fetchBarContainer) {
        fetchBarContainer.style.animation = 'ffetchSlideOut 500ms ease forwards';
        setTimeout(() => {
          if (fetchBarContainer && fetchBarContainer.parentNode) {
            fetchBarContainer.parentNode.removeChild(fetchBarContainer);
            fetchBarContainer = null;
            fetchBarFill = null;
            fetchBarText = null;
          }
        }, 500);
      }
    }, 3000);
  }

  // ─── Fetch WASM with progress tracking ───
  async function fetchWithProgress(url) {
    const response = await fetch(url);
    const contentLength = response.headers.get('Content-Length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    if (!response.body) {
      // Fallback if ReadableStream not available
      return await response.arrayBuffer();
    }

    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      updateFetchBar(loaded, total || 32000000); // ~30 MB fallback estimate
    }

    // Combine chunks
    const result = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result.buffer;
  }

  async function createFFmpeg() {
    // Load util first (exposes window.FFmpegUtil), then ffmpeg (exposes window.FFmpegWASM)
    await loadScript('/ffmpeg-wasm/ffmpeg-util.js');
    await loadScript('/ffmpeg-wasm/ffmpeg.js');

    const { FFmpeg } = window.FFmpegWASM;
    const ffmpeg = new FFmpeg();

    // Show fetch progress bar for WASM download
    showFetchBar();

    // Fetch WASM binary with progress tracking
    if (fetchBarText) fetchBarText.textContent = 'Downloading WebAssembly engine…';
    const wasmBinary = await fetchWithProgress('/ffmpeg-wasm/ffmpeg-core.wasm');
    updateFetchBar(wasmBinary.byteLength, wasmBinary.byteLength);

    if (fetchBarText) fetchBarText.textContent = 'Initializing engine…';

    // Convert to blob URL for loading
    const wasmBlob = new Blob([wasmBinary], { type: 'application/wasm' });
    const wasmBlobURL = URL.createObjectURL(wasmBlob);

    // All paths are same-origin — no CORS, no toBlobURL needed
    await ffmpeg.load({
      coreURL:   '/ffmpeg-wasm/ffmpeg-core.js',
      wasmURL:   wasmBlobURL,
      workerURL: '/ffmpeg-wasm/814.ffmpeg.js',
    });

    // Clean up blob URL
    URL.revokeObjectURL(wasmBlobURL);

    completeFetchBar();

    return ffmpeg;
  }

  window.FFmpegLoader = {
    /**
     * Get a ready FFmpeg instance (loads once, cached).
     * @param {Function} [onProgress]  callback(ratio 0..1)
     */
    async getFFmpeg(onProgress) {
      if (ffmpegInstance) {
        if (onProgress) {
          ffmpegInstance.on('progress', ({ progress }) => {
            onProgress(Math.min(1, Math.max(0, progress)));
          });
        }
        return ffmpegInstance;
      }

      if (!loadPromise) {
        loadPromise = createFFmpeg().catch(err => {
          loadPromise = null;
          // Clean up fetch bar on error
          if (fetchBarContainer && fetchBarContainer.parentNode) {
            fetchBarContainer.parentNode.removeChild(fetchBarContainer);
            fetchBarContainer = null;
          }
          throw err;
        });
      }

      ffmpegInstance = await loadPromise;

      if (onProgress) {
        ffmpegInstance.on('progress', ({ progress }) => {
          onProgress(Math.min(1, Math.max(0, progress)));
        });
      }

      return ffmpegInstance;
    },

    isLoaded() {
      return ffmpegInstance !== null;
    }
  };
})();
