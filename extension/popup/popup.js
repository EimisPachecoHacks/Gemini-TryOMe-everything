/**
 * GeminiTryOnMe - Popup Script
 * Auth wizard + profile management
 */

const MAX_IMAGE_DIMENSION = 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DEFAULT_BACKEND_URL = 'https://geminitryonme-backend-81189935460.us-central1.run.app';

// HTML escape helper to prevent XSS in innerHTML
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// State
let pendingSignupEmail = '';
let cachedProfile = null;

// Multi-photo upload state for wizard step 2
let userPhotos = { body: [null, null, null], face: [null, null] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(viewId).classList.remove('hidden');
}

function showError(elemId, msg) {
  const el = document.getElementById(elemId);
  if (el) el.textContent = msg;
}

function clearError(elemId) {
  const el = document.getElementById(elemId);
  if (el) el.textContent = '';
}

function setLoading(btn, loading) {
  if (loading) {
    btn.classList.add('loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

function showToast(msg, duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => { toast.classList.remove('show'); }, duration);
}

/**
 * Lightweight canvas confetti burst for celebration moments.
 * Spawns colorful particles that fall with gravity and fade out.
 */
function launchConfetti(durationMs = 3000) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ['#FF9900', '#FF6600', '#FFD700', '#00C853', '#2979FF', '#E040FB', '#FF4081', '#00E5FF'];
  const particles = [];

  for (let i = 0; i < 120; i++) {
    particles.push({
      x: canvas.width / 2 + (Math.random() - 0.5) * canvas.width * 0.5,
      y: canvas.height * 0.3,
      vx: (Math.random() - 0.5) * 12,
      vy: Math.random() * -14 - 4,
      w: Math.random() * 8 + 4,
      h: Math.random() * 6 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 12,
      opacity: 1,
    });
  }

  const start = Date.now();
  function frame() {
    const elapsed = Date.now() - start;
    if (elapsed > durationMs) {
      canvas.remove();
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const fadeStart = durationMs * 0.6;
    for (const p of particles) {
      p.x += p.vx;
      p.vy += 0.25; // gravity
      p.y += p.vy;
      p.rotation += p.rotationSpeed;
      if (elapsed > fadeStart) {
        p.opacity = Math.max(0, 1 - (elapsed - fadeStart) / (durationMs - fadeStart));
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.globalAlpha = p.opacity;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function getProductUrl(productIdOrItem, retailer) {
  // If passed a favorite object, use stored productUrl if available
  if (typeof productIdOrItem === 'object' && productIdOrItem !== null) {
    if (productIdOrItem.productUrl) return productIdOrItem.productUrl;
    const id = productIdOrItem.productId || productIdOrItem.asin;
    retailer = productIdOrItem.retailer || retailer || 'amazon';
    if (!id) return '#';
    return getProductUrl(id, retailer);
  }
  const productId = productIdOrItem;
  switch (retailer) {
    case 'amazon': return `https://www.amazon.com/dp/${productId}`;
    case 'shein': return `https://us.shein.com/goods-p-${productId}.html`;
    case 'temu': return `https://www.temu.com/goods-${productId}.html`;
    default: return '#';
  }
}

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res && res.error) return reject(new Error(res.error));
      resolve(res?.data || res);
    });
  });
}

function processImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
          if (width > height) {
            height = Math.round(height * (MAX_IMAGE_DIMENSION / width));
            width = MAX_IMAGE_DIMENSION;
          } else {
            width = Math.round(width * (MAX_IMAGE_DIMENSION / height));
            height = MAX_IMAGE_DIMENSION;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const base64 = dataUrl.split(',')[1];
        const sizeKB = Math.round((base64.length * 3) / 4 / 1024);
        resolve({ base64, width, height, sizeKB });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function calculateAge(birthday) {
  const birth = new Date(birthday);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function handleLogin() {
  const btn = document.getElementById('loginBtn');
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  clearError('loginError');

  if (!email || !password) {
    showError('loginError', 'Please enter email and password');
    return;
  }

  setLoading(btn, true);
  try {
    const tokens = await sendMsg({
      type: 'API_CALL', endpoint: '/api/auth/login', method: 'POST',
      data: { email, password }
    });
    await chrome.storage.local.set({
      authTokens: {
        idToken: tokens.idToken,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: Date.now() + (tokens.expiresIn * 1000),
      },
      userEmail: email,
    });
    await loadProfileAndRoute();
  } catch (err) {
    // If email not verified, resend code and go to verify screen
    if (err.message.includes('verify your email') || err.message.includes('UserNotConfirmedException')) {
      pendingSignupEmail = email;
      await chrome.storage.local.set({ pendingEmail: email, pendingPassword: password });
      // Resend verification code
      try {
        await sendMsg({
          type: 'API_CALL', endpoint: '/api/auth/resend-code', method: 'POST',
          data: { email }
        });
      } catch (_) { /* ignore resend error */ }
      document.getElementById('verifyEmailDisplay').textContent = email;
      showView('viewVerify');
    } else {
      showError('loginError', err.message);
    }
  } finally {
    setLoading(btn, false);
  }
}

async function handleSignup() {
  const btn = document.getElementById('signupBtn');
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const confirm = document.getElementById('signupConfirm').value;
  clearError('signupError');

  if (!email || !password) {
    showError('signupError', 'Please fill in all fields');
    return;
  }
  if (password !== confirm) {
    showError('signupError', 'Passwords do not match');
    return;
  }
  if (password.length < 8) {
    showError('signupError', 'Password must be at least 8 characters');
    return;
  }

  setLoading(btn, true);
  try {
    const signupResult = await sendMsg({
      type: 'API_CALL', endpoint: '/api/auth/signup', method: 'POST',
      data: { email, password }
    });
    console.log('[popup] Signup result:', signupResult);

    // Backend auto-verifies users, so login immediately
    const tokens = await sendMsg({
      type: 'API_CALL', endpoint: '/api/auth/login', method: 'POST',
      data: { email, password }
    });
    console.log('[popup] Auto-login after signup succeeded');
    await chrome.storage.local.set({
      authTokens: {
        idToken: tokens.idToken,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: Date.now() + (tokens.expiresIn * 1000),
      },
      userEmail: email,
    });
    showView('viewWizard1');
  } catch (err) {
    console.error('[popup] Signup failed:', err.message);
    showError('signupError', err.message);
  } finally {
    setLoading(btn, false);
  }
}

async function handleVerify() {
  const btn = document.getElementById('verifyBtn');
  const code = document.getElementById('verifyCode').value.trim();
  clearError('verifyError');

  if (!code || code.length < 6) {
    showError('verifyError', 'Please enter the 6-digit code');
    return;
  }

  setLoading(btn, true);
  try {
    const stored = await chrome.storage.local.get(['pendingEmail', 'pendingPassword']);
    const email = pendingSignupEmail || stored.pendingEmail;

    await sendMsg({
      type: 'API_CALL', endpoint: '/api/auth/confirm', method: 'POST',
      data: { email, code }
    });

    // Auto-login after verification
    const password = stored.pendingPassword;
    if (password) {
      const tokens = await sendMsg({
        type: 'API_CALL', endpoint: '/api/auth/login', method: 'POST',
        data: { email, password }
      });
      await chrome.storage.local.set({
        authTokens: {
          idToken: tokens.idToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: Date.now() + (tokens.expiresIn * 1000),
        },
        userEmail: email,
      });
      await chrome.storage.local.remove(['pendingEmail', 'pendingPassword']);
      // Go to wizard step 1
      showView('viewWizard1');
    }
  } catch (err) {
    showError('verifyError', err.message);
  } finally {
    setLoading(btn, false);
  }
}

async function handleResendCode() {
  const stored = await chrome.storage.local.get(['pendingEmail']);
  const email = pendingSignupEmail || stored.pendingEmail;
  if (!email) return;
  try {
    await sendMsg({
      type: 'API_CALL', endpoint: '/api/auth/resend-code', method: 'POST',
      data: { email }
    });
    showError('verifyError', 'Code resent! Check your email.');
    document.getElementById('verifyError').style.color = '#067d62';
  } catch (err) {
    showError('verifyError', err.message);
  }
}

async function handleSignOut() {
  await chrome.storage.local.remove(['authTokens', 'userEmail']);
  showToast('Signed out successfully');
  showView('viewSignIn');
}

async function handleDeleteAccount() {
  const confirmed = confirm(
    'Are you sure you want to delete your account?\n\n' +
    'This will permanently remove all your data including photos, videos, and favorites. This action cannot be undone.'
  );
  if (!confirmed) return;

  const btn = document.getElementById('deleteAccountBtn');
  setLoading(btn, true);
  try {
    await sendMsg({
      type: 'API_CALL', endpoint: '/api/account', method: 'DELETE', data: {}
    });
    await chrome.storage.local.clear();
    showToast('Account deleted successfully');
    showView('viewSignIn');
  } catch (err) {
    showToast('Failed to delete account: ' + err.message);
  } finally {
    setLoading(btn, false);
  }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

async function loadProfileAndRoute() {
  try {
    const profile = await sendMsg({
      type: 'API_CALL', endpoint: '/api/profile', method: 'GET', data: {}
    });

    if (profile && profile.profileComplete) {
      showProfileView(profile);
    } else if (profile && profile.firstName) {
      // Partially complete - figure out where they left off
      if (!profile.bodyPhotoKey) {
        showView('viewWizard2');
      } else if (!profile.facePhotoKey) {
        showView('viewWizard3');
      } else {
        showView('viewWizard1');
      }
    } else {
      showView('viewWizard1');
    }
  } catch (err) {
    console.error('[popup] Failed to load profile:', err);
    showView('viewWizard1');
  }
}

async function showProfileView(profile) {
  cachedProfile = profile;
  const greeting = document.getElementById('profileGreeting');
  greeting.textContent = `Hi, ${profile.firstName || 'User'}!`;

  const ageEl = document.getElementById('profileAge');
  if (profile.age) ageEl.textContent = `${profile.age} years old`;

  const locEl = document.getElementById('profileLocation');
  const parts = [profile.city, profile.country].filter(Boolean);
  if (parts.length) locEl.textContent = parts.join(', ');

  // Load favorites count + videos count in parallel
  try {
    const [favData, vidData] = await Promise.all([
      sendMsg({ type: 'API_CALL', endpoint: '/api/favorites', method: 'GET', data: {} }).catch(() => null),
      sendMsg({ type: 'API_CALL', endpoint: '/api/video/list', method: 'GET', data: {} }).catch(() => null),
    ]);
    document.getElementById('favoritesCount').textContent = favData?.favorites?.length || 0;
    document.getElementById('videosCount').textContent = vidData?.videos?.length || 0;
  } catch (_) { /* ignore */ }

  // Load all photos (5 originals + 3 generated)
  try {
    const allPhotos = await sendMsg({
      type: 'API_CALL', endpoint: '/api/profile/photos/all', method: 'GET', data: {}
    });

    // Show generated photos
    const genSection = document.getElementById('profileGenerated');
    if (allPhotos.generated && allPhotos.generated.some(Boolean)) {
      genSection.hidden = false;
      for (let i = 0; i < 3; i++) {
        const img = document.getElementById(`profileGenImg${i}`);
        if (allPhotos.generated[i]) {
          img.src = `data:image/jpeg;base64,${allPhotos.generated[i]}`;
          img.hidden = false;
        } else {
          img.hidden = true;
        }
      }
    } else {
      genSection.hidden = true;
    }

    // Show original photos
    const origSection = document.getElementById('profileOriginals');
    if (allPhotos.originals && allPhotos.originals.some(Boolean)) {
      origSection.hidden = false;
      for (let i = 0; i < 5; i++) {
        const img = document.getElementById(`profileOrigImg${i}`);
        if (allPhotos.originals[i]) {
          img.src = `data:image/jpeg;base64,${allPhotos.originals[i]}`;
          img.hidden = false;
        } else {
          img.hidden = true;
        }
      }
    } else {
      origSection.hidden = true;
    }
  } catch (_) {
    // Hide photo sections if API fails
    document.getElementById('profileGenerated').hidden = true;
    document.getElementById('profileOriginals').hidden = true;
  }

  showView('viewProfile');
  checkBackendHealth('profileStatusDot', 'profileStatusText');
  loadDebugTryOnImages();
  loadPoseAndFramingState();
}

// ---------------------------------------------------------------------------
// Debug Try-On Images (loaded from chrome.storage, set by content script)
// ---------------------------------------------------------------------------

async function loadDebugTryOnImages() {
  const section = document.getElementById('debugTryOnSection');
  if (!section) return;
  try {
    const stored = await chrome.storage.local.get(['tryOnDebug']);
    const debug = stored.tryOnDebug;
    if (!debug || !debug.userPhoto || !debug.garmentPhoto) {
      section.hidden = true;
      return;
    }
    document.getElementById('debugUserPhoto').src = debug.userPhoto;
    document.getElementById('debugGarmentPhoto').src = debug.garmentPhoto;
    const extracted = debug.garmentImageUsed === 'extracted';
    document.getElementById('debugGarmentLabel').textContent = extracted ? 'Garment (extracted)' : 'Garment (original)';
    section.hidden = false;
  } catch (_) {
    section.hidden = true;
  }
}

// Listen for storage changes to update debug images in real-time
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.tryOnDebug) {
    loadDebugTryOnImages();
  }
});

// ---------------------------------------------------------------------------
// Pose & Framing Controls
// ---------------------------------------------------------------------------

function setupPoseAndFramingControls() {
  // Pose buttons
  document.querySelectorAll('#poseBtns .nova-setting-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const poseIndex = parseInt(btn.dataset.pose, 10);
      document.querySelectorAll('#poseBtns .nova-setting-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      chrome.storage.local.set({ selectedPoseIndex: poseIndex });

      // Highlight the corresponding generated photo
      for (let i = 0; i < 3; i++) {
        const img = document.getElementById(`profileGenImg${i}`);
        if (img) img.classList.toggle('pose-active', i === poseIndex);
      }
    });
  });

  // Framing buttons
  document.querySelectorAll('#framingBtns .nova-setting-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const framing = btn.dataset.framing;
      document.querySelectorAll('#framingBtns .nova-setting-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      chrome.storage.local.set({ tryOnFraming: framing });
    });
  });
}

async function loadPoseAndFramingState() {
  const stored = await chrome.storage.local.get(['selectedPoseIndex', 'tryOnFraming']);
  const poseIndex = stored.selectedPoseIndex || 0;
  const framing = stored.tryOnFraming || 'full';

  // Update pose buttons
  document.querySelectorAll('#poseBtns .nova-setting-btn').forEach((btn) => {
    btn.classList.toggle('selected', parseInt(btn.dataset.pose, 10) === poseIndex);
  });

  // Highlight active generated photo
  for (let i = 0; i < 3; i++) {
    const img = document.getElementById(`profileGenImg${i}`);
    if (img) img.classList.toggle('pose-active', i === poseIndex);
  }

  // Update framing buttons
  document.querySelectorAll('#framingBtns .nova-setting-btn').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.framing === framing);
  });
}

// ---------------------------------------------------------------------------
// Edit Profile (single-page, all sections visible)
// ---------------------------------------------------------------------------
// Favorites View
// ---------------------------------------------------------------------------
async function showFavoritesView() {
  showView('viewFavorites');
  const container = document.getElementById('favoritesListContainer');
  container.innerHTML = '<div class="favorites-empty">Loading...</div>';

  try {
    const favData = await sendMsg({
      type: 'API_CALL', endpoint: '/api/favorites', method: 'GET', data: {}
    });
    console.log('[popup] Raw favData response:', JSON.stringify(favData).substring(0, 500));
    const favorites = favData.favorites || [];
    console.log(`[popup] Favorites loaded: ${favorites.length}`);
    favorites.forEach((f, i) => {
      console.log(`[popup]   [${i}] productId=${f.productId || f.asin}`);
      console.log(`[popup]     tryOnResultKey="${f.tryOnResultKey || '(empty)'}"`);
      console.log(`[popup]     tryOnResultUrl=${f.tryOnResultUrl ? 'YES (' + f.tryOnResultUrl.substring(0, 80) + '...)' : 'NO'}`);
      console.log(`[popup]     productImage=${f.productImage ? 'YES' : 'NO'}`);
      console.log(`[popup]     ALL KEYS:`, Object.keys(f));
    });

    if (favorites.length === 0) {
      container.innerHTML = '<div class="favorites-empty">No favorites yet.<br>Use the &#9825; button on try-on results to save items here.</div>';
      return;
    }

    // Sort by savedAt descending (newest first)
    favorites.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));

    // Group by outfitId (items with same outfitId are one outfit, items without are solo)
    const outfitGroups = new Map(); // outfitId → [fav, ...]
    const soloItems = [];
    favorites.forEach((fav) => {
      if (fav.outfitId) {
        if (!outfitGroups.has(fav.outfitId)) outfitGroups.set(fav.outfitId, []);
        outfitGroups.get(fav.outfitId).push(fav);
      } else {
        soloItems.push(fav);
      }
    });

    // Build a flat render list: each entry is either {type:'outfit', items:[...]} or {type:'solo', fav}
    const renderList = [];
    outfitGroups.forEach((items) => renderList.push({ type: 'outfit', items, savedAt: items[0].savedAt }));
    soloItems.forEach((fav) => renderList.push({ type: 'solo', fav, savedAt: fav.savedAt }));
    renderList.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));

    container.innerHTML = '<div class="favorites-list" id="favoritesList"></div>';
    const list = document.getElementById('favoritesList');

    renderList.forEach((entry) => {
      if (entry.type === 'outfit') {
        renderOutfitCard(list, container, entry.items);
      } else {
        renderSoloCard(list, container, entry.fav);
      }
    });

    function renderSoloCard(list, container, fav) {
      const card = document.createElement('div');
      card.className = 'fav-card';

      const productImg = fav.productImage || '';
      const hasTryOnKey = !!fav.tryOnResultKey;
      const title = fav.productTitle || (fav.productId || fav.asin) || 'Unknown product';
      const category = fav.category || fav.garmentClass || '';
      const date = fav.savedAt ? new Date(fav.savedAt).toLocaleDateString() : '';
      const retailerLabels = { amazon: 'AMAZON', shein: 'SHEIN', temu: 'TEMU', google_shopping: 'GOOGLE SHOPPING' };
      const retailerName = retailerLabels[fav.retailer] || (fav.retailer || 'AMAZON').toUpperCase();

      card.innerHTML = `
        <div class="fav-card-images">
          ${hasTryOnKey ? `<img class="fav-card-img fav-card-tryon" id="tryonImg_${esc(fav.productId || fav.asin)}" src="" alt="Try-on" style="display:none">` : ''}
          ${productImg ? `<img class="fav-card-img fav-card-product" src="${esc(productImg)}" alt="Product">` : ''}
        </div>
        <div class="fav-card-body">
          <span class="fav-card-retailer fav-retailer-${esc((fav.retailer || 'amazon').replace(/_/g, '-'))}">${esc(retailerName)}</span>
          <div class="fav-card-title">${esc(title)}</div>
          <div class="fav-card-meta">${esc([category, date].filter(Boolean).join(' · '))}</div>
        </div>
        <button class="fav-card-remove" title="Remove" data-product-id="${esc(fav.productId || fav.asin)}">&times;</button>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('fav-card-remove')) return;
        const url = getProductUrl(fav);
        if (url !== '#') chrome.tabs.create({ url });
      });

      const removeBtn = card.querySelector('.fav-card-remove');
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await sendMsg({ type: 'API_CALL', endpoint: `/api/favorites/${fav.productId || fav.asin}`, method: 'DELETE', data: {} });
          card.remove();
          showToast('Favorite removed');
          if (list.querySelectorAll('.fav-card, .fav-outfit-card').length === 0) {
            container.innerHTML = '<div class="favorites-empty">No favorites yet.<br>Use the &#9825; button on try-on results to save items here.</div>';
          }
        } catch (err) {
          console.error('[popup] Failed to remove favorite:', err);
          showToast('Failed to remove favorite');
        }
      });

      list.appendChild(card);
      loadTryOnImage(fav);
    }

    function renderOutfitCard(list, container, items) {
      const card = document.createElement('div');
      card.className = 'fav-outfit-card';

      const date = items[0].savedAt ? new Date(items[0].savedAt).toLocaleDateString() : '';
      // Use first item's try-on image (all share the same result)
      const firstWithKey = items.find(i => i.tryOnResultKey);
      const tryOnImgId = firstWithKey ? `tryonImg_outfit_${firstWithKey.productId || firstWithKey.asin}` : '';

      const itemRows = items.map(i => {
        const shortTitle = (i.productTitle || i.category || 'Item').split(' ').slice(0, 4).join(' ');
        return `<div class="fav-outfit-row" data-product-id="${esc(i.productId || i.asin)}" data-retailer="${esc(i.retailer || 'amazon')}">
          <img class="fav-outfit-thumb" src="${esc(i.productImage || '')}" alt="${esc(i.category)}" title="${esc(i.productTitle || i.category)}">
          <a class="fav-outfit-link" href="#">${esc(shortTitle)}</a>
        </div>`;
      }).join('');

      card.innerHTML = `
        <div class="fav-outfit-images">
          ${tryOnImgId ? `<img class="fav-card-img fav-card-tryon" id="${tryOnImgId}" src="" alt="Try-on" style="display:none">` : ''}
        </div>
        <div class="fav-card-body">
          <span class="fav-card-retailer fav-retailer-${((items[0].retailer || 'amazon').replace(/_/g, '-'))}">${(items[0].retailer || 'AMAZON').toUpperCase().replace(/_/g, ' ')}</span>
          <div class="fav-card-title">Outfit (${items.length} items)</div>
          <div class="fav-outfit-items">${itemRows}</div>
          <div class="fav-card-meta">${date}</div>
        </div>
        <button class="fav-outfit-remove" title="Remove outfit">&times;</button>
      `;

      // Click product row (thumb + link) → open that item on Amazon
      card.querySelectorAll('.fav-outfit-row').forEach(el => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const productId = el.dataset.productId;
          const retailer = el.dataset.retailer || 'amazon';
          if (productId) chrome.tabs.create({ url: getProductUrl(productId, retailer) });
        });
      });

      // Remove entire outfit
      card.querySelector('.fav-outfit-remove').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          for (const item of items) {
            await sendMsg({ type: 'API_CALL', endpoint: `/api/favorites/${item.productId || item.asin}`, method: 'DELETE', data: {} });
          }
          card.remove();
          showToast('Outfit removed');
          if (list.querySelectorAll('.fav-card, .fav-outfit-card').length === 0) {
            container.innerHTML = '<div class="favorites-empty">No favorites yet.<br>Use the &#9825; button on try-on results to save items here.</div>';
          }
        } catch (err) {
          console.error('[popup] Failed to remove outfit:', err);
          showToast('Failed to remove outfit');
        }
      });

      list.appendChild(card);
      if (firstWithKey) loadTryOnImage(firstWithKey, tryOnImgId);
    }

    function loadTryOnImage(fav, customId) {
      if (!fav.tryOnResultKey) return;
      const imgId = customId || `tryonImg_${fav.productId || fav.asin}`;
      const retailer = fav.retailer || 'amazon';
      sendMsg({
        type: 'API_CALL', endpoint: `/api/favorites/${fav.productId || fav.asin}/image?retailer=${retailer}`, method: 'GET', data: {}
      }).then((imgData) => {
        if (imgData && imgData.image) {
          const imgEl = document.getElementById(imgId);
          if (imgEl) {
            imgEl.src = `data:image/jpeg;base64,${imgData.image}`;
            imgEl.style.display = '';
            imgEl.style.cursor = 'pointer';
            imgEl.addEventListener('click', (e) => {
              e.stopPropagation();
              document.getElementById('lightboxImg').src = imgEl.src;
              document.getElementById('imageLightbox').classList.add('active');
            });
          }
        }
      }).catch((err) => {
        console.warn(`[popup] Failed to load try-on image for ${fav.productId || fav.asin}:`, err.message);
      });
    }
  } catch (err) {
    console.error('[popup] Failed to load favorites:', err);
    container.innerHTML = '<div class="favorites-empty">Failed to load favorites.</div>';
  }
}

// ---------------------------------------------------------------------------
// Videos View
// ---------------------------------------------------------------------------
async function showVideosView() {
  showView('viewVideos');
  const container = document.getElementById('videosListContainer');
  container.innerHTML = '<div class="favorites-empty">Loading...</div>';

  try {
    const vidData = await sendMsg({
      type: 'API_CALL', endpoint: '/api/video/list', method: 'GET', data: {}
    });

    const videos = vidData.videos || [];
    if (!videos.length) {
      container.innerHTML = '<div class="favorites-empty">No saved videos yet.<br>Use the "Save" button on generated videos to save them here.</div>';
      return;
    }

    // Sort newest first
    videos.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));

    container.innerHTML = '<div class="videos-list" id="videosList"></div>';
    const list = document.getElementById('videosList');

    videos.forEach((video) => {
      const card = document.createElement('div');
      card.className = 'video-card';

      const date = video.savedAt ? new Date(video.savedAt).toLocaleDateString() : '';
      const title = video.productTitle || (video.productId || video.asin) || 'Try-on video';
      const shortTitle = title.split(' ').slice(0, 5).join(' ');

      // Build outfit items links HTML if available
      const outfitLinksHtml = (video.outfitItems && video.outfitItems.length > 0)
        ? `<div class="video-card-outfit-items">${video.outfitItems.map(item => {
            const label = item.category ? item.category.charAt(0).toUpperCase() + item.category.slice(1) : 'Item';
            const shortName = (item.title || '').split(' ').slice(0, 4).join(' ') || label;
            const price = item.price ? ` ${item.price}` : '';
            if (item.productUrl) {
              return `<a class="video-outfit-link" href="${item.productUrl}" target="_blank" title="${item.title || ''}">${shortName}${price}</a>`;
            }
            return `<span class="video-outfit-link">${shortName}${price}</span>`;
          }).join('')}</div>`
        : '';

      card.innerHTML = `
        <div class="video-card-player">
          ${video.videoUrl ? `<video class="video-card-video" controls preload="metadata"><source src="${video.videoUrl}" type="video/mp4"></video>` : '<div class="video-card-placeholder">Video unavailable</div>'}
        </div>
        <div class="video-card-body">
          <div class="video-card-info">
            ${video.productImage ? `<img class="video-card-product-img" src="${video.productImage}" alt="Product">` : ''}
            <div>
              <div class="video-card-title">${shortTitle}</div>
              <div class="video-card-meta">${date}</div>
            </div>
          </div>
          ${outfitLinksHtml}
          <div class="video-card-actions">
            ${(video.productId || video.asin) ? `<a class="video-card-link" href="#" data-product-id="${video.productId || video.asin}" data-retailer="${video.retailer || 'amazon'}">View Product</a>` : ''}
            <button class="video-card-delete" title="Remove video" data-video-id="${video.videoId}">&times;</button>
          </div>
        </div>
      `;

      // Click Amazon link
      const amazonLink = card.querySelector('.video-card-link');
      if (amazonLink) {
        amazonLink.addEventListener('click', (e) => {
          e.preventDefault();
          chrome.tabs.create({ url: getProductUrl(amazonLink.dataset.productId, amazonLink.dataset.retailer || 'amazon') });
        });
      }

      // Delete video
      card.querySelector('.video-card-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        const videoId = e.target.dataset.videoId;
        try {
          await sendMsg({ type: 'API_CALL', endpoint: `/api/video/${encodeURIComponent(videoId)}`, method: 'DELETE', data: {} });
          card.remove();
          showToast('Video deleted');
          if (list.querySelectorAll('.video-card').length === 0) {
            container.innerHTML = '<div class="favorites-empty">No saved videos yet.<br>Use the "Save" button on generated videos to save them here.</div>';
          }
        } catch (err) {
          console.error('[popup] Failed to remove video:', err);
          showToast('Failed to delete video');
        }
      });

      list.appendChild(card);
    });
  } catch (err) {
    console.error('[popup] Failed to load videos:', err);
    container.innerHTML = '<div class="favorites-empty">Failed to load videos.</div>';
  }
}

// ---------------------------------------------------------------------------

let editOriginalReplaceIndex = null;

async function showEditProfile() {
  // Pre-fill personal info from cached profile
  if (cachedProfile) {
    document.getElementById('editFirstName').value = cachedProfile.firstName || '';
    document.getElementById('editLastName').value = cachedProfile.lastName || '';
    document.getElementById('editBirthday').value = cachedProfile.birthday || '';
    document.getElementById('editSex').value = cachedProfile.sex || '';
    document.getElementById('editCountry').value = cachedProfile.country || '';
    document.getElementById('editCity').value = cachedProfile.city || '';
    document.getElementById('editClothesSize').value = cachedProfile.clothesSize || '';
    document.getElementById('editShoesSize').value = cachedProfile.shoesSize || '';
    document.getElementById('editLanguage').value = cachedProfile.language || 'en';
    if (cachedProfile.birthday) {
      const age = calculateAge(cachedProfile.birthday);
      document.getElementById('editAgeDisplay').textContent = age > 0 ? `Age: ${age}` : '';
    }
  }

  // Load all 5 original photos
  try {
    const allPhotos = await sendMsg({
      type: 'API_CALL', endpoint: '/api/profile/photos/all', method: 'GET', data: {}
    });
    if (allPhotos.originals && allPhotos.originals.length > 0) {
      for (let i = 0; i < 5; i++) {
        const img = document.getElementById(`editOrigImg${i}`);
        if (allPhotos.originals[i]) {
          img.src = `data:image/jpeg;base64,${allPhotos.originals[i]}`;
        } else {
          img.src = '';
          img.alt = 'No photo';
        }
      }
    }
  } catch (err) {
    console.warn('[popup] Failed to load original photos:', err.message);
  }

  showView('viewEditProfile');
}

async function handleEditSaveInfo() {
  const btn = document.getElementById('editSaveInfoBtn');
  const firstName = document.getElementById('editFirstName').value.trim();
  const lastName = document.getElementById('editLastName').value.trim();
  const birthday = document.getElementById('editBirthday').value;
  const sex = document.getElementById('editSex').value;
  const country = document.getElementById('editCountry').value;
  const city = document.getElementById('editCity').value.trim();
  const clothesSize = document.getElementById('editClothesSize').value;
  const shoesSize = document.getElementById('editShoesSize').value;
  const language = document.getElementById('editLanguage')?.value || 'en';

  if (!firstName || !lastName) {
    showToast('Please enter your first and last name.');
    return;
  }

  setLoading(btn, true);
  try {
    await sendMsg({
      type: 'API_CALL', endpoint: '/api/profile', method: 'PUT',
      data: { firstName, lastName, birthday, sex, country, city, clothesSize, shoesSize, language }
    });
    showToast('Profile updated successfully');
  } catch (err) {
    showToast('Failed to save: ' + err.message);
  } finally {
    setLoading(btn, false);
  }
}

async function handleEditRegenAiPhotos() {
  const btn = document.getElementById('editRegenAiBtn');
  const statusEl = document.getElementById('editRegenStatus');
  setLoading(btn, true);
  statusEl.hidden = false;
  statusEl.textContent = 'Fetching your original photos...';

  try {
    // Fetch current originals from GCS (same data showEditProfile already loads)
    const allPhotos = await sendMsg({
      type: 'API_CALL', endpoint: '/api/profile/photos/all', method: 'GET', data: {}
    });

    if (!allPhotos.originals || allPhotos.originals.filter(Boolean).length < 5) {
      showToast('All 5 original photos are required before regenerating.');
      return;
    }

    statusEl.textContent = 'Generating 3 AI pose photos... This may take a minute.';
    const startTime = Date.now();

    // Call the SAME endpoint used during account creation
    const result = await sendMsg({
      type: 'API_CALL', endpoint: '/api/profile/generate-photos', method: 'POST',
      data: { userImages: allPhotos.originals }
    });

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const successCount = result.generatedPhotos ? result.generatedPhotos.filter(Boolean).length : 0;

    // Update chrome.storage with new generated photo (same logic as wizard)
    if (result.generatedPhotos && result.generatedPhotos[0]) {
      await chrome.storage.local.set({
        bodyPhoto: result.generatedPhotos[0],
        selectedPoseIndex: 0
      });
    }

    statusEl.textContent = `Done! ${successCount}/3 photos generated in ${totalTime}s`;
    btn.textContent = 'Regenerate AI Photos';
    showToast('Profile photos regenerated successfully');
    setTimeout(() => { statusEl.hidden = true; }, 5000);
  } catch (err) {
    statusEl.textContent = 'Failed: ' + err.message;
  } finally {
    setLoading(btn, false);
  }
}

async function handleEditOriginalReplace(file, index) {
  if (!ALLOWED_TYPES.includes(file.type)) {
    showToast('Please upload a JPEG, PNG, or WebP image.');
    return;
  }
  const item = document.querySelector(`.edit-original-item[data-index="${index}"]`);
  const btn = item.querySelector('.edit-original-change-btn');
  const origText = btn.textContent;
  btn.textContent = 'Uploading...';
  btn.disabled = true;
  item.classList.add('uploading');

  try {
    const result = await processImage(file);
    await sendMsg({
      type: 'API_CALL', endpoint: `/api/profile/photos/original/${index}`, method: 'PUT',
      data: { image: result.base64 }
    });
    // Update the displayed image
    document.getElementById(`editOrigImg${index}`).src = `data:image/jpeg;base64,${result.base64}`;
    btn.textContent = 'Done!';
    setTimeout(() => { btn.textContent = origText; }, 1500);
  } catch (err) {
    showToast('Failed to replace photo: ' + err.message);
    btn.textContent = origText;
  } finally {
    btn.disabled = false;
    item.classList.remove('uploading');
  }
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

async function handleWizard1Next() {
  const firstName = document.getElementById('firstName').value.trim();
  const lastName = document.getElementById('lastName').value.trim();
  const birthday = document.getElementById('birthday').value;
  const sex = document.getElementById('sex').value;
  const country = document.getElementById('country').value;
  const city = document.getElementById('city').value.trim();
  const clothesSize = document.getElementById('clothesSize').value;
  const shoesSize = document.getElementById('shoesSize').value;

  if (!firstName || !lastName || !birthday || !sex || !country || !city || !clothesSize || !shoesSize) {
    showToast('Please fill in all fields.');
    return;
  }

  const language = document.getElementById('language')?.value || 'en';

  try {
    await sendMsg({
      type: 'API_CALL', endpoint: '/api/profile', method: 'PUT',
      data: { firstName, lastName, birthday, sex, country, city, clothesSize, shoesSize, language }
    });
    // Open as a full tab for photo upload (popup closes when file dialogs open)
    openAsTab('wizard2');
  } catch (err) {
    showToast('Failed to save: ' + err.message);
  }
}

/**
 * Open popup.html in a full browser tab so file dialogs work reliably.
 * Chrome extension popups close when system dialogs (file picker) open,
 * losing all JS state. Tabs don't have this problem.
 */
function openAsTab(step) {
  const url = chrome.runtime.getURL('popup/popup.html') + '?step=' + step;
  chrome.tabs.create({ url });
  // Close the popup if we're in one
  if (!isRunningAsTab()) window.close();
}

function isRunningAsTab() {
  return window.location.search.includes('step=');
}

// ---------------------------------------------------------------------------
// Multi-photo upload for wizard step 2
// ---------------------------------------------------------------------------

async function handleMultiPhotoUpload(category, index, file) {
  console.log(`[upload] handleMultiPhotoUpload called: ${category} ${index}, file: ${file.name} (${file.type})`);
  if (!ALLOWED_TYPES.includes(file.type)) {
    showToast('Please upload a JPEG, PNG, or WebP image.');
    return;
  }
  try {
    const result = await processImage(file);
    console.log(`[upload] processImage done: ${result.width}x${result.height}, ${result.sizeKB}KB`);
    userPhotos[category][index] = result.base64;

    // Update preview
    const previewId = `${category}Preview${index}`;
    const preview = document.getElementById(previewId);
    if (preview) {
      preview.src = `data:image/jpeg;base64,${result.base64}`;
      preview.hidden = false;
    }

    // Enable "Generate" button when all 5 photos are uploaded
    const allFilled = userPhotos.body.every(Boolean) && userPhotos.face.every(Boolean);
    document.getElementById('wizard2Next').disabled = !allFilled;
    console.log(`[upload] allFilled: ${allFilled}`);
  } catch (err) {
    console.error(`[upload] error:`, err);
    showToast('Failed to process image: ' + err.message);
  }
}


async function handleWizard2Next() {
  const allFilled = userPhotos.body.every(Boolean) && userPhotos.face.every(Boolean);
  if (!allFilled) return;

  const btn = document.getElementById('wizard2Next');
  setLoading(btn, true);

  // Move to wizard3 and start generation
  showView('viewWizard3');

  // Reset progress UI
  for (let i = 0; i < 3; i++) {
    const step = document.getElementById(`genStep${i}`);
    step.querySelector('.gen-step-icon').innerHTML = '&#9711;';
    step.classList.remove('gen-step-done', 'gen-step-active', 'gen-step-error');
    step.querySelector('.gen-step-time').textContent = '';
    document.getElementById(`genImg${i}`).hidden = true;
  }
  document.getElementById('wizard3Done').hidden = true;
  const successEl = document.getElementById('genSuccess');
  if (successEl) successEl.hidden = true;
  clearError('genError');

  try {
    // Mark first step as active
    document.getElementById('genStep0').classList.add('gen-step-active');
    document.getElementById('genStep0').querySelector('.gen-step-icon').innerHTML = '&#8987;';

    const userImages = [...userPhotos.body, ...userPhotos.face];
    const startTime = Date.now();

    const result = await sendMsg({
      type: 'API_CALL', endpoint: '/api/profile/generate-photos', method: 'POST',
      data: { userImages }
    });

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

    // Reveal pose images one by one with staggered delay, then show success
    if (result.generatedPhotos) {
      const revealPose = (i) => new Promise(resolve => {
        setTimeout(() => {
          const step = document.getElementById(`genStep${i}`);
          step.classList.remove('gen-step-active');
          if (result.generatedPhotos[i]) {
            step.classList.add('gen-step-done');
            step.querySelector('.gen-step-icon').innerHTML = '&#10003;';
            const img = document.getElementById(`genImg${i}`);
            img.src = `data:image/jpeg;base64,${result.generatedPhotos[i]}`;
            img.hidden = false;
          } else {
            step.classList.add('gen-step-error');
            step.querySelector('.gen-step-icon').innerHTML = '&#10007;';
          }
          // Mark next step as active while it "loads"
          if (i < 2 && result.generatedPhotos[i + 1]) {
            const nextStep = document.getElementById(`genStep${i + 1}`);
            nextStep.classList.add('gen-step-active');
            nextStep.querySelector('.gen-step-icon').innerHTML = '&#8987;';
          }
          resolve();
        }, i === 0 ? 0 : 600); // first one instant, others 600ms apart
      });

      for (let i = 0; i < 3; i++) {
        await revealPose(i);
      }
      document.getElementById('genStep2').querySelector('.gen-step-time').textContent = `${totalTime}s total`;
    }

    // Store first generated photo for backward compat + reset pose selection
    // Actual pose images are fetched from GCS by the backend using poseIndex
    if (result.generatedPhotos && result.generatedPhotos[0]) {
      await chrome.storage.local.set({
        bodyPhoto: result.generatedPhotos[0],
        selectedPoseIndex: 0
      });
    }

    // Show success message, confetti, and complete button AFTER all poses are visible
    const successEl2 = document.getElementById('genSuccess');
    if (successEl2) successEl2.hidden = false;
    document.getElementById('wizard3Done').hidden = false;
    showToast('Account created successfully! Welcome aboard!');
    launchConfetti();
  } catch (err) {
    showError('genError', 'Generation failed: ' + err.message);
    // Mark all steps as error
    for (let i = 0; i < 3; i++) {
      const step = document.getElementById(`genStep${i}`);
      step.classList.remove('gen-step-active');
      step.classList.add('gen-step-error');
      step.querySelector('.gen-step-icon').innerHTML = '&#10007;';
    }
  } finally {
    setLoading(btn, false);
  }
}

async function handleWizard3Done() {
  if (isRunningAsTab()) {
    // Close the tab — user will open popup normally to see profile
    window.close();
  } else {
    await loadProfileAndRoute();
  }
}

// ---------------------------------------------------------------------------
// Upload Area Setup
// ---------------------------------------------------------------------------

function setupUploadArea(areaId, inputId, handler) {
  const area = document.getElementById(areaId);
  const input = document.getElementById(inputId);
  if (!area || !input) return;

  area.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handler(e.target.files[0]);
  });
  area.addEventListener('dragenter', (e) => { e.preventDefault(); area.classList.add('drag-over'); });
  area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('drag-over'); });
  area.addEventListener('dragleave', (e) => { e.preventDefault(); area.classList.remove('drag-over'); });
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) handler(e.dataTransfer.files[0]);
  });
}

// ---------------------------------------------------------------------------
// Backend Health
// ---------------------------------------------------------------------------

async function checkBackendHealth(dotId, textId) {
  dotId = dotId || 'statusDot';
  textId = textId || 'statusText';
  const dot = document.getElementById(dotId);
  const text = document.getElementById(textId);
  if (!dot || !text) return;

  const stored = await chrome.storage.local.get(['backendUrl']);
  const url = stored.backendUrl || DEFAULT_BACKEND_URL;

  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      dot.className = 'status-dot connected';
      text.textContent = 'Backend connected';
    } else {
      dot.className = 'status-dot disconnected';
      text.textContent = `Backend error (${resp.status})`;
    }
  } catch (_) {
    dot.className = 'status-dot disconnected';
    text.textContent = 'Backend unreachable';
  }
}

// ---------------------------------------------------------------------------
// Backend URL
// ---------------------------------------------------------------------------

async function saveBackendUrl() {
  const input = document.getElementById('backendUrlInput');
  if (!input) return;
  const url = input.value.trim();
  if (!url) return;
  await chrome.storage.local.set({ backendUrl: url });
  const btn = document.getElementById('saveUrlBtn');
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }
  checkBackendHealth('profileStatusDot', 'profileStatusText');
}

// ---------------------------------------------------------------------------
// Cosmetics Face Selector
// ---------------------------------------------------------------------------

let cosmeticsFaceLoaded = false;
async function loadCosmeticsFaceSelector() {
  if (cosmeticsFaceLoaded) return;
  const container = document.getElementById('cosmeticFaceSelector');
  if (!container) return;
  try {
    const allPhotos = await sendMsg({
      type: 'API_CALL', endpoint: '/api/profile/photos/all', method: 'GET', data: {}
    });
    const facePhotos = (allPhotos && allPhotos.originals || []).slice(3, 5).filter(Boolean);
    if (facePhotos.length === 0) {
      container.innerHTML = '<p class="cosmetics-face-loading">No face photos found. Upload them in Edit Profile.</p>';
      return;
    }

    // Load stored face index preference
    const stored = await chrome.storage.local.get(['selectedFaceIndex']);
    let selectedFaceIndex = Math.min(stored.selectedFaceIndex || 0, facePhotos.length - 1);

    container.innerHTML = '';
    facePhotos.forEach((photo, i) => {
      if (!photo) return;
      const img = document.createElement('img');
      img.className = 'cosmetics-face-thumb' + (i === selectedFaceIndex ? ' selected' : '');
      img.src = `data:image/jpeg;base64,${photo}`;
      img.alt = `Face ${i + 1}`;
      img.addEventListener('click', () => {
        container.querySelectorAll('.cosmetics-face-thumb').forEach(t => t.classList.remove('selected'));
        img.classList.add('selected');
        selectedFaceIndex = i;
        chrome.storage.local.set({ selectedFaceIndex: i });
      });
      container.appendChild(img);
    });
    cosmeticsFaceLoaded = true;
  } catch (err) {
    console.error('[popup] Failed to load cosmetics face photos:', err);
    container.innerHTML = '<p class="cosmetics-face-loading">Failed to load face photos.</p>';
  }
}

// ---------------------------------------------------------------------------
// Smart Search
// ---------------------------------------------------------------------------

async function handleCompareSearch() {
  const input = document.getElementById('compareSearchInput');
  const btn = document.getElementById('compareSearchBtn');
  const errorEl = document.getElementById('compareSearchError');
  const resultsEl = document.getElementById('compareResults');
  const query = input.value.trim();

  errorEl.textContent = '';
  resultsEl.innerHTML = '';

  if (!query) {
    errorEl.textContent = 'Please enter a search query';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Classifying...';
  resultsEl.innerHTML = '<p class="compare-loading">Analyzing product category...</p>';

  const enrichedQuery = query;

  btn.textContent = 'Searching...';
  resultsEl.innerHTML = '<p class="compare-loading">Searching across retailers...</p>';

  try {
    const result = await sendMsg({ type: 'COMPARE_SEARCH', query: enrichedQuery });
    if (!result || result.error) {
      errorEl.textContent = result?.error || 'Compare search failed';
      resultsEl.innerHTML = '';
      return;
    }

    const comparisons = result.comparisons || [];
    if (comparisons.length === 0) {
      resultsEl.innerHTML = '<p class="compare-empty">No results found.</p>';
      return;
    }

    const esc = (s) => (s || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');

    resultsEl.innerHTML = comparisons.map((comp, idx) => {
      const a = comp.amazon;
      const alts = comp.alternatives || [];

      const amazonCard = `
        <a href="${esc(a.product_url)}" class="compare-item compare-item--amazon" target="_blank" rel="noopener">
          <img class="compare-item-img" src="${esc(a.image_url)}" alt="" onerror="this.style.display='none'" />
          <div class="compare-item-info">
            <p class="compare-item-title">${esc(a.title).substring(0, 80)}</p>
            <div class="compare-item-meta">
              <span class="compare-item-price">${esc(a.price) || 'N/A'}</span>
              <span class="compare-item-rating">${a.rating ? a.rating + ' ★' : ''}</span>
              <span class="compare-item-retailer">Amazon</span>
            </div>
          </div>
        </a>`;

      // Filter out alternatives with invalid URLs
      const validAlts = alts.filter(alt => alt.product_url && alt.product_url.startsWith('http') && !alt.product_url.includes('chrome-extension://'));
      const altCards = validAlts.length > 0
        ? validAlts.map(alt => `
          <a href="${esc(alt.product_url)}" class="compare-item compare-item--alt" target="_blank" rel="noopener">
            <img class="compare-item-img compare-item-img--small" src="${esc(alt.image_url)}" alt="" onerror="this.style.display='none'" />
            <div class="compare-item-info">
              <p class="compare-item-title">${esc(alt.title).substring(0, 60)}</p>
              <div class="compare-item-meta">
                <span class="compare-item-price">${esc(alt.price) || 'N/A'}</span>
                <span class="compare-item-retailer">${esc(alt.retailer) || 'Other'}</span>
              </div>
            </div>
          </a>`).join('')
        : '<p class="compare-no-alts">No alternatives found</p>';

      return `
        <div class="compare-group">
          <div class="compare-group-header">#${idx + 1}</div>
          ${amazonCard}
          <div class="compare-alts-label">Also available at:</div>
          ${altCards}
        </div>`;
    }).join('');
  } catch (err) {
    errorEl.textContent = 'Search failed: ' + err.message;
    resultsEl.innerHTML = '';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Compare';
  }
}

async function handleSmartSearch() {
  const input = document.getElementById('smartSearchInput');
  const btn = document.getElementById('smartSearchBtn');
  const errorEl = document.getElementById('smartSearchError');
  const query = input.value.trim();

  errorEl.textContent = '';

  if (!query) {
    errorEl.textContent = 'Please enter a search query';
    return;
  }

  // Open the results page in a new tab with the query + user sizes
  const searchParams = new URLSearchParams({ q: query });
  if (cachedProfile?.clothesSize) searchParams.set('clothesSize', cachedProfile.clothesSize);
  if (cachedProfile?.shoesSize) searchParams.set('shoesSize', cachedProfile.shoesSize);
  if (cachedProfile?.sex) searchParams.set('sex', cachedProfile.sex);
  const resultsUrl = chrome.runtime.getURL('smart-search/results.html') + '?' + searchParams.toString();
  chrome.tabs.create({ url: resultsUrl });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  // Bind auth events
  document.getElementById('loginBtn').addEventListener('click', handleLogin);
  document.getElementById('signupBtn').addEventListener('click', handleSignup);
  document.getElementById('verifyBtn').addEventListener('click', handleVerify);
  document.getElementById('goToSignUp').addEventListener('click', (e) => { e.preventDefault(); showView('viewSignUp'); });
  document.getElementById('goToSignIn').addEventListener('click', (e) => { e.preventDefault(); showView('viewSignIn'); });
  document.getElementById('resendCode').addEventListener('click', (e) => { e.preventDefault(); handleResendCode(); });
  document.getElementById('signOutBtn').addEventListener('click', handleSignOut);
  document.getElementById('deleteAccountBtn').addEventListener('click', handleDeleteAccount);

  // Enter key on login/signup
  document.getElementById('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
  document.getElementById('signupConfirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSignup(); });
  document.getElementById('verifyCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleVerify(); });

  // Wizard events
  document.getElementById('wizard1Next').addEventListener('click', handleWizard1Next);
  document.getElementById('wizard2Back').addEventListener('click', () => showView('viewWizard1'));
  document.getElementById('wizard2Next').addEventListener('click', handleWizard2Next);
  document.getElementById('wizard3Done').addEventListener('click', handleWizard3Done);

  // Birthday auto-age
  document.getElementById('birthday').addEventListener('change', (e) => {
    const age = calculateAge(e.target.value);
    document.getElementById('ageDisplay').textContent = age > 0 ? `Age: ${age}` : '';
  });

  // Upload inputs for wizard step 2 — plain visible file inputs
  [['bodyFileInput0','body',0],['bodyFileInput1','body',1],['bodyFileInput2','body',2],
   ['faceFileInput0','face',0],['faceFileInput1','face',1]].forEach(([id, cat, idx]) => {
    const input = document.getElementById(id);
    console.log(`[init] Setting up ${id}: found=${!!input}`);
    if (input) input.addEventListener('change', (e) => {
      console.log(`[init] change event on ${id}, files: ${e.target.files.length}`);
      if (e.target.files.length > 0) handleMultiPhotoUpload(cat, idx, e.target.files[0]);
    });
  });

  // Smart Search / Outfit Builder / Cosmetics tab switching
  document.querySelectorAll('.search-mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.search-mode-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const mode = tab.dataset.mode;
      document.getElementById('panelSmartSearch').classList.toggle('hidden', mode !== 'single');
      document.getElementById('panelOutfitBuilder').classList.toggle('hidden', mode !== 'outfit');
      document.getElementById('panelCosmetics').classList.toggle('hidden', mode !== 'cosmetics');
      document.getElementById('panelCompare').classList.toggle('hidden', mode !== 'compare');
      if (mode === 'cosmetics') loadCosmeticsFaceSelector();
    });
  });

  document.getElementById('smartSearchBtn').addEventListener('click', handleSmartSearch);
  document.getElementById('smartSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSmartSearch();
  });

  // Compare — search Google Shopping for price comparison
  document.getElementById('compareSearchBtn').addEventListener('click', handleCompareSearch);
  document.getElementById('compareSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleCompareSearch();
  });

  // Outfit Builder — open Virtual Wardrobe in a new tab
  document.getElementById('outfitBuildBtn').addEventListener('click', () => {
    const top = document.getElementById('outfitTop').value.trim();
    const bottom = document.getElementById('outfitBottom').value.trim();
    const shoes = document.getElementById('outfitShoes').value.trim();
    const errorEl = document.getElementById('outfitBuildError');
    errorEl.textContent = '';
    if (!top && !bottom) {
      errorEl.textContent = 'Please describe at least a top or bottom';
      return;
    }
    const necklace = document.getElementById('outfitNecklace').value.trim();
    const earrings = document.getElementById('outfitEarrings').value.trim();
    const bracelet = document.getElementById('outfitBracelets').value.trim();
    const outfitParams = new URLSearchParams();
    if (top) outfitParams.set('top', top);
    if (bottom) outfitParams.set('bottom', bottom);
    if (shoes) outfitParams.set('shoes', shoes);
    if (necklace) outfitParams.set('necklace', necklace);
    if (earrings) outfitParams.set('earrings', earrings);
    if (bracelet) outfitParams.set('bracelets', bracelet);
    if (cachedProfile?.clothesSize) outfitParams.set('clothesSize', cachedProfile.clothesSize);
    if (cachedProfile?.shoesSize) outfitParams.set('shoesSize', cachedProfile.shoesSize);
    if (cachedProfile?.sex) outfitParams.set('sex', cachedProfile.sex);
    const url = chrome.runtime.getURL('outfit-builder/wardrobe.html') + '?' + outfitParams.toString();
    chrome.tabs.create({ url });
  });

  // Edit profile
  document.getElementById('editProfileBtn').addEventListener('click', showEditProfile);
  document.getElementById('editProfileBack').addEventListener('click', () => loadProfileAndRoute());
  document.getElementById('editSaveInfoBtn').addEventListener('click', handleEditSaveInfo);
  document.getElementById('editRegenAiBtn').addEventListener('click', handleEditRegenAiPhotos);
  // Edit profile birthday auto-age
  document.getElementById('editBirthday').addEventListener('change', (e) => {
    const age = calculateAge(e.target.value);
    document.getElementById('editAgeDisplay').textContent = age > 0 ? `Age: ${age}` : '';
  });

  // Edit profile — 5-photo grid "Change" buttons + shared file input
  document.querySelectorAll('.edit-original-change-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      editOriginalReplaceIndex = parseInt(btn.dataset.index, 10);
      document.getElementById('editOriginalFileInput').click();
    });
  });
  document.getElementById('editOriginalFileInput').addEventListener('change', (e) => {
    if (e.target.files.length > 0 && editOriginalReplaceIndex !== null) {
      handleEditOriginalReplace(e.target.files[0], editOriginalReplaceIndex);
      e.target.value = '';
    }
  });

  // Image lightbox — click any profile photo to view full size
  const lightbox = document.getElementById('imageLightbox');
  document.querySelectorAll('.clickable-img').forEach((img) => {
    img.addEventListener('click', () => {
      if (!img.src || img.hidden) return;
      document.getElementById('lightboxImg').src = img.src;
      lightbox.classList.add('active');
    });
  });
  document.getElementById('lightboxClose').addEventListener('click', () => {
    lightbox.classList.remove('active');
  });
  lightbox.addEventListener('click', (e) => {
    if (e.target.classList.contains('lightbox-backdrop')) {
      lightbox.classList.remove('active');
    }
  });

  // Pose & Framing controls
  setupPoseAndFramingControls();

  // Favorites click → show favorites view
  document.getElementById('profileFavorites').addEventListener('click', showFavoritesView);
  document.getElementById('favBackBtn').addEventListener('click', () => loadProfileAndRoute());

  // Videos click → show videos view
  document.getElementById('profileVideos').addEventListener('click', showVideosView);
  document.getElementById('videosBackBtn').addEventListener('click', () => loadProfileAndRoute());

  // Backend URL
  const saveUrlBtn = document.getElementById('saveUrlBtn');
  if (saveUrlBtn) saveUrlBtn.addEventListener('click', saveBackendUrl);

  // Load backend URL
  const stored = await chrome.storage.local.get(['backendUrl']);
  const urlInput = document.getElementById('backendUrlInput');
  if (urlInput) urlInput.value = stored.backendUrl || DEFAULT_BACKEND_URL;

  // Check if opened as tab with a specific step (e.g. ?step=wizard2)
  const urlParams = new URLSearchParams(window.location.search);
  const forceStep = urlParams.get('step');

  // Check auth state
  const authData = await chrome.storage.local.get(['authTokens']);
  if (authData.authTokens && authData.authTokens.idToken) {
    // Check if token is expired
    if (authData.authTokens.expiresAt && authData.authTokens.expiresAt > Date.now()) {
      if (forceStep) {
        // forceStep is like "wizard2" → viewId is "viewWizard2"
        showView('view' + forceStep[0].toUpperCase() + forceStep.slice(1));
      } else {
        await loadProfileAndRoute();
      }
    } else if (authData.authTokens.refreshToken) {
      // Try refresh
      try {
        const newTokens = await sendMsg({
          type: 'API_CALL', endpoint: '/api/auth/refresh', method: 'POST',
          data: { refreshToken: authData.authTokens.refreshToken }
        });
        await chrome.storage.local.set({
          authTokens: {
            ...authData.authTokens,
            idToken: newTokens.idToken,
            accessToken: newTokens.accessToken,
            expiresAt: Date.now() + (newTokens.expiresIn * 1000),
          }
        });
        if (forceStep) {
          showView('view' + forceStep[0].toUpperCase() + forceStep.slice(1));
        } else {
          await loadProfileAndRoute();
        }
      } catch (_) {
        showView('viewSignIn');
      }
    } else {
      showView('viewSignIn');
    }
  } else {
    showView('viewSignIn');
  }

  checkBackendHealth();
}

document.addEventListener('DOMContentLoaded', init);

// ===================== Giselle Voice Assistant (Gemini Live API) =====================
(function initGiselle() {
  const fab = document.getElementById('giselleFab');
  const panel = document.getElementById('gisellePanel');
  const closeBtn = document.getElementById('giselleClose');
  const input = document.getElementById('giselleInput');
  const micBtn = document.getElementById('giselleMicBtn');
  const sendBtn = document.getElementById('giselleSendBtn');
  const messagesEl = document.getElementById('giselleMessages');

  if (!fab) return;

  // State
  let ws = null;
  let isStreaming = false;
  let captureContext = null;
  let playbackContext = null;
  let workletNode = null;
  let mediaStream = null;
  let audioQueue = [];
  let nextPlayTime = 0;
  let currentOutputMsg = null; // accumulates output transcription
  let currentInputMsg = null;  // accumulates input transcription
  let reconnectAttempted = false; // prevent infinite reconnect loops
  // sessionResumption removed — model does not support it (causes 1008)
  let cachedSearchScreenshot = null; // screenshot of smart search results for vision
  let cachedSearchProducts = null; // product data from smart search results
  let cachedOutfitItems = null; // outfit builder items by category for recommendations
  let recentTranscripts = []; // last few transcripts for extracting accessory mentions

  let pendingToolCall = false; // Audio gate — block audio during pending tool calls
  let sessionStartTime = 0; // Timestamp when session started — used to ignore early interruptions
  let isModelSpeaking = false; // True while model is outputting audio
  let modelSpeakingStartTime = 0; // When model started speaking (for AEC grace period)
  let muteNextModelTurn = false; // Suppress model's duplicate announcement after async tool response
  let loudChunkCount = 0; // Consecutive loud audio chunks (for barge-in detection)
  const ECHO_GRACE_MS = 3000; // Let browser AEC stabilize — protects full greeting from echo cutoff
  const BARGE_IN_RMS = 4500; // ~14% of max int16 — higher threshold filters echo better
  const BARGE_IN_CHUNKS = 4; // Need 4 consecutive loud chunks to confirm real barge-in
  let lastTryOnSource = null; // "outfit" or "search" — tracks which mode did the last try-on

  // Get WebSocket URL for the Vertex AI voice proxy on our backend
  function getWsUrl() {
    const httpUrl = DEFAULT_BACKEND_URL;
    return httpUrl.replace(/^https/, 'wss').replace(/^http/, 'ws') + '/ws/voice-live';
  }

  // Toggle panel
  fab.addEventListener('click', () => {
    const isHidden = panel.classList.contains('hidden');
    panel.classList.toggle('hidden');
    fab.classList.toggle('active', isHidden);
    if (isHidden) input.focus();
  });
  closeBtn.addEventListener('click', () => {
    panel.classList.add('hidden');
    fab.classList.remove('active');
    stopStreaming();
  });

  // Send text on Enter
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      sendTextMessage(input.value.trim());
      input.value = '';
    }
  });
  sendBtn.addEventListener('click', () => {
    if (input.value.trim()) {
      sendTextMessage(input.value.trim());
      input.value = '';
    }
  });

  // Mic button - toggle streaming
  micBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[Giselle] 🎤 Mic button clicked, isStreaming:', isStreaming);
    if (isStreaming) {
      stopStreaming();
    } else {
      startStreaming();
    }
  });

  function addMessage(role, text) {
    const msg = document.createElement('div');
    msg.className = `giselle-msg giselle-msg-${role === 'user' ? 'user' : 'bot'}`;
    msg.textContent = text;
    messagesEl.appendChild(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return msg;
  }

  // --- Vertex AI WebSocket connection (via backend proxy) ---

  async function ensureWsConnected() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const wsUrl = getWsUrl();
    console.log('[Giselle] Connecting to Vertex AI proxy:', wsUrl);

    return new Promise((resolve, reject) => {
      ws = new WebSocket(wsUrl);
      pendingToolCall = false;

      ws.onopen = () => {
        console.log('[Giselle] WebSocket connected to backend proxy');
        // Send setup message — backend handles Vertex AI auth and model config
        const userContext = {};
        if (cachedProfile) {
          userContext.name = cachedProfile.firstName || '';
          userContext.size = cachedProfile.clothesSize || '';
          userContext.shoesSize = cachedProfile.shoesSize || '';
          userContext.sex = cachedProfile.sex || '';
          userContext.language = cachedProfile.language || 'en';
          userContext.preferences = cachedProfile.preferences || '';
        }
        ws.send(JSON.stringify({ setup: { userContext } }));
      };

      ws.binaryType = 'arraybuffer';
      ws.onmessage = async (event) => {
        // Binary message = raw PCM audio from Gemini
        if (event.data instanceof ArrayBuffer) {
          if (muteNextModelTurn) return; // Suppress duplicate announcement after async tool
          if (!isModelSpeaking) {
            isModelSpeaking = true;
            modelSpeakingStartTime = Date.now();
            loudChunkCount = 0;
          }
          playAudioChunkBinary(event.data);
          return;
        }
        // Text message = JSON events (transcriptions, tool calls, etc.)
        let text;
        if (event.data instanceof Blob) {
          text = await event.data.text();
        } else {
          text = event.data;
        }
        try {
          const msg = JSON.parse(text);
          handleGeminiMessage(msg, resolve);
        } catch (e) {
          console.warn('[Giselle] Non-JSON message, ignoring');
        }
      };

      ws.onerror = (e) => {
        console.error('[Giselle] WebSocket error:', e);
        reject(new Error('WebSocket connection failed'));
      };

      ws.onclose = (e) => {
        console.log('[Giselle] WebSocket closed, code:', e.code, 'reason:', e.reason || '(none)');
        ws = null;
        // Auto-reconnect on unexpected close while streaming
        if (isStreaming && !reconnectAttempted) {
          reconnectAttempted = true;
          const reason = e.reason || `code ${e.code}`;
          addMessage('bot', `Session dropped (${reason}), reconnecting...`);
          stopStreaming();
          setTimeout(() => {
            startStreaming().then(() => {
              addMessage('bot', 'Reconnected! You can continue talking.');
              reconnectAttempted = false;
            }).catch(() => {
              addMessage('bot', 'Could not reconnect. Click the mic to start a new conversation.');
              reconnectAttempted = false;
            });
          }, 1000);
        } else if (isStreaming) {
          stopStreaming();
        }
      };
    });
  }

  /**
   * Handle raw Gemini Live API messages (direct connection format).
   * Maps Gemini's native message format to the same handler logic.
   */
  function handleGeminiMessage(msg, onSetupComplete) {
    // Setup complete
    if (msg.setupComplete) {
      console.log('[Giselle] Session ready (direct)');
      sessionStartTime = Date.now();
      muteNextModelTurn = false; // Reset on new session
      isModelSpeaking = false;
      loudChunkCount = 0;
      if (onSetupComplete) onSetupComplete();
      return;
    }

    // Audio now arrives as binary ArrayBuffer (handled in ws.onmessage above)
    // Text/thinking parts from model are suppressed by the backend

    // Turn complete
    if (msg.serverContent?.turnComplete) {
      isModelSpeaking = false;
      loudChunkCount = 0;
      muteNextModelTurn = false; // Allow speech on subsequent turns
      userSpokeSinceLastModelTurn = false; // Reset — user hasn't spoken yet since this model turn ended
      currentOutputMsg = null;
      currentInputMsg = null;
    }

    // Barge-in / interrupted
    if (msg.serverContent?.interrupted) {
      isModelSpeaking = false;
      loudChunkCount = 0;
      stopPlayback();
      pendingToolCall = false; // Ungate audio so user can speak after interruption
    }

    // Input transcription (what the user said)
    if (msg.serverContent?.inputTranscription?.text) {
      // Disabled to prevent noise transcription
    }

    // Output transcription (what the model said)
    if (msg.serverContent?.outputTranscription?.text && !muteNextModelTurn) {
      currentInputMsg = null;
      const text = msg.serverContent.outputTranscription.text;
      if (text) {
        if (!currentOutputMsg) {
          currentOutputMsg = addMessage('bot', text);
        } else {
          currentOutputMsg.textContent += text;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      }
    }

    // Tool calls — gate audio
    if (msg.toolCall?.functionCalls) {
      if (muteNextModelTurn) {
        // Model is re-calling a tool after receiving tool response — skip to prevent duplicates
        console.warn('[Giselle] ⚠️ Ignoring duplicate tool calls during muted turn:', msg.toolCall.functionCalls.map(c => c.name).join(', '));
        // Send empty responses so Gemini doesn't hang waiting
        for (const call of msg.toolCall.functionCalls) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              toolResponse: { functionResponses: [{ id: call.id, name: call.name, response: { result: 'Already in progress.' } }] },
            }));
          }
        }
      } else {
        pendingToolCall = true;
        console.log('[Giselle] 🔧 Tool calls received (audio gated):', msg.toolCall.functionCalls.map(c => `${c.name}(${JSON.stringify(c.args || {}).substring(0, 100)})`).join(', '));
        handleToolCalls(msg.toolCall.functionCalls);
      }
    }

    // Tool call cancellation — ungate audio
    if (msg.toolCallCancellation?.ids) {
      pendingToolCall = false;
      console.warn('[Giselle] ❌ Tool calls CANCELLED:', JSON.stringify(msg.toolCallCancellation.ids));
    }

    // Server going away
    if (msg.goAway) {
      if (!reconnectAttempted) {
        reconnectAttempted = true;
        addMessage('bot', 'Session expiring, reconnecting...');
        stopStreaming();
        setTimeout(() => {
          startStreaming().then(() => {
            addMessage('bot', 'Reconnected! You can continue talking.');
            reconnectAttempted = false;
          }).catch(() => {
            addMessage('bot', 'Could not reconnect. Click the mic to start a new conversation.');
            reconnectAttempted = false;
          });
        }, 1000);
      } else {
        addMessage('bot', 'Session ending soon. Click the mic to start a new session.');
        stopStreaming();
      }
    }
  }

  // Listen for search results from the smart search results page (for voice agent vision)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SEARCH_RESULTS_LOADED') {
      cachedSearchProducts = msg.products || null;
      cachedSearchScreenshot = msg.screenshot || null;
      cachedOutfitItems = null; // clear outfit cache when new search loads
      console.log('[Giselle] Cached search results:', msg.products?.length, 'screenshot:', !!msg.screenshot);
      // If voice session is active, send the screenshot to Gemini so Giselle can see the products
      if (ws && ws.readyState === WebSocket.OPEN && cachedSearchScreenshot) {
        const screenshotBase64 = cachedSearchScreenshot.startsWith('data:')
          ? cachedSearchScreenshot.split(',')[1]
          : cachedSearchScreenshot;
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{
              role: 'user',
              parts: [
                { inlineData: { data: screenshotBase64, mimeType: 'image/jpeg' } },
                { text: `[System: Smart search results are now showing ${msg.products?.length || 0} products on screen. The user is browsing. Do NOT recommend items. Do NOT call recommend_items. Wait SILENTLY for the user to speak first. Only recommend if the user EXPLICITLY asks you to.]` },
              ],
            }],
            turnComplete: false,
          },
        }));
        console.log('[Giselle] Sent search results screenshot to voice session');
      }
    }
    if (msg.type === 'OUTFIT_RESULTS_LOADED') {
      cachedOutfitItems = msg.outfitItems || null;
      console.log('[Giselle] Cached outfit items for recommendations:', msg.totalItems, 'items across', Object.keys(msg.outfitItems || {}).filter(k => (msg.outfitItems[k] || []).length > 0).join(', '));
      // If voice session is active, tell Giselle about the outfit items
      if (ws && ws.readyState === WebSocket.OPEN && cachedOutfitItems) {
        const summary = Object.entries(cachedOutfitItems)
          .filter(([, items]) => items.length > 0)
          .map(([cat, items]) => `${cat}: ${items.length} items`)
          .join(', ');
        sendGeminiText(`[System: The outfit builder UI has loaded with ${summary}. The user is now browsing items. Do NOT recommend items. Do NOT call recommend_items. Do NOT suggest which items to pick. Wait SILENTLY for the user to speak first. Only recommend if the user EXPLICITLY asks you to.]`);
        console.log('[Giselle] Sent outfit items context to voice session');
      }
    }
    // Notify Gemini when async operations complete so it knows the user can see the result
    if (msg.type === 'TRYON_COMPLETE') {
      tryOnInFlight = false;
      sendGeminiText('[System: The try-on result is now visible on the user\'s screen. Do NOT call any tools. Do NOT ask questions. Wait silently for the user to speak first.]');
      console.log('[Giselle] Notified Gemini: try-on complete (tryOnInFlight cleared)');
    }
    if (msg.type === 'VIDEO_COMPLETE') {
      sendGeminiText('[System: The video animation is now playing on the user\'s screen. Do NOT call any tools — especially do NOT call save_video. Do NOT ask questions. Wait silently for the user to speak first.]');
      console.log('[Giselle] Notified Gemini: video complete');
    }
  });

  // handleServerMessage removed — now using handleGeminiMessage for direct connection

  // --- Audio capture ---

  async function startStreaming() {
    try {
      addMessage('bot', 'Listening...');

      // Create playback context FIRST so greeting audio isn't dropped
      // (Gemini starts speaking as soon as session opens — if playbackContext
      // doesn't exist yet, playAudioChunk silently discards those chunks)
      if (!playbackContext) {
        playbackContext = new AudioContext({ sampleRate: 24000 });
        await playbackContext.resume();
      }
      audioQueue = [];
      nextPlayTime = 0;

      await ensureWsConnected();

      // Check if getUserMedia is available (may not be in side panel context)
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        addMessage('bot', 'Microphone is not available in this context. Please open the extension in a full tab (click the extension icon while holding Ctrl/Cmd).');
        return;
      }

      // Request microphone — may fail in side panel if permission not yet granted
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (micErr) {
        console.warn('[Giselle] Mic permission failed in side panel:', micErr.name);
        if (micErr.name === 'NotAllowedError' || micErr.name === 'PermissionDeniedError') {
          addMessage('bot', 'Microphone permission denied. Please click the microphone icon in your browser address bar to allow access, then try again.');
        } else if (micErr.name === 'NotFoundError') {
          addMessage('bot', 'No microphone found. Please connect a microphone and try again.');
        } else {
          addMessage('bot', 'Could not access microphone (' + micErr.name + '). Try using the text input instead.');
        }
        stopStreaming();
        return;
      }

      // Create capture AudioContext at 16kHz
      captureContext = new AudioContext({ sampleRate: 16000 });
      console.log('[Giselle] AudioContext sampleRate:', captureContext.sampleRate);
      const source = captureContext.createMediaStreamSource(mediaStream);

      // Load AudioWorklet
      const workletUrl = chrome.runtime.getURL('popup/audio-worklet-processor.js');
      await captureContext.audioWorklet.addModule(workletUrl);
      workletNode = new AudioWorkletNode(captureContext, 'pcm-capture-processor');

      // Send PCM chunks to backend
      // When model is silent: send all audio freely (automatic VAD handles it)
      // When model is speaking: energy-threshold gating allows real barge-in but blocks echo
      let audioChunkCount = 0;
      let maxAudioLevel = 0;
      workletNode.port.onmessage = (e) => {
        if (!ws || ws.readyState !== WebSocket.OPEN || pendingToolCall) return;

        const int16Array = new Int16Array(e.data);

        // Track audio levels for debugging
        for (let i = 0; i < int16Array.length; i++) {
          const absVal = Math.abs(int16Array[i]);
          if (absVal > maxAudioLevel) maxAudioLevel = absVal;
        }
        audioChunkCount++;
        if (audioChunkCount % 100 === 0) {
          console.log(`[Giselle] 🎙️ Audio: ${audioChunkCount} chunks sent, peak level: ${maxAudioLevel} / 32768 (${(maxAudioLevel / 32768 * 100).toFixed(1)}%), modelSpeaking: ${isModelSpeaking}, sampleRate: ${captureContext.sampleRate}`);
          maxAudioLevel = 0;
        }

        // Model is silent — send all audio freely
        if (!isModelSpeaking) {
          ws.send(int16Array.buffer);
          userSpokeSinceLastModelTurn = true; // User is speaking
          return;
        }

        // Model IS speaking — use energy-based gating for barge-in
        // Grace period: let browser AEC calibrate before allowing any audio through
        if (Date.now() - modelSpeakingStartTime < ECHO_GRACE_MS) return;

        // Calculate RMS energy of this chunk
        let sumSquares = 0;
        for (let i = 0; i < int16Array.length; i++) {
          sumSquares += int16Array[i] * int16Array[i];
        }
        const rms = Math.sqrt(sumSquares / int16Array.length);

        if (rms > BARGE_IN_RMS) {
          loudChunkCount++;
          if (loudChunkCount >= BARGE_IN_CHUNKS) {
            // Real barge-in detected — stop model playback locally and send user audio
            if (isModelSpeaking) {
              console.log('[Giselle] 🔇 Barge-in! Stopping model playback, RMS:', Math.round(rms));
              stopPlayback();
              isModelSpeaking = false;
              loudChunkCount = 0;
              muteNextModelTurn = true; // Suppress remaining audio from this model turn
            }
            ws.send(int16Array.buffer);
            userSpokeSinceLastModelTurn = true;
          }
        } else {
          loudChunkCount = 0;
        }
      };

      source.connect(workletNode);
      // Connect worklet to a silent output (gain=0) to keep processing active
      // without playing mic audio back through speakers (which causes feedback)
      const silentDest = captureContext.createGain();
      silentDest.gain.value = 0;
      silentDest.connect(captureContext.destination);
      workletNode.connect(silentDest);

      isStreaming = true;
      micBtn.classList.add('recording');
      fab.classList.add('streaming');

      console.log('[Giselle] Streaming started');
    } catch (err) {
      console.error('[Giselle] Failed to start streaming:', err);
      addMessage('bot', 'Voice streaming failed: ' + err.message + '. Try using the text input instead.');
      stopStreaming();
    }
  }

  function stopStreaming() {
    console.log('[Giselle] stopStreaming called, isStreaming:', isStreaming, 'ws:', ws?.readyState);
    // Stop audio capture
    if (workletNode) {
      workletNode.disconnect();
      workletNode = null;
    }
    if (captureContext) {
      captureContext.close().catch(() => {});
      captureContext = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }

    // Close WebSocket to end the Gemini session
    const wsRef = ws;
    ws = null; // clear immediately to prevent re-entrant calls
    pendingToolCall = false;
    if (wsRef) {
      try {
        if (wsRef.readyState === WebSocket.OPEN || wsRef.readyState === WebSocket.CONNECTING) {
          wsRef.close();
        }
      } catch (e) {
        console.warn('[Giselle] Error closing WebSocket:', e.message);
      }
    }

    stopPlayback();

    isStreaming = false;
    micBtn.classList.remove('recording');
    fab.classList.remove('streaming');
    currentOutputMsg = null;
    currentInputMsg = null;

    console.log('[Giselle] Streaming stopped, WebSocket closed');
  }

  // --- Audio playback ---

  // Play raw PCM binary (ArrayBuffer) — used for binary WebSocket messages
  function playAudioChunkBinary(arrayBuffer) {
    if (!playbackContext) return;
    const int16 = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    const audioBuffer = playbackContext.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);
    const source = playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(playbackContext.destination);
    const now = playbackContext.currentTime;
    const startTime = Math.max(now, nextPlayTime);
    source.start(startTime);
    nextPlayTime = startTime + audioBuffer.duration;
  }

  // Legacy: play base64-encoded audio (kept for compatibility)
  function playAudioChunk(base64Data, mimeType) {
    if (!playbackContext) return;

    const int16 = base64ToInt16(base64Data);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = playbackContext.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const source = playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackContext.destination);

    // Schedule gapless playback
    const now = playbackContext.currentTime;
    if (nextPlayTime < now) nextPlayTime = now;
    source.start(nextPlayTime);
    audioQueue.push(source);
    nextPlayTime += buffer.duration;

    // Clean up finished sources
    source.onended = () => {
      const idx = audioQueue.indexOf(source);
      if (idx !== -1) audioQueue.splice(idx, 1);
    };
  }

  function stopPlayback() {
    for (const source of audioQueue) {
      try { source.stop(); } catch (_) {}
    }
    audioQueue = [];
    nextPlayTime = 0;
    if (playbackContext) {
      playbackContext.close().catch(() => {});
      playbackContext = new AudioContext({ sampleRate: 24000 });
      playbackContext.resume().catch(() => {});
    }
  }

  // --- Base64 <-> Int16 conversion ---

  function int16ToBase64(int16Array) {
    const bytes = new Uint8Array(int16Array.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToInt16(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Int16Array(bytes.buffer);
  }

  // --- Text message (fallback) ---

  function sendGeminiText(text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true,
        },
      }));
    }
  }

  function sendTextMessage(text) {
    addMessage('user', text);
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendGeminiText(text);
    } else {
      ensureWsConnected().then(() => {
        sendGeminiText(text);
      }).catch(() => {
        addMessage('bot', 'Could not connect to voice service. Please try again.');
      });
    }
  }

  // --- Tool/intent handling ---

  // Track outfit builder confirmation state
  let outfitConfirmedNoAccessories = false;
  let pendingOutfitData = null;
  let userSpokeSinceLastModelTurn = false; // Tracks if user spoke since model's last turn — used to enforce confirmation

  // Track last executed tool call to prevent loops
  let lastToolCallKey = null;
  let lastToolCallTime = 0;
  const TOOL_DEDUP_WINDOW_MS = 5000; // ignore same tool+args within 5 seconds
  let tryOnInFlight = false; // true while a VOICE_SELECT_SEARCH_ITEM try-on is in progress

  function handleToolCalls(functionCalls) {
    // Helper to send a single tool response back to Gemini (native format)
    function sendToolResp(callId, callName, result) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          toolResponse: {
            functionResponses: [{ id: callId, name: callName, response: { result } }],
          },
        }));
        pendingToolCall = false; // Ungate audio after tool response
        console.log(`[Giselle] ✅ Tool response sent for ${callName} — audio ungated, result: ${typeof result === 'string' ? result.substring(0, 120) : result}`);
      }
    }

    // If Gemini calls build_outfit a second time (after being told to ask),
    // it means the user confirmed — allow it through
    for (const call of functionCalls) {
      if (call.name === 'build_outfit' && pendingOutfitData) {
        // Merge pending data with any new data from this call
        const merged = { ...pendingOutfitData, ...(call.args || {}) };
        // If Gemini STILL didn't include accessories in the args, try to extract from recent conversation
        if (!merged.necklace && !merged.earrings && !merged.bracelet) {
          const convo = recentTranscripts.join(' ');
          // Extract accessory mentions from what the user said
          const neckMatch = convo.match(/(?:a\s+|an?\s+)?(\w+(?:\s+\w+)?)\s+necklace/);
          const earMatch = convo.match(/(?:a\s+|an?\s+)?(\w+(?:\s+\w+)?)\s+earrings?/);
          const bracMatch = convo.match(/(?:a\s+|an?\s+)?(\w+(?:\s+\w+)?)\s+bracelet/);
          if (neckMatch) merged.necklace = neckMatch[0].replace(/^an?\s+/, '').trim();
          if (earMatch) merged.earrings = earMatch[0].replace(/^an?\s+/, '').trim();
          if (bracMatch) merged.bracelet = bracMatch[0].replace(/^an?\s+/, '').trim();
          if (neckMatch || earMatch || bracMatch) {
            console.log('[Giselle] Extracted accessories from conversation:', { necklace: merged.necklace, earrings: merged.earrings, bracelet: merged.bracelet });
          }
        }
        call.args = merged;
        outfitConfirmedNoAccessories = true;
        pendingOutfitData = null;
      }
    }

    // Process each tool call independently — async tools use continue, not return
    for (const call of functionCalls) {
      const data = call.args || {};

      // Deduplication guard — prevent the same tool+args from executing in a loop
      const toolKey = `${call.name}:${JSON.stringify(data)}`;
      const now = Date.now();
      if (toolKey === lastToolCallKey && (now - lastToolCallTime) < TOOL_DEDUP_WINDOW_MS) {
        console.warn(`[Giselle] 🔁 BLOCKED duplicate tool call: ${call.name}(${JSON.stringify(data)}) — same call ${now - lastToolCallTime}ms ago`);
        sendToolResp(call.id, call.name, 'This action was already executed moments ago. Do NOT repeat it. Wait for the user to speak.');
        continue;
      }
      lastToolCallKey = toolKey;
      lastToolCallTime = now;

      console.log(`[Giselle] 🔧 Executing tool: ${call.name}(${JSON.stringify(data)})`);

      switch (call.name) {
        case 'search_product': {
          if (data.query) {
            const searchInput = document.getElementById('smartSearchInput');
            if (searchInput) {
              searchInput.value = data.query;
              document.getElementById('smartSearchBtn')?.click();
            }
          }
          sendToolResp(call.id, call.name, 'OK. Do NOT speak again until you receive a system notification that results are ready.');
          muteNextModelTurn = true;
          continue;
        }
        case 'build_outfit': {
          // Guard: user must have spoken (confirmed) before we execute build_outfit
          if (!userSpokeSinceLastModelTurn) {
            console.warn('[Giselle] ⚠️ build_outfit blocked — user has not confirmed yet (no speech since last model turn)');
            sendToolResp(call.id, call.name, 'WAIT — the user has not confirmed yet. You MUST ask "How does that sound? Would you like to change anything?" and wait for the user to respond before calling build_outfit. Do NOT call build_outfit again until the user speaks.');
            continue;
          }
          // Guard: if no accessories provided, bounce back to Gemini to ask the user
          // Skip guard for thinking-based synthetic calls — they can't send tool responses back
          const isSyntheticCall = call.id && call.id.startsWith('thinking-');
          const hasAccessories = data.necklace || data.earrings || data.bracelet;
          const itemCount = [data.top, data.bottom, data.shoes, data.necklace, data.earrings, data.bracelet].filter(Boolean).length;
          if (!isSyntheticCall && !hasAccessories && !outfitConfirmedNoAccessories) {
            // First call without accessories — tell Gemini to ask about them
            outfitConfirmedNoAccessories = false; // reset
            const missing = [];
            if (!data.necklace) missing.push('necklace');
            if (!data.earrings) missing.push('earrings');
            if (!data.bracelet) missing.push('bracelet');
            const existingItems = Object.entries(data).filter(([,v]) => v).map(([k,v]) => `${k}="${v}"`).join(', ');
            sendToolResp(call.id, call.name, `HOLD — do NOT build yet. You currently have: ${existingItems}. Ask the user if they want to add accessories (${missing.join(', ')}). When you call build_outfit again, you MUST include ALL items as named parameters — both the ones listed above AND any new accessories the user adds. For example: build_outfit(${existingItems}, necklace="...", earrings="...", bracelet="...")`);
            // Store the pending items so we can use them on the next call
            pendingOutfitData = data;
            continue;
          }
          // User confirmed or accessories provided — execute the build
          outfitConfirmedNoAccessories = false;
          pendingOutfitData = null;
          // Switch to the outfit builder tab first
          document.getElementById('tabOutfitBuilder')?.click();
          // Delay to allow the tab content to render before filling fields
          setTimeout(() => {
            const fields = [
              { id: 'outfitTop', value: data.top },
              { id: 'outfitBottom', value: data.bottom },
              { id: 'outfitShoes', value: data.shoes },
              { id: 'outfitNecklace', value: data.necklace },
              { id: 'outfitEarrings', value: data.earrings },
              { id: 'outfitBracelets', value: data.bracelet },
            ];
            for (const field of fields) {
              if (field.value) {
                const el = document.getElementById(field.id);
                if (el) {
                  el.value = field.value;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }
            }
            document.getElementById('outfitBuildBtn')?.click();
          }, 300);
          sendToolResp(call.id, call.name, 'OK. Do NOT speak again until you receive a system notification that items are ready.');
          muteNextModelTurn = true;
          continue;
        }
        case 'add_to_cart': {
          if (data.productUrl) {
            sendMsg({
              type: 'ADD_TO_CART',
              productUrl: data.productUrl,
              quantity: data.quantity || 1,
            }).then(result => {
              sendToolResp(call.id, call.name, result?.success ? 'Added to cart' : 'Failed to add');
            }).catch(() => {
              sendToolResp(call.id, call.name, 'Error adding to cart');
            });
            continue; // async — response sent in .then/.catch
          }
          sendToolResp(call.id, call.name, 'No product URL provided');
          continue;
        }
        case 'try_on': {
          // Parse item number from args or from query text
          let itemNum = data.itemNumber || null;
          if (!itemNum && data.query) {
            const numMatch = data.query.match(/(?:item|number|#)\s*(\d+)/i) || data.query.match(/^(\d+)$/);
            if (numMatch) itemNum = parseInt(numMatch[1], 10);
          }

          if (itemNum) {
            // Block at the source — don't send VOICE_SELECT_SEARCH_ITEM if one is already in flight
            if (tryOnInFlight) {
              console.warn(`[Giselle] ⚠️ try_on blocked — try-on already in flight`);
              sendToolResp(call.id, call.name, 'A try-on is already in progress. Wait for it to finish before trying on another item.');
              continue;
            }
            tryOnInFlight = true;
            muteNextModelTurn = true; // Set synchronously to block any immediate follow-up tool calls
            lastTryOnSource = 'search';
            addMessage('bot', `Trying on item ${itemNum} from the search results!`);
            chrome.runtime.sendMessage({
              type: 'VOICE_SELECT_SEARCH_ITEM',
              number: itemNum,
            }, (resp) => {
              const result = resp?.data || resp;
              if (result?.status === 'not_found') {
                tryOnInFlight = false;
                muteNextModelTurn = false;
                sendToolResp(call.id, call.name, `Item ${itemNum} is not available — search results have not finished loading yet. Tell the user to wait for results to load.`);
              } else if (result?.status === 'no_tab') {
                tryOnInFlight = false;
                muteNextModelTurn = false;
                sendToolResp(call.id, call.name, 'The search results page is not open yet. Wait for the search to complete.');
              } else {
                sendToolResp(call.id, call.name, 'OK. Do NOT speak again until you receive a system notification that the result is visible.');
                // tryOnInFlight cleared when TRYON_COMPLETE arrives
              }
            });
            continue; // async
          }

          // No item number — fall back to search behavior
          if (data.query) {
            addMessage('bot', `I'll help you try on "${data.query}"! Searching for it now.`);
            const searchInput = document.getElementById('smartSearchInput');
            if (searchInput) {
              searchInput.value = data.query;
              document.getElementById('smartSearchBtn')?.click();
            }
          }
          sendToolResp(call.id, call.name, 'OK. Do NOT speak again until you receive a system notification that the result is visible.');
          muteNextModelTurn = true;
          continue;
        }
        case 'show_favorites': {
          document.getElementById('profileFavorites')?.click();
          sendToolResp(call.id, call.name, 'Favorites shown');
          continue;
        }
        case 'save_to_favorites': {
          // Send message to content script to save the current try-on result
          sendMsg({ type: 'SAVE_TO_FAVORITES', source: lastTryOnSource || 'search' }).then((result) => {
            if (result?.success === false) {
              sendToolResp(call.id, call.name, result.error || 'No try-on result to save. Try on an item first.');
            } else {
              sendToolResp(call.id, call.name, 'Done — saved to favorites.');
            }
          }).catch(() => {
            sendToolResp(call.id, call.name, 'No try-on result to save. Try on an item first.');
          });
          continue; // async — response sent in .then/.catch
        }
        case 'animate': {
          // Trigger animate button on the current try-on result
          sendMsg({ type: 'ANIMATE_TRYON', source: lastTryOnSource || 'search' }).then((result) => {
            if (result?.success === false) {
              sendToolResp(call.id, call.name, result.error || 'No try-on result to animate. Try on an item first.');
            } else {
              sendToolResp(call.id, call.name, 'Animation started. Wait silently for the system notification that the video is ready.');
              muteNextModelTurn = true;
            }
          }).catch(() => {
            sendToolResp(call.id, call.name, 'No try-on result to animate. Try on an item first.');
          });
          continue; // async — response sent in .then/.catch
        }
        case 'save_video': {
          // Send message to content script to save the current video
          sendMsg({ type: 'SAVE_VIDEO', source: lastTryOnSource || 'search' }).then((result) => {
            sendToolResp(call.id, call.name, result?.success ? 'Done — video saved.' : 'Failed to save video. Generate a video first.');
          }).catch(() => {
            sendToolResp(call.id, call.name, 'No video to save. Generate a video first.');
          });
          continue; // async — response sent in .then/.catch
        }
        case 'show_videos': {
          document.getElementById('profileVideos')?.click();
          sendToolResp(call.id, call.name, 'Videos shown');
          continue;
        }
        case 'recommend_items': {
          const isOutfitMode = !!cachedOutfitItems && Object.values(cachedOutfitItems).some(arr => arr.length > 0);
          console.log('[recommend_items] 🎯 Tool called! mode:', isOutfitMode ? 'OUTFIT' : 'SEARCH', 'cachedScreenshot:', !!cachedSearchScreenshot, 'cachedProducts:', cachedSearchProducts?.length || 0, 'cachedOutfitItems:', isOutfitMode ? Object.entries(cachedOutfitItems).filter(([,v]) => v.length > 0).map(([k,v]) => `${k}:${v.length}`).join(',') : 'none');

          // Guard: if no data is available, tell the agent to wait
          if (!isOutfitMode && !cachedSearchScreenshot && (!cachedSearchProducts || cachedSearchProducts.length === 0)) {
            sendToolResp(call.id, call.name, 'No items are loaded yet. The outfit builder or search results must finish loading before you can recommend items. Tell the user to wait for the items to load, then ask again.');
            continue;
          }

          if (isOutfitMode) {
            // OUTFIT BUILDER MODE: recommend best combination of items across 6 categories
            addMessage('bot', 'Let me find the perfect outfit combination for you...');

            const outfitRecommend = async () => {
              // Get user's body photo
              const photos = await sendMsg({ type: 'GET_USER_PHOTOS' });
              const userPhoto = photos?.bodyPhoto || null;
              const userProfile = cachedProfile ? { sex: cachedProfile.sex, clothesSize: cachedProfile.clothesSize } : {};

              // Also capture screenshot of the outfit builder
              let screenshot = null;
              try {
                const captureResp = await new Promise((resolve) => {
                  chrome.runtime.sendMessage({ type: 'CAPTURE_TAB_SCREENSHOT' }, resolve);
                });
                screenshot = captureResp?.data || null;
                console.log('[recommend_items] 📸 Outfit builder screenshot:', screenshot ? `${(screenshot.length / 1024).toFixed(0)}KB` : 'null');
              } catch (e) {
                console.warn('[recommend_items] ⚠️ Outfit screenshot capture failed:', e);
              }

              // Build structured product list per category
              const categoryLists = Object.entries(cachedOutfitItems)
                .filter(([, items]) => items.length > 0)
                .map(([cat, items]) => {
                  const itemList = items.map(p => `  #${p.number}: "${p.title}" — ${p.price || 'no price'}`).join('\n');
                  return `${cat.toUpperCase()} (${items.length} items):\n${itemList}`;
                }).join('\n\n');

              try {
                const resp = await fetch(`${DEFAULT_BACKEND_URL}/api/recommend`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    userPhoto: userPhoto || null,
                    screenshot: screenshot || null,
                    products: [], // not used for outfit mode
                    userProfile,
                    outfitMode: true,
                    outfitItems: cachedOutfitItems,
                  }),
                });
                const result = await resp.json();
                console.log('[recommend_items] 📊 Outfit API response:', JSON.stringify(result).substring(0, 500));
                if (result.outfitCombination) {
                  // Auto-select recommended items in wardrobe (don't rely on voice model)
                  const picks = Object.entries(result.outfitCombination).filter(([, v]) => v && v.number);
                  picks.forEach(([cat, pick], i) => {
                    setTimeout(() => {
                      chrome.runtime.sendMessage({
                        type: 'VOICE_SELECT_OUTFIT_ITEMS',
                        category: cat,
                        number: pick.number,
                      });
                    }, i * 250);
                  });

                  const comboText = Object.entries(result.outfitCombination)
                    .filter(([, v]) => v)
                    .map(([cat, pick]) => `${cat}: #${pick.number} — ${pick.reason}`)
                    .join('\n');
                  console.log('[recommend_items] Sending outfit combination back to Gemini + auto-selecting', picks.length, 'items');
                  sendToolResp(call.id, call.name,
                    `AI VISION ANALYSIS RESULTS — relay each reason to the user:\n\n${comboText}\n${result.overallReason ? '\nOverall styling: ' + result.overallReason : ''}\n\nINSTRUCTIONS: Present picks category by category. For EACH item, say the number, describe the piece, and explain WHY it was chosen.\n- For clothing (top, bottom, shoes): explain how it flatters the user's body/skin tone.\n- For accessories (necklace, earrings, bracelet): describe WHAT you like about the specific piece (its design, texture, color) AND how it coordinates with the other accessories and the outfit. Example: "For the necklace, I picked number 3, the layered gold chain — I love how the delicate layers add dimension, and the warm gold ties beautifully with the earrings and bracelet."\nNEVER give generic one-liners like "adds a polished touch." Each accessory deserves 2 sentences minimum.\n\nAfter all 6, ask "Would you like to try this outfit on?" and WAIT.`
                  );
                } else if (result.recommendations && result.recommendations.length > 0) {
                  // Fallback to flat recommendations
                  const recText = result.recommendations
                    .slice(0, 8)
                    .map(r => `${r.category ? r.category + ' ' : ''}#${r.number} (score ${r.score}/10): ${r.reason}`)
                    .join('\n');
                  sendToolResp(call.id, call.name,
                    `Here are my personalized recommendations:\n${recText}\n\nTell the user these recommendations naturally, mentioning specific item numbers per category.`
                  );
                } else {
                  console.warn('[recommend_items] ⚠️ No outfit combination in response');
                  // Fallback: send structured product data as text
                  sendToolResp(call.id, call.name,
                    `I could not fully analyze the images but here are the outfit items available:\n\n${categoryLists}\n\nRecommend the best combination based on color coordination, style matching, and your fashion expertise. Pick ONE item per category.`
                  );
                }
              } catch (err) {
                console.error('[recommend_items] ❌ Outfit API error:', err);
                sendToolResp(call.id, call.name,
                  `Vision analysis failed, but here are the outfit items:\n\n${categoryLists}\n\nRecommend the best combination based on color coordination and style matching. Pick ONE item per category.`
                );
              }
            };
            outfitRecommend().catch((err) => {
              console.error('[recommend_items] Outfit error:', err);
              sendToolResp(call.id, call.name, 'Failed to analyze outfit items. Ask the user to try again.');
            });
          } else {
            // SMART SEARCH MODE: recommend individual items from search results
            addMessage('bot', 'Let me analyze these products for you...');

            const captureAndRecommend = async () => {
              let screenshot = cachedSearchScreenshot;
              let products = cachedSearchProducts;
              if (!screenshot) {
                console.log('[recommend_items] ⚠️ No cached screenshot, capturing on-the-fly...');
                try {
                  const captureResp = await new Promise((resolve) => {
                    chrome.runtime.sendMessage({ type: 'CAPTURE_TAB_SCREENSHOT' }, resolve);
                  });
                  screenshot = captureResp?.data || null;
                  console.log('[recommend_items] 📸 On-the-fly capture result:', screenshot ? `${(screenshot.length / 1024).toFixed(0)}KB` : 'null');
                } catch (e) {
                  console.warn('[recommend_items] ❌ Screenshot capture failed:', e);
                }
              }
              if (!screenshot) {
                console.warn('[recommend_items] ❌ No screenshot available at all — cannot recommend');
                sendToolResp(call.id, call.name, 'No search results visible. Ask the user to search for products first.');
                return;
              }
              console.log('[recommend_items] ✅ Have screenshot, calling /api/recommend...');
              const photos = await sendMsg({ type: 'GET_USER_PHOTOS' });
              const userPhoto = photos?.bodyPhoto || null;
              const userProfile = cachedProfile ? { sex: cachedProfile.sex, clothesSize: cachedProfile.clothesSize } : {};
              try {
                const resp = await fetch(`${DEFAULT_BACKEND_URL}/api/recommend`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    userPhoto: userPhoto || null,
                    screenshot,
                    products: products || [],
                    userProfile,
                  }),
                });
                const result = await resp.json();
                console.log('[recommend_items] 📊 API response:', JSON.stringify(result).substring(0, 300));
                if (result.recommendations && result.recommendations.length > 0) {
                  const recText = result.recommendations
                    .slice(0, 5)
                    .map(r => `Item #${r.number} (score ${r.score}/10): ${r.reason}`)
                    .join('\n');
                  console.log('[recommend_items] ✅ Sending', result.recommendations.length, 'recommendations back to Gemini');
                  sendToolResp(call.id, call.name,
                    `Here are my personalized recommendations based on visual analysis:\n${recText}\n\nTell the user these recommendations naturally, mentioning specific item numbers and why each suits them.`
                  );
                } else {
                  console.warn('[recommend_items] ⚠️ No recommendations in response');
                  sendToolResp(call.id, call.name, 'Could not generate recommendations. Ask the user to try again.');
                }
              } catch (err) {
                console.error('[recommend_items] ❌ API error:', err);
                const productSummary = (products || []).map(p =>
                  `#${p.number}: ${p.title} — ${p.price}`
                ).join('\n');
                sendToolResp(call.id, call.name,
                  `Vision analysis failed. Here are the products for reference:\n${productSummary}\nRecommend based on the titles and your fashion expertise.`
                );
              }
            };
            captureAndRecommend().catch((err) => {
              console.error('[recommend_items] Error:', err);
              sendToolResp(call.id, call.name, 'Failed to analyze products. Ask the user to try again.');
            });
          }
          continue; // async
        }
        case 'select_search_item': {
          lastTryOnSource = 'search';
          const itemNum = parseInt(data.number, 10);
          if (!itemNum || itemNum < 1) {
            sendToolResp(call.id, call.name, 'Invalid item number.');
            continue;
          }
          // Block at the source — don't send if a try-on is already in flight
          if (tryOnInFlight) {
            console.warn(`[Giselle] ⚠️ select_search_item blocked — try-on already in flight`);
            sendToolResp(call.id, call.name, 'A try-on is already in progress. Wait for it to finish before selecting another item.');
            continue;
          }
          tryOnInFlight = true;
          muteNextModelTurn = true; // Set synchronously to block any immediate follow-up tool calls
          addMessage('bot', `Selecting item #${itemNum} from search results...`);
          chrome.runtime.sendMessage({
            type: 'VOICE_SELECT_SEARCH_ITEM',
            number: itemNum,
          }, (resp) => {
            const result = resp?.data || resp;
            if (result?.status === 'not_found') {
              tryOnInFlight = false;
              muteNextModelTurn = false;
              sendToolResp(call.id, call.name, `Item #${itemNum} is not available — search results have not finished loading yet. Tell the user to wait a moment for results to load before selecting an item.`);
            } else if (result?.status === 'no_tab') {
              tryOnInFlight = false;
              muteNextModelTurn = false;
              sendToolResp(call.id, call.name, 'The search results page is not open yet. Wait for the search to complete before selecting items.');
            } else {
              sendToolResp(call.id, call.name, 'OK. Do NOT speak again until you receive a system notification that the result is visible.');
              // tryOnInFlight cleared when TRYON_COMPLETE arrives
            }
          });
          continue; // async
        }
        case 'try_on_outfit': {
          // Guard: user must have confirmed before trying on
          if (!userSpokeSinceLastModelTurn) {
            console.warn('[Giselle] ⚠️ try_on_outfit blocked — user has not confirmed yet');
            sendToolResp(call.id, call.name, 'WAIT — the user has not confirmed yet. Ask "Would you like to try this outfit on?" and wait for the user to say yes before calling try_on_outfit.');
            continue;
          }
          lastTryOnSource = 'outfit';
          addMessage('bot', 'Starting outfit try-on with all selected items...');
          chrome.runtime.sendMessage({ type: 'VOICE_TRY_ON_OUTFIT' }, (resp) => {
            const result = resp?.data || resp;
            if (result?.status === 'ok') {
              sendToolResp(call.id, call.name, 'OK. Do NOT speak again until you receive a system notification that the result is visible.');
          muteNextModelTurn = true;
            } else {
              sendToolResp(call.id, call.name, result?.error || 'Could not start try-on — make sure at least a top and bottom are selected in the outfit builder.');
            }
          });
          continue; // async
        }
        case 'select_outfit_items': {
          const cat = (data.category || '').toLowerCase().trim();
          const num = parseInt(data.number, 10);
          if (!cat || !num || num < 1) {
            sendToolResp(call.id, call.name, 'Invalid category or number.');
            continue;
          }
          addMessage('bot', `Selecting ${cat} #${num} in outfit builder...`);
          chrome.runtime.sendMessage({
            type: 'VOICE_SELECT_OUTFIT_ITEMS',
            category: cat,
            number: num,
          }, (resp) => {
            const result = resp?.data || resp;
            if (result?.status === 'not_found') {
              sendToolResp(call.id, call.name, `Item ${cat} #${num} is not available yet — the outfit builder is still loading items. Tell the user to wait until items finish loading, then try again.`);
            } else if (result?.status === 'no_tab') {
              sendToolResp(call.id, call.name, 'The outfit builder is not open yet. Wait for it to open and load items first.');
            } else {
              sendToolResp(call.id, call.name, `Selected ${cat} #${num} in the outfit builder. The item is now highlighted.`);
            }
          });
          continue; // async
        }
        default:
          sendToolResp(call.id, call.name, 'Unknown action');
      }
    }
  }
})();
