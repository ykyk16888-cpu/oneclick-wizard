/**
 * storage.js
 * 一鍵精靈 OneClick Wizard - 共用資料存取模組
 *
 * 這支檔案會被 background.js（透過 importScripts）、popup.html、manager.html
 * 以及 content.js（透過 content_scripts 陣列一起載入）共用，
 * 因此只使用最基本的 var/function 寫法，避免 ES Module 相容性問題。
 *
 * ---------------------------------------------------------------------------
 * 資料結構（儲存在 chrome.storage.local）：
 *
 * {
 *   meta: { version: 1 },
 *   settings: {
 *     theme: 'system',            // 'light' | 'dark' | 'system'
 *     defaultAccount: { username: '', password: '' },
 *     windowBounds: { width, height, left, top }  // 管理視窗的大小與位置
 *   },
 *   groups: [
 *     { id, name, color, collapsed, order }
 *   ],
 *   sites: [
 *     {
 *       id, groupId,              // groupId 為 null 表示未分組
 *       name, url,
 *       backupUrls,               // string[]，備用網址清單；一鍵開啟時會與 url 一起隨機擇一使用
 *       username, password,
 *       useDefaultAccount,        // boolean，是否套用預設帳號密碼
 *       logoutUrl,                // 自訂登出網址（可為空字串）
 *       logoutSelector,           // 自訂登出按鈕 CSS 選擇器（可為空字串）
 *       order
 *     }
 *   ]
 * }
 * ---------------------------------------------------------------------------
 */

var OCW_STORAGE_KEY = 'oneclickWizardData';

var OCW_DEFAULT_DATA = {
  meta: { version: 1 },
  settings: {
    palette: 'peach',
    defaultAccount: { username: '', password: '' },
    windowBounds: { width: 1100, height: 720, left: null, top: null }
  },
  groups: [],
  sites: []
};

// 可切換的馬卡龍配色（對應 styles.css 中的 html[data-palette] 區塊）
var OCW_PALETTES = [
  { key: 'peach', label: '蜜桃粉', swatch: '#ffb199' },
  { key: 'mint', label: '薄荷綠', swatch: '#7ee0c1' },
  { key: 'lavender', label: '薰衣草紫', swatch: '#c9b7ff' },
  { key: 'lemon', label: '奶油檸檬', swatch: '#ffe066' }
];

// Chrome Tab Groups API 支援的顏色
var OCW_TAB_GROUP_COLORS = [
  { key: 'grey', label: '灰色', hex: '#9aa0a6' },
  { key: 'blue', label: '藍色', hex: '#4285f4' },
  { key: 'red', label: '紅色', hex: '#ea4335' },
  { key: 'yellow', label: '黃色', hex: '#fbbc04' },
  { key: 'green', label: '綠色', hex: '#34a853' },
  { key: 'pink', label: '粉紅色', hex: '#ff8bcb' },
  { key: 'purple', label: '紫色', hex: '#a142f4' },
  { key: 'cyan', label: '青色', hex: '#24c1e0' },
  { key: 'orange', label: '橘色', hex: '#fa903e' }
];

function ocwGenerateId(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** 深層合併預設值，確保舊資料升級時欄位齊全 */
function ocwNormalizeData(raw) {
  var data = raw && typeof raw === 'object' ? raw : {};
  var out = {
    meta: Object.assign({}, OCW_DEFAULT_DATA.meta, data.meta || {}),
    settings: Object.assign({}, OCW_DEFAULT_DATA.settings, data.settings || {}),
    groups: Array.isArray(data.groups) ? data.groups : [],
    sites: Array.isArray(data.sites) ? data.sites : []
  };
  out.settings.defaultAccount = Object.assign(
    { username: '', password: '' },
    (data.settings && data.settings.defaultAccount) || {}
  );
  out.settings.windowBounds = Object.assign(
    { width: 1100, height: 720, left: null, top: null },
    (data.settings && data.settings.windowBounds) || {}
  );
  return out;
}

/** 讀取全部資料（回傳 Promise） */
function ocwGetData() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([OCW_STORAGE_KEY], function (result) {
      resolve(ocwNormalizeData(result[OCW_STORAGE_KEY]));
    });
  });
}

/** 覆寫全部資料（回傳 Promise） */
function ocwSetData(data) {
  var obj = {};
  obj[OCW_STORAGE_KEY] = data;
  return new Promise(function (resolve) {
    chrome.storage.local.set(obj, function () {
      resolve(data);
    });
  });
}

/**
 * 取得某網站實際應套用的帳號密碼：
 * 1. 若網站勾選「套用預設帳號密碼」-> 一律使用預設帳密
 * 2. 若網站本身完全沒有填寫帳號與密碼（未編輯）-> 自動改用預設帳密，方便直接使用
 * 3. 其餘情況 -> 使用網站自己設定的帳號密碼
 */
function ocwResolveCredential(site, settings) {
  var defaultAccount = (settings && settings.defaultAccount) || { username: '', password: '' };
  var hasOwnCredential = !!(site && (site.username || site.password));

  if (site && site.useDefaultAccount) {
    return { username: defaultAccount.username || '', password: defaultAccount.password || '' };
  }
  if (!hasOwnCredential) {
    return { username: defaultAccount.username || '', password: defaultAccount.password || '' };
  }
  return {
    username: (site && site.username) || '',
    password: (site && site.password) || ''
  };
}

/** 嘗試從網址取出可用的 hostname，解析失敗回傳空字串 */
function ocwGetHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

/** 取得某網站所有可用網址（主要網址 + 備用網址），已過濾空值 */
function ocwGetAllUrlsForSite(site) {
  var backups = (site && Array.isArray(site.backupUrls)) ? site.backupUrls : [];
  var all = [(site && site.url) || ''].concat(backups);
  return all.filter(function (u) { return !!u; });
}

/**
 * 一鍵開啟時使用：若網站設定了備用網址，隨機從「主要網址 + 備用網址」中擇一開啟，
 * 避免單一網站發生異常時整組流程都卡住。
 */
function ocwPickUrlForSite(site) {
  var candidates = ocwGetAllUrlsForSite(site);
  if (candidates.length <= 1) return (site && site.url) || '';
  var idx = Math.floor(Math.random() * candidates.length);
  return candidates[idx];
}

if (typeof module !== 'undefined') {
  // 允許在非瀏覽器環境（例如測試）匯出，正式環境中不會用到
  module.exports = { ocwNormalizeData: ocwNormalizeData };
}
