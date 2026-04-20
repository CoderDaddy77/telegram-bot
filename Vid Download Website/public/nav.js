// Shared navigation component — injected into all pages
(function () {
  const mainLinks = [
    { href: '/', label: 'Home' },
    { href: '/downloader', label: '⬇ Downloader', hot: true },
    { href: '/mp3', label: 'Video to MP3' },
    { href: '/convert', label: 'WAV → MP3' },
    { href: '/compressor', label: 'Image Compressor' },
    { href: '/compressor/video', label: 'Video Compressor' },
    { href: '/about', label: 'About' },
  ];

  const toolLinks = [
    { href: '/image-converter', label: '🔄 Image Converter' },
    { href: '/images-to-pdf', label: '🖼️ Images to PDF' },
    { href: '/word-to-pdf', label: '📝 Word to PDF' },
    { href: '/ppt-to-pdf', label: '📊 PPT to PDF' },
  ];

  const nav = document.getElementById('main-nav');
  if (!nav) return;

  const currentPath = window.location.pathname.replace(/\.html$/, '');

  // Inject dropdown styles once
  if (!document.getElementById('nav-dropdown-styles')) {
    const s = document.createElement('style');
    s.id = 'nav-dropdown-styles';
    s.textContent = `
      .nav-dropdown { position: relative; }
      .nav-dropdown-btn {
        display: flex; align-items: center; gap: 4px;
        padding: 5px 10px; border-radius: 8px;
        font-size: 0.8rem; font-weight: 500;
        color: var(--muted); background: none; border: none;
        cursor: pointer; font-family: inherit;
        white-space: nowrap; flex-shrink: 0;
        transition: color 150ms, background 150ms;
      }
      .nav-dropdown-btn:hover, .nav-dropdown-btn.active {
        color: var(--text); background: rgba(0,0,0,0.04);
        transform: none; box-shadow: none;
      }
      .nav-dropdown-btn.active { font-weight: 600; color: var(--text); }
      .nav-dropdown-menu {
        display: none; position: absolute; top: calc(100% + 6px); right: 0;
        background: #fff; border: 1px solid var(--line);
        border-radius: 12px; padding: 6px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.06);
        min-width: 200px; z-index: 200;
        animation: navDropIn 180ms ease;
      }
      @keyframes navDropIn {
        from { opacity:0; transform:translateY(-4px); }
        to   { opacity:1; transform:translateY(0); }
      }
      .nav-dropdown-menu.open { display: block; }
      .nav-dropdown-menu a {
        display: block; padding: 8px 12px; border-radius: 8px;
        font-size: 0.85rem; font-weight: 500; text-decoration: none;
        color: var(--muted); transition: background 120ms, color 120ms;
        white-space: nowrap;
      }
      .nav-dropdown-menu a:hover { background: rgba(0,0,0,0.04); color: var(--text); }
      .nav-dropdown-menu a.active { color: var(--accent-dark); font-weight: 600; background: rgba(198,77,25,0.06); }
      .nav-dropdown-arrow { font-size: 0.65rem; opacity: 0.6; transition: transform 200ms; }
      .nav-dropdown-btn[aria-expanded="true"] .nav-dropdown-arrow { transform: rotate(180deg); }
    `;
    document.head.appendChild(s);
  }

  // Check if current path is a tool link
  const isToolActive = toolLinks.some(t => currentPath === t.href);

  // Regular nav links
  mainLinks.forEach(item => {
    const a = document.createElement('a');
    a.href = item.href;
    a.className = 'nav-link';
    if (item.hot) a.classList.add('nav-link--hot');
    a.textContent = item.label;
    if (currentPath === item.href) a.classList.add('active');
    nav.appendChild(a);
  });

  // Tools dropdown
  const dropdown = document.createElement('div');
  dropdown.className = 'nav-dropdown';

  const btn = document.createElement('button');
  btn.className = 'nav-dropdown-btn' + (isToolActive ? ' active' : '');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = 'File Tools <span class="nav-dropdown-arrow">▼</span>';

  const menu = document.createElement('div');
  menu.className = 'nav-dropdown-menu';

  toolLinks.forEach(item => {
    const a = document.createElement('a');
    a.href = item.href;
    a.textContent = item.label;
    if (currentPath === item.href) a.classList.add('active');
    menu.appendChild(a);
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.toggle('open');
    btn.setAttribute('aria-expanded', isOpen);
  });

  document.addEventListener('click', () => {
    menu.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  });

  dropdown.appendChild(btn);
  dropdown.appendChild(menu);
  nav.appendChild(dropdown);
})();
