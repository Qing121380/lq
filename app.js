// 前端解密逻辑：月份 + 姓名 + 密码 -> PBKDF2派生密钥 -> AES-GCM解密 -> 显示图片
// 支持：同月多张工资条（重名）、点击全屏放大（按原图像素渲染，始终清晰）、
//       左右滑动切换多张、iOS 原生分享面板保存（最可靠）、长按/下载兜底。
const ITER = 100000;

let monthsCache = null;

async function loadMonths() {
  if (monthsCache) return monthsCache;
  const resp = await fetch('months.json');
  monthsCache = await resp.json();
  return monthsCache;
}

function getMonthValue() {
  const el = document.getElementById('month');
  if (!el) return '';
  if (el.tagName === 'SELECT') return el.value;
  return el.dataset.value || '';
}

async function initMonths() {
  const el = document.getElementById('month');
  if (!el) return;
  try {
    const months = await loadMonths();
    const keys = Object.keys(months).sort().reverse();
    if (!keys.length) {
      if (el.tagName === 'SELECT') el.innerHTML = '<option>暂无数据</option>';
      else if (el.classList.contains('dropdown')) {
        el.querySelector('.dropdown-trigger span').textContent = '暂无数据';
        el.querySelector('.dropdown-menu').innerHTML = '';
        el.dataset.value = '';
      }
      return;
    }
    if (el.tagName === 'SELECT') {
      el.innerHTML = keys.map(k => `<option value="${k}">${months[k].label}</option>`).join('');
    } else if (el.classList.contains('dropdown')) {
      const menu = el.querySelector('.dropdown-menu');
      const trigger = el.querySelector('.dropdown-trigger span');
      menu.innerHTML = keys.map((k, i) => `<li class="dropdown-item ${i === 0 ? 'active' : ''}" data-value="${k}" data-label="${months[k].label}">${months[k].label}</li>`).join('');
      trigger.textContent = months[keys[0]].label;
      el.dataset.value = keys[0];
      menu.querySelectorAll('.dropdown-item').forEach(item => {
        item.addEventListener('click', () => {
          el.dataset.value = item.dataset.value;
          trigger.textContent = item.dataset.label;
          menu.querySelectorAll('.dropdown-item').forEach(li => li.classList.remove('active'));
          item.classList.add('active');
          el.classList.remove('open');
        });
      });
    }
  } catch (e) {
    if (el.tagName === 'SELECT') el.innerHTML = '<option>加载失败</option>';
    else if (el.classList.contains('dropdown')) {
      el.querySelector('.dropdown-trigger span').textContent = '加载失败';
      el.querySelector('.dropdown-menu').innerHTML = '';
    }
  }
}

function setupDropdown() {
  const el = document.getElementById('month');
  if (!el || !el.classList.contains('dropdown')) return;
  const trigger = el.querySelector('.dropdown-trigger');
  if (trigger) {
    trigger.addEventListener('click', (e) => { e.stopPropagation(); el.classList.toggle('open'); });
  }
  document.addEventListener('click', (e) => {
    if (!el.contains(e.target)) el.classList.remove('open');
  });
}

function showMsg(text, type) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'msg ' + (type || '');
}
function hideMsg() {
  const el = document.getElementById('msg');
  el.className = 'msg';
  el.textContent = '';
}
function hideResult() {
  document.getElementById('result').style.display = 'none';
  document.getElementById('imgList').innerHTML = '';
}

// 将解密后的 RGBA PNG 合成白底，避免透明区域在手机相册/微信中显示异常，
// 同时让"保存"得到的是干净的白底图。返回白底 Blob。
function toWhiteBgBlob(arrayBuffer) {
  return new Promise((resolve) => {
    const raw = new Blob([arrayBuffer], { type: 'image/png' });
    const url = URL.createObjectURL(raw);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        c.toBlob((b) => {
          URL.revokeObjectURL(url);
          resolve(b || raw);
        }, 'image/png');
      } catch (e) {
        URL.revokeObjectURL(url);
        resolve(raw);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(raw); };
    img.src = url;
  });
}

async function decryptFile(encData, password) {
  const data = new Uint8Array(encData);
  const salt = data.slice(0, 16);
  const iv = data.slice(16, 28);
  const tag = data.slice(data.length - 16);
  const ciphertext = data.slice(28, data.length - 16);

  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: ITER, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );

  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, combined);
}

// ---------------- 全屏灯箱（手势缩放 / 拖动 / 滑动切换） ----------------
let currentItems = [];
let lbIndex = 0;
let lbBase = 1, lbScale = 1, lbTx = 0, lbTy = 0;
let lbStartDist = 0, lbStartScale = 1, lbStartX = 0, lbStartY = 0, lbMoveX = 0, lbMoveY = 0;
let lbPinching = false, lbDragging = false;
let lbSwipeX = 0, lbSwipeY = 0, lbLastX = 0, lbLastY = 0;
let lbLastTap = 0;   // 移动端双击检测
let lbSwipeT = 0;    // 单指起始时间（用于判断快速滑动切换）

function applyLbTransform() {
  const img = document.getElementById('lbImg');
  // 工资条是超宽幅：上下不需要移动，纵向永远居中(lbTy=0)，只允许左右拖动
  img.style.transform = `translate(${lbTx}px, 0px) scale(${lbScale})`;
}

// 平滑过渡：双击/缩放到位时用动画；拖动跟手时关闭动画
function setLbSmooth(on) {
  const img = document.getElementById('lbImg');
  img.style.transition = on ? 'transform .22s cubic-bezier(.22,.61,.36,1)' : 'none';
}

// 图片当前显示尺寸是否超出可视区（超出即可左右拖动查看）
function imgOverflows() {
  const imgEl = document.getElementById('lbImg');
  const w = (imgEl.naturalWidth || 0) * lbScale;
  const h = (imgEl.naturalHeight || 0) * lbScale;
  return w > window.innerWidth + 2 || h > window.innerHeight + 2;
}

function computeBase(img) {
  // 按原始像素显示：保证清晰，且在手机/桌面上都明显大于可视区，需要滑动查看
  return 1;
}

function updateLbCount() {
  const el = document.getElementById('lbCount');
  if (currentItems.length > 1) {
    el.textContent = `第 ${lbIndex + 1} / ${currentItems.length} 张（左右滑动切换）`;
    el.style.display = 'block';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

function loadLbImage() {
  const img = document.getElementById('lbImg');
  const it = currentItems[lbIndex];
  lbScale = 1; lbTx = 0; lbTy = 0;
  img.style.transform = 'translate(0,0) scale(1)';
  img.onload = () => {
    lbBase = computeBase(img);
    lbScale = lbBase; lbTx = 0; lbTy = 0;
    setLbSmooth(false);
    applyLbTransform();
    updateLbCount();
  };
  img.src = it.url;
}

function openLightbox(items, idx) {
  currentItems = items;
  lbIndex = idx || 0;
  loadLbImage();
  document.getElementById('lightbox').classList.add('show');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('show');
}

function switchImage(dir) {
  let ni = lbIndex + dir;
  if (ni < 0) ni = 0;
  if (ni >= currentItems.length) ni = currentItems.length - 1;
  if (ni !== lbIndex) { lbIndex = ni; loadLbImage(); }
}

function setupLightbox() {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lbImg');

  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
  document.getElementById('lbClose').addEventListener('click', closeLightbox);

  // 横向拖动边界：图片放大后左右可拖的最大距离
  function clampTx() {
    const imgEl = document.getElementById('lbImg');
    const imgW = (imgEl.naturalWidth || 0) * lbScale;
    const max = Math.max(0, (imgW - window.innerWidth) / 2 + 40);
    if (lbTx > max) lbTx = max;
    if (lbTx < -max) lbTx = -max;
  }

  // 双击/双击放大：原图(1:1) <-> 2.5倍放大 切换（带平滑动画）
  function doZoomToggle() {
    setLbSmooth(true);
    lbScale = (lbScale > lbBase * 1.3) ? lbBase : 2.5;
    lbTx = 0;
    clampTx();
    applyLbTransform();
  }
  img.addEventListener('dblclick', (e) => { e.preventDefault(); doZoomToggle(); });

  img.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      lbPinching = true;
      setLbSmooth(false);
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lbStartDist = Math.hypot(dx, dy);
      lbStartScale = lbScale;
    } else if (e.touches.length === 1) {
      lbDragging = true;
      setLbSmooth(false);
      lbStartX = e.touches[0].clientX; lbStartY = e.touches[0].clientY;
      lbMoveX = lbTx;
      lbSwipeX = lbStartX; lbSwipeY = lbStartY;
      lbLastX = lbStartX; lbLastY = lbStartY;
      lbSwipeT = Date.now();
    }
  }, { passive: false });

  img.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (lbPinching && e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      lbScale = Math.min(4, Math.max(lbBase * 0.8, lbStartScale * dist / lbStartDist));
      clampTx();
      applyLbTransform();
    } else if (lbDragging && e.touches.length === 1) {
      lbLastX = e.touches[0].clientX; lbLastY = e.touches[0].clientY;
      // 图片超出屏幕（含原图大小）即可跟手左右拖动；上下锁定
      if (imgOverflows()) {
        lbTx = lbMoveX + (lbLastX - lbStartX);
        clampTx();
        applyLbTransform();
      }
    }
  }, { passive: false });

  img.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) lbPinching = false;
    if (e.touches.length === 0) {
      lbDragging = false;
      const dx = lbLastX - lbSwipeX;
      const dy = lbLastY - lbSwipeY;
      const moved = Math.abs(dx) + Math.abs(dy);

      // 双击检测：两次轻点间隔<300ms 且几乎没移动 → 放大/还原
      const now = Date.now();
      if (moved < 12) {
        if (now - lbLastTap < 300) {
          doZoomToggle();
          lbLastTap = 0;
          return;
        }
        lbLastTap = now;
      } else {
        lbLastTap = 0;
      }

      // 图片完整显示（未超出屏幕）时，左右滑动切换多张；超出屏幕时仅快速横扫才切换
      if (currentItems.length > 1) {
        const dt = now - lbSwipeT;
        const fast = dt > 0 && Math.abs(dx) / dt > 0.4;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && (!imgOverflows() || fast)) {
          switchImage(dx < 0 ? 1 : -1);
        }
      }
    }
  });
}

// iOS 原生分享面板保存（最可靠）；不支持时回退下载，并提示长按
async function saveImage(blob, idx) {
  const fn = `工资条${currentItems.length > 1 ? '_' + (idx + 1) : ''}.png`;
  const file = new File([blob], fn, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '我的工资条' });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  const u = URL.createObjectURL(blob);
  a.href = u; a.download = fn;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 4000);
  showMsg('已尝试下载；若无效，请长按图片选择「存储到照片」，或用手机浏览器打开本页保存。', 'info');
}

async function doQuery() {
  hideMsg();
  hideResult();

  const month = getMonthValue();
  const name = document.getElementById('name').value.trim();
  const code = document.getElementById('code').value.trim();
  if (!month || !name || !code) {
    showMsg('请选择月份，并输入姓名和密码', 'error');
    return;
  }

  const btn = document.getElementById('btn');
  btn.disabled = true;
  btn.textContent = '查询中...';

  try {
    const respM = await fetch(`months/${month}/manifest.json`);
    if (!respM.ok) throw new Error('该月份数据不存在');
    const m = await respM.json();
    const entry = m[name];
    if (!entry) {
      showMsg('未找到该员工（本月可能未在职或姓名有误）', 'error');
      return;
    }

    const list = Array.isArray(entry) ? entry : [entry];
    showMsg('正在解密...', 'info');

    const items = [];
    for (const e of list) {
      const resp = await fetch(`months/${month}/${e.file}`);
      if (!resp.ok) throw new Error('文件获取失败');
      const encData = await resp.arrayBuffer();
      let decrypted;
      try {
        decrypted = await decryptFile(encData, code);
      } catch (err) {
        showMsg('密码错误，请重新输入', 'error');
        return;
      }
      const white = await toWhiteBgBlob(decrypted);
      items.push({ url: URL.createObjectURL(white), blob: white, type: e.type });
    }

    renderItems(items);
  } catch (e) {
    showMsg('查询失败，请稍后重试', 'error');
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = '查 询';
  }
}

function renderItems(items) {
  const list = document.getElementById('imgList');
  const tip = document.getElementById('multiTip');
  list.innerHTML = '';

  if (items.length > 1) {
    tip.style.display = 'block';
    tip.textContent = `本月共 ${items.length} 张工资条，均已按原图大小显示（可滑动查看，点图进入全屏，多张可左右滑动）：`;
  } else {
    tip.style.display = 'none';
  }

  items.forEach((it, idx) => {
    const card = document.createElement('div');
    card.className = 'img-card';

    if (items.length > 1) {
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = `第 ${idx + 1} 张 / 共 ${items.length} 张`;
      card.appendChild(cap);
    }

    const scroll = document.createElement('div');
    scroll.className = 'img-scroll';
    const img = document.createElement('img');
    img.src = it.url;
    img.alt = '工资条';
    img.addEventListener('click', () => openLightbox(items, idx));
    scroll.appendChild(img);
    card.appendChild(scroll);

    if (it.type !== 'pdf') {
      const a = document.createElement('a');
      a.className = 'save-link';
      a.textContent = '保存到相册';
      a.addEventListener('click', (ev) => { ev.preventDefault(); saveImage(it.blob, idx); });
      card.appendChild(a);
    }

    list.appendChild(card);
  });

  document.getElementById('result').style.display = 'block';
  hideMsg();
}

// 回车提交
document.getElementById('code').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') doQuery();
});
document.getElementById('name').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('code').focus();
});

setupLightbox();
setupDropdown();
initMonths();
