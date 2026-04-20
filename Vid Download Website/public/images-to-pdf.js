// Images to PDF — client-side using jsPDF
// Drag & drop multiple images, reorder, combine into a single PDF

const dropZone = document.getElementById('img2pdf-drop');
const fileInput = document.getElementById('img2pdf-input');
const fileInputMore = document.getElementById('img2pdf-input-more');
const addMoreBtn = document.getElementById('img2pdf-add-more');
const listEl = document.getElementById('img2pdf-list');
const controlsEl = document.getElementById('img2pdf-controls');
const orientationSelect = document.getElementById('img2pdf-orientation');
const marginSelect = document.getElementById('img2pdf-margin');
const genBtn = document.getElementById('img2pdf-btn');
const statusNode = document.getElementById('img2pdf-status');

let images = []; // { file, dataUrl, width, height }
let dragSrcIndex = null;

function setStatus(msg, isError = false) {
  statusNode.textContent = msg;
  statusNode.style.color = isError ? '#a12612' : '';
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => resolve({ file, dataUrl: e.target.result, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('Failed to load: ' + file.name));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Failed to read: ' + file.name));
    reader.readAsDataURL(file);
  });
}

async function addFiles(files) {
  const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/jpg'];
  const newFiles = Array.from(files).filter(f => validTypes.includes(f.type) || f.name.match(/\.(png|jpe?g|webp|bmp)$/i));

  if (newFiles.length === 0) {
    setStatus('No valid image files selected.', true);
    return;
  }

  setStatus('Loading images…');
  for (const f of newFiles) {
    try {
      const imgData = await loadImage(f);
      images.push(imgData);
    } catch (err) {
      console.warn(err.message);
    }
  }

  renderList();
  dropZone.classList.add('hidden');
  listEl.classList.remove('hidden');
  controlsEl.classList.remove('hidden');
  setStatus(`${images.length} image${images.length > 1 ? 's' : ''} loaded. Drag to reorder, then generate PDF.`);
}

function renderList() {
  listEl.innerHTML = '';
  images.forEach((img, i) => {
    const item = document.createElement('div');
    item.className = 'img2pdf-item';
    item.draggable = true;
    item.dataset.index = i;

    item.innerHTML = `
      <div class="img2pdf-handle">☰</div>
      <img src="${img.dataUrl}" class="img2pdf-thumb" alt="Page ${i + 1}" />
      <div class="img2pdf-meta">
        <p class="img2pdf-name">${img.file.name}</p>
        <p class="img2pdf-dims">${img.width}×${img.height} · ${fmtSize(img.file.size)}</p>
      </div>
      <span class="img2pdf-page-num">#${i + 1}</span>
      <button class="img2pdf-remove" data-index="${i}" title="Remove">✕</button>
    `;

    // Drag events
    item.addEventListener('dragstart', (e) => {
      dragSrcIndex = i;
      item.classList.add('img2pdf-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('img2pdf-dragging');
      dragSrcIndex = null;
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('img2pdf-drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('img2pdf-drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('img2pdf-drag-over');
      if (dragSrcIndex !== null && dragSrcIndex !== i) {
        const moved = images.splice(dragSrcIndex, 1)[0];
        images.splice(i, 0, moved);
        renderList();
      }
    });

    // Remove button
    item.querySelector('.img2pdf-remove').addEventListener('click', () => {
      images.splice(i, 1);
      if (images.length === 0) {
        listEl.classList.add('hidden');
        controlsEl.classList.add('hidden');
        dropZone.classList.remove('hidden');
        setStatus('Select images to begin.');
      } else {
        renderList();
        setStatus(`${images.length} image${images.length > 1 ? 's' : ''} loaded.`);
      }
    });

    listEl.appendChild(item);
  });
}

// Drop zone
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files.length) addFiles(fileInput.files); });
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

// Add more
addMoreBtn.addEventListener('click', () => fileInputMore.click());
fileInputMore.addEventListener('change', () => {
  if (fileInputMore.files.length) addFiles(fileInputMore.files);
  fileInputMore.value = '';
});

// Generate PDF
genBtn.addEventListener('click', async () => {
  if (images.length === 0) { setStatus('Add images first.', true); return; }

  genBtn.disabled = true;
  setStatus('Generating PDF…');

  try {
    const { jsPDF } = window.jspdf;
    const margin = parseInt(marginSelect.value) || 0;
    const orientation = orientationSelect.value;

    let pdf = null;

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      let pageW, pageH;

      if (orientation === 'auto') {
        // Page fits the image exactly (in points, 1px ≈ 0.75pt)
        pageW = (img.width * 0.75) + (margin * 2);
        pageH = (img.height * 0.75) + (margin * 2);
      } else {
        const sizes = {
          'a4-portrait': [210, 297],
          'a4-landscape': [297, 210],
          'letter-portrait': [215.9, 279.4],
          'letter-landscape': [279.4, 215.9],
        };
        const [w, h] = sizes[orientation];
        pageW = w;
        pageH = h;
      }

      if (i === 0) {
        pdf = new jsPDF({
          unit: orientation === 'auto' ? 'pt' : 'mm',
          format: [pageW, pageH],
        });
      } else {
        pdf.addPage([pageW, pageH]);
      }

      // Calculate image dimensions to fit within page (with margin)
      const drawW = pageW - (margin * 2);
      const drawH = pageH - (margin * 2);

      // Scale image to fit
      const imgRatio = img.width / img.height;
      const pageRatio = drawW / drawH;

      let finalW, finalH, x, y;

      if (orientation === 'auto') {
        finalW = drawW;
        finalH = drawH;
        x = margin;
        y = margin;
      } else {
        if (imgRatio > pageRatio) {
          finalW = drawW;
          finalH = drawW / imgRatio;
        } else {
          finalH = drawH;
          finalW = drawH * imgRatio;
        }
        x = margin + (drawW - finalW) / 2;
        y = margin + (drawH - finalH) / 2;
      }

      // Determine format
      let format = 'JPEG';
      if (img.file.type === 'image/png') format = 'PNG';

      pdf.addImage(img.dataUrl, format, x, y, finalW, finalH);
      setStatus(`Processing page ${i + 1} of ${images.length}…`);
    }

    pdf.save('images-combined.pdf');
    setStatus(`✅ PDF generated with ${images.length} page${images.length > 1 ? 's' : ''}!`);
  } catch (err) {
    setStatus('PDF generation failed: ' + (err.message || err), true);
  } finally {
    genBtn.disabled = false;
  }
});
