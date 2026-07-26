/**
 * manager.js
 * 一鍵精靈 OneClick Wizard - 管理視窗主邏輯
 */

var ocwData = null;              // 目前記憶體中的資料快照
var ocwEditingSiteId = null;      // 目前正在編輯的網站 id（null = 新增）
var ocwEditingGroupId = null;     // 目前正在編輯的群組 id（null = 新增）
var ocwSelectedGroupColor = 'blue';
var ocwDragPayload = null;        // 拖曳中的資料 { type: 'site'|'group', id, fromGroupId }
var ocwConfirmCallback = null;
var ocwSelectedSiteIds = new Set(); // 目前勾選（用於批次刪除）的網站 id

// -----------------------------------------------------------------------
// 初始化
// -----------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', init);

async function init() {
  ocwData = await ocwGetData();
  renderPaletteSwitch();
  applyPalette(ocwData.settings.palette || 'peach');
  bindStaticEvents();
  renderColorGrid();
  renderAll();
  watchWindowBounds();
}

// -----------------------------------------------------------------------
// 馬卡龍配色切換
// -----------------------------------------------------------------------
function renderPaletteSwitch() {
  var container = document.getElementById('paletteSwitch');
  container.innerHTML = OCW_PALETTES.map(function (p) {
    return '<button class="ocw-palette-btn" data-palette-value="' + p.key + '" style="--swatch:' + p.swatch + '" title="' + escapeAttr(p.label) + '">' +
      '<span class="ocw-palette-dot"></span>' +
      '</button>';
  }).join('');
  container.querySelectorAll('.ocw-palette-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { setPalette(btn.dataset.paletteValue); });
  });
}

function applyPalette(key) {
  document.documentElement.setAttribute('data-palette', key);
  document.querySelectorAll('.ocw-palette-btn').forEach(function (btn) {
    btn.classList.toggle('ocw-active', btn.dataset.paletteValue === key);
  });
}

async function setPalette(key) {
  ocwData.settings.palette = key;
  applyPalette(key);
  await ocwSetData(ocwData);
}

// -----------------------------------------------------------------------
// 視窗大小/位置記憶
// -----------------------------------------------------------------------
function watchWindowBounds() {
  var saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async function () {
      ocwData.settings.windowBounds = {
        width: window.outerWidth,
        height: window.outerHeight,
        left: window.screenX,
        top: window.screenY
      };
      await ocwSetData(ocwData);
    }, 400);
  }
  window.addEventListener('resize', scheduleSave);
  window.addEventListener('beforeunload', function () {
    ocwData.settings.windowBounds = {
      width: window.outerWidth,
      height: window.outerHeight,
      left: window.screenX,
      top: window.screenY
    };
    // 同步寫入，盡量在關閉前完成
    var obj = {}; obj['oneclickWizardData'] = ocwData;
    chrome.storage.local.set(obj);
  });
}

// -----------------------------------------------------------------------
// 靜態事件綁定
// -----------------------------------------------------------------------
function bindStaticEvents() {
  document.getElementById('btnAddSite').addEventListener('click', function () { openSiteModal(null, null); });
  document.getElementById('siteUseDefault').addEventListener('change', updateSiteCredentialFieldsState);
  document.getElementById('btnAddGroup').addEventListener('click', function () { openGroupModal(null); });
  document.getElementById('btnBulkImport').addEventListener('click', openBulkModal);
  document.getElementById('btnDefaultAccount').addEventListener('click', openDefaultAccountModal);
  document.getElementById('btnDataIO').addEventListener('click', function () {
    show('dataModalBackdrop');
  });

  document.getElementById('btnOpenAll').addEventListener('click', function () {
    var ids = ocwData.sites.map(function (s) { return s.id; });
    requestOpenSites(ids, '全部網站');
  });
  document.getElementById('btnLogoutAll').addEventListener('click', function () {
    confirmAction('一鍵登出全部', '確定要登出全部 ' + ocwData.sites.length + ' 個網站嗎？', function () {
      var ids = ocwData.sites.map(function (s) { return s.id; });
      requestLogoutSites(ids, '全部網站');
    });
  });

  document.getElementById('btnSaveSite').addEventListener('click', saveSiteFromModal);
  document.getElementById('btnSaveGroup').addEventListener('click', saveGroupFromModal);
  document.getElementById('btnBulkImportConfirm').addEventListener('click', confirmBulkImport);
  document.getElementById('btnSaveDefaultAccount').addEventListener('click', saveDefaultAccount);
  document.getElementById('btnApplyDefaultToAll').addEventListener('click', applyDefaultAccountToAllSites);
  document.getElementById('selectAllCheckbox').addEventListener('change', function (e) {
    if (e.target.checked) {
      ocwData.sites.forEach(function (s) { ocwSelectedSiteIds.add(s.id); });
    } else {
      ocwSelectedSiteIds.clear();
    }
    renderAll();
  });
  document.getElementById('btnBulkClearSelection').addEventListener('click', function () {
    ocwSelectedSiteIds.clear();
    renderAll();
  });
  document.getElementById('btnBulkDeleteSelected').addEventListener('click', function () {
    var count = ocwSelectedSiteIds.size;
    if (!count) return;
    confirmAction('刪除已選取的網站', '確定要刪除已選取的 ' + count + ' 個網站嗎？此動作無法復原。', async function () {
      ocwData.sites = ocwData.sites.filter(function (s) { return !ocwSelectedSiteIds.has(s.id); });
      ocwSelectedSiteIds.clear();
      await ocwSetData(ocwData);
      renderAll();
      toast('已刪除選取的網站', 'success');
    });
  });
  document.getElementById('btnExportData').addEventListener('click', exportData);
  document.getElementById('btnImportConfirm').addEventListener('click', importData);
  document.getElementById('btnConfirmYes').addEventListener('click', function () {
    if (typeof ocwConfirmCallback === 'function') ocwConfirmCallback();
    hide('confirmModalBackdrop');
  });

  document.querySelectorAll('[data-close-modal]').forEach(function (el) {
    el.addEventListener('click', function () { hide(el.dataset.closeModal); });
  });
  document.querySelectorAll('.ocw-modal-backdrop').forEach(function (backdrop) {
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) hide(backdrop.id);
    });
  });

  // 未分組容器也要能接收拖放（僅限網站，群組拖曳不處理）
  var ungrouped = document.getElementById('ungroupedContainer');
  ungrouped.addEventListener('dragover', function (e) {
    if (!isSitePayload(ocwDragPayload)) return;
    e.preventDefault();
    ungrouped.parentElement.classList.add('ocw-drag-over');
  });
  ungrouped.addEventListener('dragleave', function () {
    ungrouped.parentElement.classList.remove('ocw-drag-over');
  });
  ungrouped.addEventListener('drop', function (e) {
    e.preventDefault();
    ungrouped.parentElement.classList.remove('ocw-drag-over');
    if (!isSitePayload(ocwDragPayload)) return;
    handleSiteDrop(null, ungrouped, e);
    ocwDragPayload = null;
  });
}

function show(id) { document.getElementById(id).classList.remove('ocw-hidden'); }
function hide(id) { document.getElementById(id).classList.add('ocw-hidden'); }

function confirmAction(title, desc, callback) {
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalDesc').textContent = desc;
  ocwConfirmCallback = callback;
  show('confirmModalBackdrop');
}

// -----------------------------------------------------------------------
// Toast
// -----------------------------------------------------------------------
function toast(msg, type) {
  var stack = document.getElementById('toastStack');
  var el = document.createElement('div');
  el.className = 'ocw-toast' + (type ? ' ocw-toast-' + type : '');
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(function () {
    el.remove();
  }, 3200);
}

// -----------------------------------------------------------------------
// 渲染
// -----------------------------------------------------------------------
function renderAll() {
  // 清除已不存在的網站 id，避免選取狀態殘留
  var validIds = {};
  ocwData.sites.forEach(function (s) { validIds[s.id] = true; });
  ocwSelectedSiteIds.forEach(function (id) { if (!validIds[id]) ocwSelectedSiteIds.delete(id); });

  renderGroupSelects();
  renderGroupsContainer();
  renderUngrouped();
  var total = ocwData.sites.length;
  document.getElementById('siteCountBadge').textContent = '共 ' + total + ' 個網站';
  document.getElementById('emptyState').classList.toggle('ocw-hidden', total > 0 || ocwData.groups.length > 0);
  updateBulkBar();
}

function updateBulkBar() {
  var bar = document.getElementById('bulkActionBar');
  var count = ocwSelectedSiteIds.size;
  document.getElementById('bulkSelectedCount').textContent = '已選取 ' + count + ' 個網站';
  bar.classList.toggle('ocw-hidden', count === 0);
  var selectAllCb = document.getElementById('selectAllCheckbox');
  selectAllCb.checked = ocwData.sites.length > 0 && count === ocwData.sites.length;
}

function renderGroupSelects() {
  ['siteGroup', 'bulkGroup'].forEach(function (selId) {
    var sel = document.getElementById(selId);
    var current = sel.value;
    sel.innerHTML = '<option value="">未分組</option>' +
      ocwData.groups.slice().sort(byOrder).map(function (g) {
        return '<option value="' + escapeAttr(g.id) + '">' + escapeHtml(g.name) + '</option>';
      }).join('');
    if (current) sel.value = current;
  });
}

function byOrder(a, b) { return (a.order || 0) - (b.order || 0); }

function sitesInGroup(groupId) {
  return ocwData.sites.filter(function (s) { return (s.groupId || null) === groupId; }).sort(byOrder);
}

function renderGroupsContainer() {
  var container = document.getElementById('groupsContainer');
  container.innerHTML = '';
  var groups = ocwData.groups.slice().sort(byOrder);
  groups.forEach(function (group) {
    container.appendChild(buildGroupNode(group));
  });
}

function renderUngrouped() {
  var container = document.getElementById('ungroupedContainer');
  container.innerHTML = '';
  var sites = sitesInGroup(null);
  if (sites.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'ocw-group-empty';
    empty.textContent = '把網站拖到這裡即可移出群組';
    container.appendChild(empty);
    return;
  }
  sites.forEach(function (site) {
    container.appendChild(buildSiteNode(site, null));
  });
}

function colorHex(colorKey) {
  var found = OCW_TAB_GROUP_COLORS.filter(function (c) { return c.key === colorKey; })[0];
  return found ? found.hex : '#9aa0a6';
}

function buildGroupNode(group) {
  var wrap = document.createElement('div');
  wrap.className = 'ocw-group';
  wrap.dataset.groupId = group.id;

  var header = document.createElement('div');
  header.className = 'ocw-group-header';
  header.draggable = true;

  var sites = sitesInGroup(group.id);

  header.innerHTML =
    '<span class="ocw-site-handle">⠿</span>' +
    '<span class="ocw-group-dot" style="background:' + colorHex(group.color) + '"></span>' +
    '<span class="ocw-group-name">' + escapeHtml(group.name) + '</span>' +
    '<span class="ocw-group-count">' + sites.length + ' 個網站</span>' +
    '<button class="ocw-btn ocw-btn-sm ocw-btn-primary" data-act="open">開啟</button>' +
    '<button class="ocw-btn ocw-btn-sm ocw-btn-danger" data-act="logout">登出</button>' +
    '<button class="ocw-btn ocw-btn-sm" data-act="edit">編輯</button>' +
    '<button class="ocw-btn ocw-btn-sm" data-act="delete">刪除</button>' +
    '<button class="ocw-collapse-btn" data-act="collapse">' + (group.collapsed ? '▸' : '▾') + '</button>';

  header.querySelector('[data-act="open"]').addEventListener('click', function (e) {
    e.stopPropagation();
    var ids = sites.map(function (s) { return s.id; });
    if (!ids.length) { toast('這個群組還沒有網站', 'error'); return; }
    requestOpenSites(ids, group.name);
  });
  header.querySelector('[data-act="logout"]').addEventListener('click', function (e) {
    e.stopPropagation();
    var ids = sites.map(function (s) { return s.id; });
    if (!ids.length) { toast('這個群組還沒有網站', 'error'); return; }
    confirmAction('登出群組', '確定要登出「' + group.name + '」群組內所有網站嗎？', function () {
      requestLogoutSites(ids, group.name);
    });
  });
  header.querySelector('[data-act="edit"]').addEventListener('click', function (e) {
    e.stopPropagation();
    openGroupModal(group);
  });
  header.querySelector('[data-act="delete"]').addEventListener('click', function (e) {
    e.stopPropagation();
    confirmAction('刪除群組', '刪除群組「' + group.name + '」不會刪除其中的網站，網站將移至未分組。確定刪除嗎？', async function () {
      ocwData.groups = ocwData.groups.filter(function (g) { return g.id !== group.id; });
      ocwData.sites.forEach(function (s) { if (s.groupId === group.id) s.groupId = null; });
      await ocwSetData(ocwData);
      renderAll();
      toast('已刪除群組', 'success');
    });
  });
  header.querySelector('[data-act="collapse"]').addEventListener('click', async function (e) {
    e.stopPropagation();
    group.collapsed = !group.collapsed;
    await ocwSetData(ocwData);
    renderAll();
  });

  // 群組拖曳排序
  header.addEventListener('dragstart', function (e) {
    ocwDragPayload = { type: 'group', id: group.id };
    e.dataTransfer.effectAllowed = 'move';
  });
  wrap.addEventListener('dragover', function (e) {
    if (!ocwDragPayload) return;
    e.preventDefault();
    wrap.classList.add('ocw-drag-over');
  });
  wrap.addEventListener('dragleave', function () { wrap.classList.remove('ocw-drag-over'); });
  wrap.addEventListener('drop', function (e) {
    e.preventDefault();
    wrap.classList.remove('ocw-drag-over');
    if (!ocwDragPayload) return;
    if (ocwDragPayload.type === 'group') {
      reorderGroups(ocwDragPayload.id, group.id);
    } else if (isSitePayload(ocwDragPayload)) {
      handleSiteDrop(group.id, body, e, null);
    }
    ocwDragPayload = null;
  });

  var body = document.createElement('div');
  body.className = 'ocw-group-body' + (group.collapsed ? ' ocw-collapsed' : '');
  body.addEventListener('dragover', function (e) {
    if (isSitePayload(ocwDragPayload)) e.preventDefault();
  });
  body.addEventListener('drop', function (e) {
    e.preventDefault();
    if (!isSitePayload(ocwDragPayload)) return;
    handleSiteDrop(group.id, body, e);
    ocwDragPayload = null;
  });

  if (sites.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'ocw-group-empty';
    empty.textContent = '把網站拖到這裡加入此群組';
    body.appendChild(empty);
  } else {
    sites.forEach(function (site) { body.appendChild(buildSiteNode(site, group.id)); });
  }

  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}

function buildSiteNode(site, groupId) {
  var row = document.createElement('div');
  row.className = 'ocw-site';
  row.draggable = true;
  row.dataset.siteId = site.id;

  var backupCount = Array.isArray(site.backupUrls) ? site.backupUrls.length : 0;
  var backupBadge = backupCount > 0
    ? '<span class="ocw-badge" title="共 ' + (backupCount + 1) + ' 個可用網址，開啟時隨機擇一">🔀 ' + backupCount + ' 備用</span>'
    : '';

  row.innerHTML =
    '<input type="checkbox" class="ocw-site-checkbox" draggable="false" />' +
    '<span class="ocw-site-handle">⠿</span>' +
    '<div class="ocw-site-info">' +
      '<div class="ocw-site-name">' + escapeHtml(site.name || '(未命名)') + '</div>' +
      '<div class="ocw-site-url">' + escapeHtml(site.url) + '</div>' +
    '</div>' +
    backupBadge +
    '<div class="ocw-site-actions">' +
      '<button class="ocw-btn ocw-btn-sm ocw-btn-primary" data-act="open">開啟</button>' +
      '<button class="ocw-btn ocw-btn-sm ocw-btn-danger" data-act="logout">登出</button>' +
      '<button class="ocw-btn ocw-btn-sm" data-act="edit">編輯</button>' +
      '<button class="ocw-btn ocw-btn-sm" data-act="delete">刪除</button>' +
    '</div>';

  var checkbox = row.querySelector('.ocw-site-checkbox');
  checkbox.checked = ocwSelectedSiteIds.has(site.id);
  checkbox.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  checkbox.addEventListener('change', function () {
    if (checkbox.checked) ocwSelectedSiteIds.add(site.id);
    else ocwSelectedSiteIds.delete(site.id);
    updateBulkBar();
  });

  row.querySelector('[data-act="open"]').addEventListener('click', function () {
    requestOpenSites([site.id], site.name);
  });
  row.querySelector('[data-act="logout"]').addEventListener('click', function () {
    confirmAction('登出網站', '確定要登出「' + site.name + '」嗎？', function () {
      requestLogoutSites([site.id], site.name);
    });
  });
  row.querySelector('[data-act="edit"]').addEventListener('click', function () {
    openSiteModal(site, groupId);
  });
  row.querySelector('[data-act="delete"]').addEventListener('click', function () {
    confirmAction('刪除網站', '確定要刪除「' + site.name + '」嗎？此動作無法復原。', async function () {
      ocwData.sites = ocwData.sites.filter(function (s) { return s.id !== site.id; });
      ocwSelectedSiteIds.delete(site.id);
      await ocwSetData(ocwData);
      renderAll();
      toast('已刪除網站', 'success');
    });
  });

  row.addEventListener('dragstart', function (e) {
    if (ocwSelectedSiteIds.has(site.id) && ocwSelectedSiteIds.size > 1) {
      // 若目前拖曳的網站在多選之中，整批已勾選的網站一起移動
      ocwDragPayload = { type: 'site-multi', ids: Array.from(ocwSelectedSiteIds) };
    } else {
      ocwDragPayload = { type: 'site', id: site.id, fromGroupId: groupId };
    }
    row.classList.add('ocw-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
  });
  row.addEventListener('dragend', function () { row.classList.remove('ocw-dragging'); });
  row.addEventListener('dragover', function (e) {
    if (isSitePayload(ocwDragPayload)) {
      e.preventDefault();
      e.stopPropagation();
      row.classList.add('ocw-drag-over');
    }
  });
  row.addEventListener('dragleave', function () { row.classList.remove('ocw-drag-over'); });
  row.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('ocw-drag-over');
    if (!isSitePayload(ocwDragPayload)) return;
    handleSiteDrop(groupId, row.parentElement, e, site.id);
    ocwDragPayload = null;
  });

  return row;
}

// -----------------------------------------------------------------------
// 拖曳邏輯
// -----------------------------------------------------------------------
async function reorderGroups(draggedId, targetId) {
  if (draggedId === targetId) return;
  var groups = ocwData.groups.slice().sort(byOrder);
  var draggedIdx = groups.findIndex(function (g) { return g.id === draggedId; });
  var targetIdx = groups.findIndex(function (g) { return g.id === targetId; });
  if (draggedIdx === -1 || targetIdx === -1) return;
  var moved = groups.splice(draggedIdx, 1)[0];
  groups.splice(targetIdx, 0, moved);
  groups.forEach(function (g, i) { g.order = i; });
  ocwData.groups = groups;
  await ocwSetData(ocwData);
  renderAll();
}

function isSitePayload(payload) {
  return !!payload && (payload.type === 'site' || payload.type === 'site-multi');
}

async function handleSiteDrop(targetGroupId, containerEl, event, beforeSiteId) {
  if (!isSitePayload(ocwDragPayload)) return;

  var movingIds = ocwDragPayload.type === 'site-multi' ? ocwDragPayload.ids : [ocwDragPayload.id];
  var movingSet = {};
  movingIds.forEach(function (id) { movingSet[id] = true; });

  // 依原本在 ocwData.sites 中的順序取出要搬移的網站，維持彼此的相對順序
  var movingSites = ocwData.sites.filter(function (s) { return movingSet[s.id]; });
  if (!movingSites.length) return;

  movingSites.forEach(function (s) { s.groupId = targetGroupId; });

  var siblings = sitesInGroup(targetGroupId).filter(function (s) { return !movingSet[s.id]; });
  var insertAt = siblings.length;
  if (beforeSiteId && !movingSet[beforeSiteId]) {
    var idx = siblings.findIndex(function (s) { return s.id === beforeSiteId; });
    if (idx !== -1) insertAt = idx;
  }
  var newList = siblings.slice(0, insertAt).concat(movingSites, siblings.slice(insertAt));
  newList.forEach(function (s, i) { s.order = i; });

  await ocwSetData(ocwData);
  renderAll();
  if (movingSites.length > 1) toast('已移動 ' + movingSites.length + ' 個網站', 'success');
}

// -----------------------------------------------------------------------
// 開啟 / 登出（呼叫 background.js）
// -----------------------------------------------------------------------
function requestOpenSites(siteIds, label) {
  chrome.runtime.sendMessage({ type: 'OCW_OPEN_SITES', siteIds: siteIds }, function (resp) {
    if (resp && resp.ok) {
      toast('已開啟「' + label + '」，共 ' + resp.result.openedTabs + ' 個分頁', 'success');
    } else {
      toast('開啟失敗：' + (resp && resp.error || '未知錯誤'), 'error');
    }
  });
}

function requestLogoutSites(siteIds, label) {
  toast('正在登出「' + label + '」…');
  chrome.runtime.sendMessage({ type: 'OCW_LOGOUT_SITES', siteIds: siteIds }, function (resp) {
    if (resp && resp.ok) {
      var failCount = resp.result.filter(function (r) { return !r.ok; }).length;
      if (failCount > 0) {
        toast('登出完成，但有 ' + failCount + ' 個網站發生錯誤', 'error');
      } else {
        toast('已登出「' + label + '」', 'success');
      }
    } else {
      toast('登出失敗：' + (resp && resp.error || '未知錯誤'), 'error');
    }
  });
}

// -----------------------------------------------------------------------
// 網站 Modal
// -----------------------------------------------------------------------
function openSiteModal(site, groupId) {
  ocwEditingSiteId = site ? site.id : null;
  document.getElementById('siteModalTitle').textContent = site ? '✏️ 編輯網站' : '🌐 新增網站';
  document.getElementById('siteName').value = site ? site.name : '';
  document.getElementById('siteUrl').value = site ? site.url : '';
  document.getElementById('siteBackupUrls').value = site && Array.isArray(site.backupUrls) ? site.backupUrls.join('\n') : '';
  document.getElementById('siteGroup').value = site ? (site.groupId || '') : (groupId || '');
  document.getElementById('siteUseDefault').checked = site ? !!site.useDefaultAccount : false;
  document.getElementById('siteUsername').value = site ? site.username : '';
  document.getElementById('sitePassword').value = site ? site.password : '';
  document.getElementById('siteLogoutUrl').value = site ? (site.logoutUrl || '') : '';
  document.getElementById('siteLogoutSelector').value = site ? (site.logoutSelector || '') : '';
  updateSiteCredentialFieldsState();
  show('siteModalBackdrop');
}

/** 勾選「套用預設帳號密碼」時，鎖定並提示個別帳密欄位改用預設值；
 *  未勾選但欄位留空時，也會提示將自動套用預設帳密（見 storage.js 的 ocwResolveCredential）。 */
function updateSiteCredentialFieldsState() {
  var useDefault = document.getElementById('siteUseDefault').checked;
  var userEl = document.getElementById('siteUsername');
  var passEl = document.getElementById('sitePassword');
  userEl.disabled = useDefault;
  passEl.disabled = useDefault;
  var defaultAccount = (ocwData && ocwData.settings.defaultAccount) || { username: '', password: '' };
  userEl.placeholder = useDefault
    ? ('將使用預設帳號：' + (defaultAccount.username || '(尚未設定)'))
    : '帳號 / Email（留空將自動使用預設帳密）';
  passEl.placeholder = useDefault ? '將使用預設密碼' : '密碼（留空將自動使用預設帳密）';
}

async function saveSiteFromModal() {
  var name = document.getElementById('siteName').value.trim();
  var url = document.getElementById('siteUrl').value.trim();
  if (!name || !url) { toast('請填寫網站名稱與網址', 'error'); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  var backupUrls = document.getElementById('siteBackupUrls').value
    .split('\n')
    .map(function (l) { return l.trim(); })
    .filter(Boolean)
    .map(function (u) { return /^https?:\/\//i.test(u) ? u : 'https://' + u; });

  var payload = {
    name: name,
    url: url,
    backupUrls: backupUrls,
    groupId: document.getElementById('siteGroup').value || null,
    useDefaultAccount: document.getElementById('siteUseDefault').checked,
    username: document.getElementById('siteUsername').value,
    password: document.getElementById('sitePassword').value,
    logoutUrl: document.getElementById('siteLogoutUrl').value.trim(),
    logoutSelector: document.getElementById('siteLogoutSelector').value.trim()
  };

  if (ocwEditingSiteId) {
    var existing = ocwData.sites.filter(function (s) { return s.id === ocwEditingSiteId; })[0];
    Object.assign(existing, payload);
  } else {
    var groupSiteCount = sitesInGroup(payload.groupId).length;
    payload.id = ocwGenerateId('site');
    payload.order = groupSiteCount;
    ocwData.sites.push(payload);
  }
  await ocwSetData(ocwData);
  hide('siteModalBackdrop');
  renderAll();
  toast('已儲存網站設定', 'success');
}

// -----------------------------------------------------------------------
// 群組 Modal
// -----------------------------------------------------------------------
function renderColorGrid() {
  var grid = document.getElementById('groupColorGrid');
  grid.innerHTML = OCW_TAB_GROUP_COLORS.map(function (c) {
    return '<div class="ocw-color-swatch" data-color="' + c.key + '" style="background:' + c.hex + '" title="' + c.label + '"></div>';
  }).join('');
  grid.querySelectorAll('.ocw-color-swatch').forEach(function (el) {
    el.addEventListener('click', function () {
      ocwSelectedGroupColor = el.dataset.color;
      grid.querySelectorAll('.ocw-color-swatch').forEach(function (s) { s.classList.remove('ocw-selected'); });
      el.classList.add('ocw-selected');
    });
  });
}

function openGroupModal(group) {
  ocwEditingGroupId = group ? group.id : null;
  document.getElementById('groupModalTitle').textContent = group ? '✏️ 編輯群組' : '📁 新增群組';
  document.getElementById('groupName').value = group ? group.name : '';
  ocwSelectedGroupColor = group ? group.color : OCW_TAB_GROUP_COLORS[Math.floor(Math.random() * OCW_TAB_GROUP_COLORS.length)].key;
  document.querySelectorAll('.ocw-color-swatch').forEach(function (el) {
    el.classList.toggle('ocw-selected', el.dataset.color === ocwSelectedGroupColor);
  });
  show('groupModalBackdrop');
}

async function saveGroupFromModal() {
  var name = document.getElementById('groupName').value.trim();
  if (!name) { toast('請輸入群組名稱', 'error'); return; }

  if (ocwEditingGroupId) {
    var existing = ocwData.groups.filter(function (g) { return g.id === ocwEditingGroupId; })[0];
    existing.name = name;
    existing.color = ocwSelectedGroupColor;
  } else {
    ocwData.groups.push({
      id: ocwGenerateId('group'),
      name: name,
      color: ocwSelectedGroupColor,
      collapsed: false,
      order: ocwData.groups.length
    });
  }
  await ocwSetData(ocwData);
  hide('groupModalBackdrop');
  renderAll();
  toast('已儲存群組', 'success');
}

// -----------------------------------------------------------------------
// 批量貼上網址
// -----------------------------------------------------------------------
function openBulkModal() {
  document.getElementById('bulkUrls').value = '';
  document.getElementById('bulkGroup').value = '';
  show('bulkModalBackdrop');
}

async function confirmBulkImport() {
  var raw = document.getElementById('bulkUrls').value;
  var groupId = document.getElementById('bulkGroup').value || null;
  var lines = raw.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  if (!lines.length) { toast('請至少貼上一個網址', 'error'); return; }

  var startOrder = sitesInGroup(groupId).length;
  var added = 0;
  lines.forEach(function (line) {
    var url = line;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    var host = ocwGetHostname(url);
    if (!host) return;
    ocwData.sites.push({
      id: ocwGenerateId('site'),
      name: host,
      url: url,
      backupUrls: [],
      groupId: groupId,
      useDefaultAccount: false,
      username: '',
      password: '',
      logoutUrl: '',
      logoutSelector: '',
      order: startOrder + added
    });
    added++;
  });

  await ocwSetData(ocwData);
  hide('bulkModalBackdrop');
  renderAll();
  toast('已新增 ' + added + ' 個網站', 'success');
}

// -----------------------------------------------------------------------
// 預設帳號密碼
// -----------------------------------------------------------------------
function openDefaultAccountModal() {
  document.getElementById('defaultUsername').value = ocwData.settings.defaultAccount.username || '';
  document.getElementById('defaultPassword').value = ocwData.settings.defaultAccount.password || '';
  show('defaultAccountModalBackdrop');
}

async function saveDefaultAccount() {
  ocwData.settings.defaultAccount = {
    username: document.getElementById('defaultUsername').value,
    password: document.getElementById('defaultPassword').value
  };
  await ocwSetData(ocwData);
  hide('defaultAccountModalBackdrop');
  toast('已更新預設帳號密碼', 'success');
}

async function applyDefaultAccountToAllSites() {
  ocwData.settings.defaultAccount = {
    username: document.getElementById('defaultUsername').value,
    password: document.getElementById('defaultPassword').value
  };
  ocwData.sites.forEach(function (s) { s.useDefaultAccount = true; });
  await ocwSetData(ocwData);
  hide('defaultAccountModalBackdrop');
  renderAll();
  toast('已將預設帳號密碼套用到全部 ' + ocwData.sites.length + ' 個網站', 'success');
}

// -----------------------------------------------------------------------
// 匯出 / 匯入
// -----------------------------------------------------------------------
function exportData() {
  var blob = new Blob([JSON.stringify(ocwData, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = 'oneclick-wizard-backup-' + stamp + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('已匯出備份檔', 'success');
}

async function importData() {
  var fileInput = document.getElementById('importFileInput');
  var mode = document.getElementById('importMode').value;
  var file = fileInput.files[0];
  if (!file) { toast('請先選擇 JSON 檔案', 'error'); return; }

  try {
    var text = await file.text();
    var parsed = ocwNormalizeData(JSON.parse(text));

    if (mode === 'overwrite') {
      ocwData = parsed;
    } else {
      // 合併模式：群組與網站以 id 去重後合併，設定值以匯入檔優先補齊缺項
      var existingGroupIds = {};
      ocwData.groups.forEach(function (g) { existingGroupIds[g.id] = true; });
      parsed.groups.forEach(function (g) {
        if (!existingGroupIds[g.id]) ocwData.groups.push(g);
      });

      var existingSiteIds = {};
      ocwData.sites.forEach(function (s) { existingSiteIds[s.id] = true; });
      parsed.sites.forEach(function (s) {
        if (!existingSiteIds[s.id]) ocwData.sites.push(s);
      });

      if (!ocwData.settings.defaultAccount.username && !ocwData.settings.defaultAccount.password) {
        ocwData.settings.defaultAccount = parsed.settings.defaultAccount;
      }
    }

    await ocwSetData(ocwData);
    renderAll();
    applyPalette(ocwData.settings.palette || 'peach');
    fileInput.value = '';
    hide('dataModalBackdrop');
    toast('資料匯入完成', 'success');
  } catch (e) {
    toast('匯入失敗：檔案格式錯誤', 'error');
  }
}

// -----------------------------------------------------------------------
// 工具函式
// -----------------------------------------------------------------------
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function escapeAttr(str) { return escapeHtml(str); }
