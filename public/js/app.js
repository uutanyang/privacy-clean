// PrivacyClean — Browser-side file cleaner
// All processing happens locally. Only subscription status hits the API.

// ========================  CONFIG  ========================
let PADDLE_ENV = 'sandbox';
let PADDLE_CLIENT_TOKEN = '';
let PADDLE_PRICE_ID = '';
let PADDLE_LIFETIME_PRICE_ID = '';
let TURNSTILE_SITE_KEY = '';

// Fetch public config from backend (no secrets — only public IDs)
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const cfg = await res.json();
      PADDLE_ENV = cfg.paddleEnv || 'sandbox';
      PADDLE_CLIENT_TOKEN = cfg.paddleClientToken || '';
      PADDLE_PRICE_ID = cfg.paddlePriceId || '';
      PADDLE_LIFETIME_PRICE_ID = cfg.paddleLifetimePriceId || '';
      TURNSTILE_SITE_KEY = cfg.turnstileSiteKey || '';
    }
  } catch {}
}

// ========================  WASM LOADER  ========================
let wasmModule = null;
let wasmLoading = null;

async function loadWasm() {
  if (wasmModule) return wasmModule;
  if (wasmLoading) return wasmLoading;
  wasmLoading = (async () => {
    try {
      const mod = await import('/wasm/privacy_clean_wasm.js');
      await mod.default();
      wasmModule = mod;
      console.log('[WASM] privacy_clean_wasm loaded — lossless metadata stripping enabled');
      return mod;
    } catch (err) {
      console.warn('[WASM] Failed to load, using Canvas fallback:', err.message);
      showToast('WASM unavailable — using lossy Canvas fallback. Images may lose quality.', 'warning');
      return null;
    }
  })();
  return wasmLoading;
}

// ========================  STATE  ========================
let userEmail = localStorage.getItem('pc_email') || '';
let sessionToken = localStorage.getItem('pc_token') || '';
let userTier = 'free'; // 'free' | 'pro' | 'lifetime'
let isPro = false;     // true for pro or lifetime
const processedFiles = []; // { name, blob, url, originalSize, cleanedSize, metadataFound }
let turnstileToken = '';  // stores the latest Turnstile response token

// ========================  DARK MODE  ========================
function initDarkMode() {
  const saved = localStorage.getItem('pc_dark');
  if (saved === 'true' || (!saved && matchMedia('(prefers-color-scheme:dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
}
function toggleDarkMode() {
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('pc_dark', document.documentElement.classList.contains('dark'));
}

// ========================  COOKIE CONSENT  ========================
function initCookieBanner() {
  if (localStorage.getItem('pc_cookies_decided')) return;
  document.getElementById('cookie-banner').classList.add('visible');
}
function acceptCookies() {
  localStorage.setItem('pc_cookies_decided', 'accepted');
  document.getElementById('cookie-banner').classList.remove('visible');
}
function declineCookies() {
  localStorage.setItem('pc_cookies_decided', 'declined');
  document.getElementById('cookie-banner').classList.remove('visible');
}

// ========================  TOAST  ========================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity .3s'; }, 3000);
  setTimeout(() => toast.remove(), 3300);
}

// ========================  TURNSTILE  ========================
function initTurnstile() {
  if (!TURNSTILE_SITE_KEY) return; // Skip if not configured
  const container = document.getElementById('turnstile-container');
  if (!container) return;

  try {
    turnstile.render(container, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token) => { turnstileToken = token; },
      'error-callback': () => { turnstileToken = ''; },
      'expired-callback': () => { turnstileToken = ''; },
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      size: 'normal',
    });
  } catch (e) {
    console.warn('Turnstile not loaded:', e.message);
  }
}

function resetTurnstile() {
  if (!TURNSTILE_SITE_KEY) return;
  try { turnstile.reset(); } catch {}
}

// ========================  MAGIC LINK COUNTDOWN  ========================
let countdownInterval = null;

function startMagicLinkCountdown() {
  const countdownEl = document.getElementById('magic-link-countdown');
  if (!countdownEl) return;
  countdownEl.classList.remove('hidden');

  let secondsLeft = 600; // 10 minutes
  function updateCountdown() {
    if (secondsLeft <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      countdownEl.innerHTML = '<span style="color:#ef4444;font-weight:500">Link expired. Please request a new one.</span>';
      return;
    }
    const minutes = Math.floor(secondsLeft / 60);
    const seconds = secondsLeft % 60;
    countdownEl.innerHTML = `<svg style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:4px" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Link valid for <strong>${minutes}:${String(seconds).padStart(2, '0')}</strong>`;
    secondsLeft--;
  }

  if (countdownInterval) clearInterval(countdownInterval);
  updateCountdown();
  countdownInterval = setInterval(updateCountdown, 1000);
}

// ========================  INIT  ========================
document.addEventListener('DOMContentLoaded', async () => {
  initDarkMode();
  initCookieBanner();
  await loadConfig();
  initPaddle();
  setupDragDrop();
  if (userEmail) checkTier();
  updateUI();
  loadWasm(); // Preload WASM in background
});

function initPaddle() {
  try {
    Paddle.Environment.set(PADDLE_ENV);
    Paddle.Initialize({ token: PADDLE_CLIENT_TOKEN });
  } catch (e) {
    console.warn('Paddle not loaded:', e.message);
  }
}

function setupDragDrop() {
  const zone = document.getElementById('drop-zone');
  ['dragenter','dragover'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault();
    zone.classList.add('dragover');
  }));
  ['dragleave','drop'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault();
    zone.classList.remove('dragover');
  }));
  zone.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
}

// ========================  AUTH (Magic Link)  ========================
function openLoginModal() {
  const modal = document.getElementById('login-modal');
  modal.classList.add('active');
  document.getElementById('login-email').focus();
  setTimeout(() => initTurnstile(), 100);
}

function closeLoginModal() {
  const modal = document.getElementById('login-modal');
  modal.classList.remove('active');
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
  if (e.target.id === 'login-modal') closeLoginModal();
});

async function handleLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  if (!email) return;

  // Check Turnstile if configured
  if (TURNSTILE_SITE_KEY && !turnstileToken) {
    showToast('Please complete the bot verification first.', 'warning');
    return;
  }

  const btn = document.getElementById('login-submit');
  btn.disabled = true;
  btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px"><svg style="width:16px;height:16px;animation:spin 1s linear infinite" fill="none" viewBox="0 0 24 24"><circle style="opacity:0.25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path style="opacity:0.75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Sending...</span>';

  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        action: 'request',
        turnstileToken: turnstileToken || undefined,
      })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Magic link sent! Check your inbox.', 'success');
      startMagicLinkCountdown();
      document.getElementById('login-email').value = '';
      // Don't close modal — show countdown
      // Reset Turnstile for next attempt
      resetTurnstile();
    } else {
      showToast(data.message || 'Something went wrong. Please try again.', 'error');
      resetTurnstile();
    }
  } catch {
    showToast('Network error. Please check your connection and try again.', 'error');
    resetTurnstile();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send magic link';
  }
}

async function loginWithToken(token) {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, action: 'verify' })
  });
  const data = await res.json();
  if (data.email) {
    userEmail = data.email;
    localStorage.setItem('pc_email', userEmail);
    if (data.token) {
      sessionToken = data.token;
      localStorage.setItem('pc_token', sessionToken);
    }
    await checkTier();
    updateUI();
    closeLoginModal();
    showToast('Welcome back! Signed in as ' + userEmail, 'success');
  }
}

// Parse ?token=xxx from magic link callback
if (location.search.includes('token=')) {
  const token = new URLSearchParams(location.search).get('token');
  history.replaceState({}, '', location.pathname);
  loginWithToken(token);
}

function handleLogout() {
  userEmail = '';
  sessionToken = '';
  userTier = 'free';
  isPro = false;
  localStorage.removeItem('pc_email');
  localStorage.removeItem('pc_token');
  updateUI();
  showToast("You've been signed out.", 'info');
}

async function handleDeleteAccount() {
  if (!userEmail) return;
  if (!confirm('This will permanently delete all your data from our servers. This action cannot be undone. Continue?')) return;

  try {
    const headers = { 'x-user-email': userEmail };
    if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
    const res = await fetch('/api/user', { method: 'DELETE', headers });
    const data = await res.json();
    if (data.ok) {
      handleLogout();
      showToast('Your data has been permanently deleted.', 'success');
    } else {
      showToast(data.message || 'Failed to delete data.', 'error');
    }
  } catch {
    showToast('Network error. Please try again.', 'error');
  }
}

// ========================  TIER / API  ========================
async function checkTier() {
  if (!userEmail) return;
  try {
    const headers = { 'x-user-email': userEmail };
    if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
    const res = await fetch('/api/verify', { headers });
    const data = await res.json();
    userTier = data.tier || 'free';
    isPro = data.isPro || userTier === 'pro' || userTier === 'lifetime';
  } catch {
    userTier = 'free';
    isPro = false;
  }
  updateUI();
}

function updateUI() {
  const tierEl = document.getElementById('user-tier');
  const tierLabel = userTier === 'lifetime' ? 'Lifetime' : (isPro ? 'Pro' : 'Free');
  tierEl.textContent = tierLabel;
  // Update tier badge class
  tierEl.className = 'tier-badge';
  if (userTier === 'lifetime') {
    tierEl.classList.add('lifetime');
  } else if (isPro) {
    tierEl.classList.add('pro');
  }
  const btnPro = document.getElementById('btn-pro');
  const btnLogin = document.getElementById('btn-login');
  const btnLogout = document.getElementById('btn-logout');
  const proHint = document.getElementById('pro-hint');
  if (btnPro) btnPro.style.display = isPro ? 'none' : '';
  if (btnLogin) btnLogin.style.display = userEmail ? 'none' : '';
  if (btnLogout) btnLogout.style.display = userEmail ? '' : 'none';
  const btnDelete = document.getElementById('btn-delete');
  if (btnDelete) btnDelete.style.display = userEmail ? '' : 'none';
  if (proHint) proHint.className = isPro ? '' : 'visible';
}

// ========================  CHECKOUT  ========================
function openCheckout(plan) {
  if (!userEmail) {
    openLoginModal();
    return;
  }
  const priceId = plan === 'lifetime' ? PADDLE_LIFETIME_PRICE_ID : PADDLE_PRICE_ID;
  Paddle.Checkout.open({
    items: [{ priceId, quantity: 1 }],
    customer: { email: userEmail },
    settings: {
      successUrl: window.location.origin + '/?refresh=1',
      allowLogout: false
    }
  });
}

// Refresh tier after return from checkout — with polling for webhook delay
if (location.search.includes('refresh=1')) {
  history.replaceState({}, '', location.pathname);
  let attempts = 0;
  const maxAttempts = 10;
  const pollInterval = setInterval(async () => {
    attempts++;
    await checkTier();
    if (isPro || attempts >= maxAttempts) {
      clearInterval(pollInterval);
      if (isPro) showToast('Pro activated! Enjoy your upgraded features.', 'success');
      else if (attempts >= maxAttempts) showToast('Payment detected. Your account will upgrade shortly.', 'info');
    }
  }, 2000);
}

// ========================  FILE HANDLING  ========================
let processingCount = 0;

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function updateBatchBar() {
  const bar = document.getElementById('batch-bar');
  const count = document.getElementById('batch-count');
  if (processedFiles.length > 1) {
    bar.className = 'visible';
    const totalOriginal = processedFiles.reduce((s, f) => s + (f.originalSize || 0), 0);
    const totalCleaned = processedFiles.reduce((s, f) => s + (f.cleanedSize || 0), 0);
    const savedPercent = totalOriginal > 0 ? Math.round((1 - totalCleaned / totalOriginal) * 100) : 0;
    count.textContent = `${processedFiles.length} files cleaned · ${savedPercent > 0 ? savedPercent + '% smaller overall' : 'ready to download'}`;
  } else {
    bar.className = '';
  }
}

function downloadAll() {
  if (processedFiles.length === 0) return;

  if (processedFiles.length === 1) {
    // Single file: direct download
    const f = processedFiles[0];
    const a = document.createElement('a');
    a.href = f.url;
    a.download = f.name;
    a.click();
  } else {
    // Multiple files: download with staggered delay to avoid popup blocker
    processedFiles.forEach((f, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = f.url;
        a.download = f.name;
        a.click();
      }, i * 300);
    });
  }
  showToast(`Downloaded ${processedFiles.length} file${processedFiles.length > 1 ? 's' : ''}`, 'success');
}

function clearAll() {
  processedFiles.forEach(f => URL.revokeObjectURL(f.url));
  processedFiles.length = 0;
  document.getElementById('results').innerHTML = '';
  updateBatchBar();
  showToast('All files cleared', 'info');
}

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

function handleFiles(files) {
  if (!files.length) return;

  // Enforce 50MB per-file limit
  const oversized = Array.from(files).filter(f => f.size > MAX_FILE_SIZE);
  if (oversized.length > 0) {
    const names = oversized.map(f => `${f.name} (${formatSize(f.size)})`).join(', ');
    showToast(`File(s) exceed 50 MB limit: ${names}`, 'error');
    const valid = Array.from(files).filter(f => f.size <= MAX_FILE_SIZE);
    if (!valid.length) return;
    files = valid;
  }

  if (!isPro && files.length > 1) {
    showToast('Free plan is limited to 1 file at a time. Upgrade for batch processing!', 'warning');
    processFile(files[0]);
    return;
  }

  Array.from(files).forEach(processFile);
}

async function processFile(file) {
  const idx = processingCount++;
  const resultBox = document.createElement('div');
  resultBox.className = 'result-card';
  resultBox.innerHTML = `
    <div class="result-header">
      <div class="result-icon">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="1" width="10" height="14" rx="1"/><line x1="6" y1="5" x2="10" y2="5"/><line x1="6" y1="8" x2="10" y2="8"/></svg>
      </div>
      <div style="flex:1;min-width:0">
        <div class="result-name">${file.name}</div>
        <div class="result-size">${formatSize(file.size)} · ${file.type || 'unknown'}</div>
      </div>
      <div id="actions-${idx}" style="flex-shrink:0"></div>
    </div>
    <div class="progress-track"><div id="progress-${idx}" class="progress-fill" style="width:0%"></div></div>
    <div id="status-${idx}" class="result-status">Scanning metadata...</div>
    <div id="metadata-${idx}" style="margin-top:8px;display:none"></div>
  `;
  document.getElementById('results').prepend(resultBox);

  // Animate progress bar
  const progressEl = document.getElementById(`progress-${idx}`);
  const statusEl = document.getElementById(`status-${idx}`);
  let progress = 0;
  const progressInterval = setInterval(() => {
    progress = Math.min(progress + Math.random() * 25, 90);
    progressEl.style.width = progress + '%';
  }, 200);

  try {
    const { cleaned, metadataFound, metadataDetail } = await stripMetadataWithReport(file);
    clearInterval(progressInterval);
    progressEl.style.width = '100%';

    const url = URL.createObjectURL(cleaned);
    const savedPercent = file.size > 0 ? Math.round((1 - cleaned.size / file.size) * 100) : 0;
    const savedText = savedPercent > 0 ? ` • ${savedPercent}% smaller` : '';
    const metaCount = metadataFound.length;

    statusEl.textContent = `Cleaned · ${formatSize(cleaned.size)}${savedText} · ${metaCount} metadata field${metaCount !== 1 ? 's' : ''} removed`;
    statusEl.className = 'result-status done';

    // Show metadata tags
    if (metaCount > 0) {
      const metaEl = document.getElementById(`metadata-${idx}`);
      metaEl.style.display = 'block';
      metaEl.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${metadataFound.slice(0, 8).map(m =>
            `<span class="meta-tag">${m}</span>`
          ).join('')}
          ${metaCount > 8 ? `<span class="meta-tag" style="border-color:var(--border-strong);color:var(--fg-dim)">+${metaCount - 8}</span>` : ''}
        </div>
      `;
    }

    document.getElementById(`actions-${idx}`).innerHTML = `
      <a href="${url}" download="cleaned-${file.name}" class="btn btn-accent btn-sm" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download
      </a>
    `;

    processedFiles.push({
      name: `cleaned-${file.name}`,
      blob: cleaned,
      url,
      originalSize: file.size,
      cleanedSize: cleaned.size,
      metadataFound,
      metadataDetail: metadataDetail || [],
    });
    updateBatchBar();
  } catch (err) {
    clearInterval(progressInterval);
    progressEl.style.width = '100%';
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.className = 'result-status error';
  }
}

// ========================  METADATA STRIPPER  ========================
async function stripMetadataWithReport(file) {
  // Try WASM first (lossless, no re-encoding)
  await loadWasm();
  if (wasmModule) {
    try {
      const buf = await file.arrayBuffer();
      const mime = file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
      const report = wasmModule.analyze_metadata(new Uint8Array(buf), mime);
      const metadataFound = report.fields().map(f => f.toString());
      const result = wasmModule.strip_metadata(new Uint8Array(buf), mime);
      return {
        cleaned: new File([result], file.name, { type: mime }),
        metadataFound
      };
    } catch (err) {
      console.warn('[WASM] Strip failed, falling back to Canvas:', err.message);
    }
  }

  // Fallback: Canvas re-encode (lossy for JPEG)
  if (file.type.startsWith('image/')) {
    return await stripImageMetadataWithReport(file);
  }
  if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
    return await stripPdfMetadataWithReport(file);
  }
  throw new Error('Unsupported file type. Use JPG, PNG, TIFF, WebP, or PDF.');
}

// ── Canvas fallback (lossy for JPEG, lossless for PNG) ──
async function stripImageMetadataWithReport(file) {
  const metadataFound = [];

  try {
    const buf = await file.arrayBuffer();
    const view = new DataView(buf);

    // Check for EXIF marker (JPEG)
    if (file.type === 'image/jpeg' && view.getUint16(0) === 0xFFD8) {
      let offset = 2;
      while (offset < view.byteLength - 1) {
        const marker = view.getUint16(offset);
        if (marker === 0xFFE1) { // APP1 - EXIF
          metadataFound.push('EXIF');
          break;
        }
        if ((marker & 0xFF00) !== 0xFF00) break;
        offset += 2 + view.getUint16(offset + 2);
      }
    }

    // Check for GPS via simple pattern
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (text.includes('GPS')) metadataFound.push('GPS');
    if (text.includes('IPTC')) metadataFound.push('IPTC');
    if (text.includes('XMP') || text.includes('xmpmeta')) metadataFound.push('XMP');
    if (text.includes('Photoshop')) metadataFound.push('Photoshop');
    if (text.includes('ICC_Profile')) metadataFound.push('ICC Profile');

    // Remove duplicates
    const unique = [...new Set(metadataFound)];
    unique.sort();
    return { cleaned: await stripImageMetadata(file), metadataFound: unique };
  } catch {
    return { cleaned: await stripImageMetadata(file), metadataFound: ['Metadata'] };
  }
}

function stripImageMetadata(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);

      const quality = file.type === 'image/png' ? undefined : 0.92;
      const outputType = file.type === 'image/png' ? 'image/png' : file.type;

      canvas.toBlob(blob => {
        if (!blob) return reject(new Error('Canvas encoding failed'));
        resolve(new File([blob], file.name, { type: outputType }));
      }, outputType, quality);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image. Make sure the file is a valid image.'));
    };

    img.src = url;
  });
}

// ── PDF fallback (byte-level safe stripping using latin-1) ──
async function stripPdfMetadataWithReport(file) {
  const metadataFound = [];
  const metadataDetail = [];
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  // Detect metadata fields from text representation
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const fieldPatterns = [
    { name: 'Author', pattern: /\/Author\s*\(([^)]*)\)/i },
    { name: 'Creator', pattern: /\/Creator\s*\(([^)]*)\)/i },
    { name: 'Producer', pattern: /\/Producer\s*\(([^)]*)\)/i },
    { name: 'Title', pattern: /\/Title\s*\(([^)]*)\)/i },
    { name: 'Subject', pattern: /\/Subject\s*\(([^)]*)\)/i },
    { name: 'Keywords', pattern: /\/Keywords\s*\(([^)]*)\)/i },
    { name: 'CreationDate', pattern: /\/CreationDate\s*\(([^)]*)\)/i },
    { name: 'ModDate', pattern: /\/ModDate\s*\(([^)]*)\)/i },
  ];

  fieldPatterns.forEach(f => {
    const match = f.pattern.exec(text);
    if (match) {
      metadataFound.push(f.name);
      metadataDetail.push({ field: f.name, value: match[1] || '(empty)' });
    }
  });
  if (/<x:xmpmeta/i.test(text)) {
    metadataFound.push('XMP');
    metadataDetail.push({ field: 'XMP', value: '(XML metadata stream)' });
  }

  const cleaned = await stripPdfMetadata(bytes);
  return { cleaned, metadataFound, metadataDetail };
}

async function stripPdfMetadata(bytesOrFile) {
  let bytes;
  if (bytesOrFile instanceof Uint8Array) {
    bytes = bytesOrFile;
  } else {
    const buf = await bytesOrFile.arrayBuffer();
    bytes = new Uint8Array(buf);
  }

  // Byte-level safe stripping: use Uint8Array operations directly
  // Avoids latin-1 string concatenation which is O(n²) for large files
  let result = new Uint8Array(bytes);

  // Collect all replacements as [start, end, replacementBytes] tuples
  const replacements = [];

  // Remove XMP metadata
  const xmpPattern = /<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/gi;
  let match;
  const textForSearch = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  while ((match = xmpPattern.exec(textForSearch)) !== null) {
    const beforeMatch = textForSearch.substring(0, match.index);
    const byteStart = new TextEncoder().encode(beforeMatch).length;
    const matchBytes = new TextEncoder().encode(match[0]);
    // Replace XMP with spaces to preserve byte offsets
    replacements.push([byteStart, byteStart + matchBytes.length, new Uint8Array(matchBytes.length).fill(0x20)]);
  }

  // Clear metadata field values
  const fieldNames = ['Author', 'Creator', 'Producer', 'Title', 'Subject', 'Keywords', 'CreationDate', 'ModDate'];
  for (const field of fieldNames) {
    const parenPattern = new RegExp(`/${field}\\s*\\([^)]*\\)`, 'gi');
    const hexPattern = new RegExp(`/${field}\\s*<[^>]*>`, 'gi');

    for (const pattern of [parenPattern, hexPattern]) {
      while ((match = pattern.exec(textForSearch)) !== null) {
        const beforeMatch = textForSearch.substring(0, match.index);
        const byteStart = new TextEncoder().encode(beforeMatch).length;
        const matchBytes = new TextEncoder().encode(match[0]);
        const matchStr = match[0];
        const parenIdx = matchStr.indexOf('(');
        const hexIdx = matchStr.indexOf('<');
        let clearStart, clearEnd;
        if (parenIdx !== -1) {
          clearStart = byteStart + parenIdx + 1;
          clearEnd = byteStart + matchBytes.length - 1;
        } else if (hexIdx !== -1) {
          clearStart = byteStart + hexIdx + 1;
          clearEnd = byteStart + matchBytes.length - 1;
        } else {
          continue;
        }
        if (clearStart < clearEnd) {
          const spaces = new Uint8Array(clearEnd - clearStart).fill(0x20);
          replacements.push([clearStart, clearEnd, spaces]);
        }
      }
    }
  }

  // Sort replacements by start position (reverse order for safe in-place editing)
  replacements.sort((a, b) => b[0] - a[0]);

  // Apply replacements (from end to start to preserve offsets)
  for (const [start, end, replacement] of replacements) {
    const before = result.slice(0, start);
    const after = result.slice(end);
    result = new Uint8Array([...before, ...replacement, ...after]);
  }

  return new File([result], 'document.pdf', { type: 'application/pdf' });
}

// ========================  MOBILE NAV  ========================
function toggleMobileNav() {
  const nav = document.querySelector('.nav-links');
  const hamburger = document.querySelector('.hamburger');
  if (!nav || !hamburger) return;
  const isOpen = nav.classList.toggle('open');
  hamburger.classList.toggle('active', isOpen);
  hamburger.setAttribute('aria-expanded', isOpen);
}

// Close mobile nav when clicking a link
document.addEventListener('click', (e) => {
  if (e.target.closest('.nav-links a')) {
    const nav = document.querySelector('.nav-links');
    const hamburger = document.querySelector('.hamburger');
    if (nav) nav.classList.remove('open');
    if (hamburger) { hamburger.classList.remove('active'); hamburger.setAttribute('aria-expanded', 'false'); }
  }
});

// ========================  KEYBOARD SHORTCUTS  ========================
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLoginModal();
  // Ctrl/Cmd + U = open file picker
  if ((e.ctrlKey || e.metaKey) && e.key === 'u') {
    e.preventDefault();
    document.getElementById('file-input').click();
  }
});

// ========================  SMOOTH SCROLL  ========================
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const id = a.getAttribute('href').slice(1);
    const el = document.getElementById(id);
    if (el) {
      e.preventDefault();
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// ========================  GLOBALS  ========================
window.handleFiles = handleFiles;
window.openCheckout = openCheckout;
window.openLoginModal = openLoginModal;
window.closeLoginModal = closeLoginModal;
window.handleLoginSubmit = handleLoginSubmit;
window.handleLogout = handleLogout;
window.toggleDarkMode = toggleDarkMode;
window.downloadAll = downloadAll;
window.clearAll = clearAll;
window.acceptCookies = acceptCookies;
window.declineCookies = declineCookies;
window.downloadAuditReport = downloadAuditReport;
window.handleDeleteAccount = handleDeleteAccount;

// ========================  AUDIT REPORT (Pro)  ========================
function downloadAuditReport() {
  if (!isPro) {
    showToast('Audit report is a Pro feature. Upgrade to access!', 'warning');
    return;
  }
  if (processedFiles.length === 0) {
    showToast('No files processed yet', 'warning');
    return;
  }

  const rows = [['File', 'Original Size', 'Cleaned Size', 'Fields Removed', 'Details']];
  processedFiles.forEach(f => {
    const detail = (f.metadataDetail || []).map(d => `${d.field}: ${d.value}`).join('; ');
    rows.push([
      f.name,
      formatSize(f.originalSize),
      formatSize(f.cleanedSize),
      f.metadataFound.join(', '),
      detail || '(no details)',
    ]);
  });

  const csv = rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `privacyclean-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Audit report downloaded', 'success');
}
