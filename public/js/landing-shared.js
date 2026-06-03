// PrivacyClean — Shared WASM Loader + File Processing for SEO landing pages
// Loads the WASM module on first use, falls back to Canvas/JS if unavailable

// ========================  WASM LOADER  ========================
let wasmModule = null;
let wasmLoading = null;

async function loadWasm() {
  if (wasmModule) return wasmModule;
  if (wasmLoading) return wasmLoading;

  wasmLoading = (async () => {
    try {
      const module = await import('/wasm/privacy_clean_wasm.js');
      await module.default();
      wasmModule = module;
      window.PrivacyCleanWasm = module;
      console.log('[WASM] privacy_clean_wasm loaded successfully');
      return module;
    } catch (err) {
      console.warn('[WASM] Failed to load, using Canvas fallback:', err.message);
      return null;
    }
  });

  return wasmLoading;
}

// ========================  TIER / AUTH STATE  ========================
let userEmail = localStorage.getItem('pc_email') || '';
let userTier = 'free';
let isPro = false;
const processedFiles = [];

async function checkTier() {
  if (!userEmail) return;
  try {
    const res = await fetch('/api/verify', { headers: { 'x-user-email': userEmail } });
    const data = await res.json();
    userTier = data.tier || 'free';
    isPro = data.isPro || userTier === 'pro' || userTier === 'lifetime';
  } catch {
    userTier = 'free';
    isPro = false;
  }
  updateTierUI();
}

function updateTierUI() {
  const tierEl = document.getElementById('user-tier');
  if (tierEl) {
    const label = userTier === 'lifetime' ? 'Lifetime' : (isPro ? 'Pro' : 'Free');
    tierEl.textContent = label;
    tierEl.className = 'tier-badge';
    if (userTier === 'lifetime') tierEl.classList.add('lifetime');
    else if (isPro) tierEl.classList.add('pro');
  }
  const proHint = document.getElementById('pro-hint');
  if (proHint) proHint.className = isPro ? '' : 'visible';
}

// Parse ?token=xxx from magic link callback
if (location.search.includes('token=')) {
  const token = new URLSearchParams(location.search).get('token');
  history.replaceState({}, '', location.pathname);
  (async () => {
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action: 'verify' })
      });
      const data = await res.json();
      if (data.email) {
        userEmail = data.email;
        localStorage.setItem('pc_email', userEmail);
        await checkTier();
      }
    } catch {}
  })();
}

// ========================  SHARED UTILITIES  ========================
function formatSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity .3s'; }, 3000);
  setTimeout(() => toast.remove(), 3300);
}

// ========================  BATCH BAR  ========================
function updateBatchBar() {
  const bar = document.getElementById('batch-bar');
  const count = document.getElementById('batch-count');
  if (!bar) return;
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
  processedFiles.forEach(f => {
    const a = document.createElement('a');
    a.href = f.url;
    a.download = f.name;
    a.click();
  });
  showToast(`Downloaded ${processedFiles.length} file${processedFiles.length > 1 ? 's' : ''}`, 'success');
}

function clearAll() {
  processedFiles.forEach(f => URL.revokeObjectURL(f.url));
  processedFiles.length = 0;
  document.getElementById('results').innerHTML = '';
  updateBatchBar();
  showToast('All files cleared', 'info');
}

// ========================  DRAG & DROP  ========================
function setupDragDrop() {
  const z = document.getElementById('drop-zone');
  if (!z) return;
  ['dragenter', 'dragover'].forEach(e => z.addEventListener(e, ev => {
    ev.preventDefault();
    z.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(e => z.addEventListener(e, ev => {
    ev.preventDefault();
    z.classList.remove('dragover');
  }));
  z.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
}

// ========================  FILE HANDLING  ========================
function handleFiles(files) {
  if (!files.length) return;

  // Free users: single file only
  if (!isPro && files.length > 1) {
    showToast('Free plan is limited to 1 file at a time. Upgrade for batch processing!', 'warning');
    processFile(files[0]);
    return;
  }

  Array.from(files).forEach(processFile);
}

async function processFile(file) {
  const r = document.createElement('div');
  r.className = 'result-card';

  // Determine icon based on file type
  const isPdf = file.type === 'application/pdf' || file.name.endsWith('.pdf');
  const iconSvg = isPdf
    ? '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="1" width="10" height="14" rx="1"/><line x1="6" y1="5" x2="10" y2="5"/><line x1="6" y1="8" x2="10" y2="8"/></svg>'
    : '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="1"/><circle cx="8" cy="8" r="2"/></svg>';
  const scanLabel = isPdf ? 'Scanning PDF metadata...' : 'Scanning EXIF...';

  r.innerHTML = `<div class="result-header"><div class="result-icon">${iconSvg}</div><div style="flex:1;min-width:0"><div class="result-name">${file.name}</div><div class="result-size">${formatSize(file.size)}</div></div></div><div class="progress-track"><div id="p" class="progress-fill" style="width:0%"></div></div><div id="s" class="result-status">${scanLabel}</div><div id="m" style="margin-top:8px;display:none"></div><div id="a" style="margin-top:8px"></div>`;
  document.getElementById('results').prepend(r);

  const pe = r.querySelector('#p'), se = r.querySelector('#s');
  let pg = 0;
  const pi = setInterval(() => {
    pg = Math.min(pg + Math.random() * 25, 90);
    pe.style.width = pg + '%';
  }, 200);

  try {
    let cleaned, metadataFound = [], metadataDetail = [];

    // Try WASM first
    await loadWasm();
    if (wasmModule) {
      const buf = await file.arrayBuffer();
      const mime = file.type || (isPdf ? 'application/pdf' : 'image/jpeg');
      const report = wasmModule.analyze_metadata(new Uint8Array(buf), mime);
      metadataFound = report.fields().map(f => f.toString());
      const result = wasmModule.strip_metadata(new Uint8Array(buf), mime);
      cleaned = new File([result], file.name, { type: mime });
    } else {
      // Fallback
      if (isPdf) {
        const result = await stripPdfFallback(file);
        cleaned = result.cleaned;
        metadataFound = result.metadataFound;
        metadataDetail = result.metadataDetail || [];
      } else {
        const result = await stripImageFallback(file);
        cleaned = result.cleaned;
        metadataFound = result.metadataFound;
      }
    }

    clearInterval(pi);
    pe.style.width = '100%';
    const url = URL.createObjectURL(cleaned);
    const sv = file.size > 0 ? Math.round((1 - cleaned.size / file.size) * 100) : 0;
    const st = sv > 0 ? ` · ${sv}% smaller` : '';
    se.textContent = `Cleaned · ${formatSize(cleaned.size)}${st} · ${metadataFound.length} field${metadataFound.length !== 1 ? 's' : ''} removed`;
    se.className = 'result-status done';

    if (metadataFound.length > 0) {
      const me = r.querySelector('#m');
      me.style.display = 'block';
      me.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:4px">${metadataFound.slice(0, 8).map(m => `<span class="meta-tag stripped">${m}</span>`).join('')}${metadataFound.length > 8 ? `<span class="meta-tag" style="border-color:var(--border-strong);color:var(--fg-dim)">+${metadataFound.length - 8}</span>` : ''}</div>`;
    }

    r.querySelector('#a').innerHTML = `<a href="${url}" download="cleaned-${file.name}" class="btn btn-accent btn-sm" style="display:inline-flex;align-items:center;gap:6px"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download</a>`;

    processedFiles.push({
      name: `cleaned-${file.name}`,
      url,
      originalSize: file.size,
      cleanedSize: cleaned.size,
      metadataFound,
      metadataDetail,
    });
    updateBatchBar();
  } catch (err) {
    clearInterval(pi);
    pe.style.width = '100%';
    se.textContent = 'Error: ' + err.message;
    se.className = 'result-status error';
  }
}

// ========================  IMAGE FALLBACK (Canvas)  ========================
async function stripImageFallback(file) {
  const metadataFound = [];
  const buf = await file.arrayBuffer();
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const view = new DataView(buf);

  if (file.type === 'image/jpeg' && view.getUint16(0) === 0xFFD8) {
    let o = 2;
    while (o < view.byteLength - 1) {
      const m = view.getUint16(o);
      if (m === 0xFFE1) { metadataFound.push('EXIF'); break; }
      if ((m & 0xFF00) !== 0xFF00) break;
      o += 2 + view.getUint16(o + 2);
    }
  }

  if (text.includes('GPS')) metadataFound.push('GPS');
  if (text.includes('IPTC')) metadataFound.push('IPTC');
  if (text.includes('XMP') || text.includes('xmpmeta')) metadataFound.push('XMP');

  const unique = [...new Set(metadataFound)].sort();

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      c.toBlob(blob => {
        if (!blob) return reject(new Error('Canvas encoding failed'));
        resolve({ cleaned: new File([blob], file.name, { type: file.type }), metadataFound: unique });
      }, file.type, 0.92);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}

// ========================  PDF FALLBACK (byte-level safe)  ========================
async function stripPdfFallback(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const metadataFound = [];
  const metadataDetail = [];

  // Detect metadata fields using byte-level scanning
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

  // Byte-level safe stripping: work on Uint8Array directly
  // Convert to string for regex operations, then back to bytes
  // This preserves binary streams (images, fonts) that TextDecoder may corrupt
  let result = new Uint8Array(buf);

  // For text-based operations, use the latin-1 encoding which preserves byte values
  let str = '';
  for (let i = 0; i < result.length; i++) {
    str += String.fromCharCode(result[i]);
  }

  // Remove XMP metadata
  str = str.replace(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/gi, '');

  // Clear metadata field values (replace value with empty string, keep structure)
  str = str.replace(/\/Author\s*\([^)]*\)/gi, '/Author ()');
  str = str.replace(/\/Creator\s*\([^)]*\)/gi, '/Creator ()');
  str = str.replace(/\/Producer\s*\([^)]*\)/gi, '/Producer ()');
  str = str.replace(/\/Title\s*\([^)]*\)/gi, '/Title ()');
  str = str.replace(/\/Subject\s*\([^)]*\)/gi, '/Subject ()');
  str = str.replace(/\/Keywords\s*\([^)]*\)/gi, '/Keywords ()');
  str = str.replace(/\/CreationDate\s*\([^)]*\)/gi, '/CreationDate ()');
  str = str.replace(/\/ModDate\s*\([^)]*\)/gi, '/ModDate ()');

  // Convert back to bytes using latin-1 (preserves byte values exactly)
  const cleaned = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    cleaned[i] = str.charCodeAt(i);
  }

  return {
    cleaned: new File([cleaned], file.name, { type: 'application/pdf' }),
    metadataFound,
    metadataDetail,
  };
}

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

// ========================  INIT  ========================
document.addEventListener('DOMContentLoaded', async () => {
  setupDragDrop();
  loadWasm(); // Preload WASM in background
  if (userEmail) await checkTier();
  updateTierUI();
});

// ========================  GLOBALS  ========================
window.handleFiles = handleFiles;
window.downloadAll = downloadAll;
window.clearAll = clearAll;
window.downloadAuditReport = downloadAuditReport;
