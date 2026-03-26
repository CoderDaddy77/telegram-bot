// Status indicator — pings /api/status every 30 seconds
(function () {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  if (!dot || !label) return;

  function setOnline() {
    dot.classList.remove('status-dot--off', 'status-dot--checking');
    dot.classList.add('status-dot--on');
    label.textContent = 'Online';
  }

  function setOffline() {
    dot.classList.remove('status-dot--on', 'status-dot--checking');
    dot.classList.add('status-dot--off');
    label.textContent = 'Offline';
  }

  function setChecking() {
    dot.classList.remove('status-dot--on', 'status-dot--off');
    dot.classList.add('status-dot--checking');
    label.textContent = 'Checking…';
  }

  async function check() {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (res.ok) {
        setOnline();
      } else {
        setOffline();
      }
    } catch {
      setOffline();
    }
  }

  setChecking();
  check();
  setInterval(check, 30000);
})();
