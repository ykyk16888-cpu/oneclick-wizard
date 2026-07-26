/**
 * background.js
 * 一鍵精靈 OneClick Wizard - Service Worker (Manifest V3)
 *
 * 負責：
 * 1. 點擊工具列圖示 -> 開啟／喚醒「管理視窗」
 * 2. 一鍵開啟：建立新視窗、依群組建立 Tab Group 並套用名稱/顏色
 * 3. 一鍵登出：清除 Cookie ＋ 網站資料，或依自訂登出網址/選擇器操作
 */

importScripts('storage.js');

var OCW_MANAGER_URL = 'manager.html';
var ocwManagerWindowId = null; // 追蹤目前開啟中的管理視窗 id

// -----------------------------------------------------------------------
// 0) 一次性自動填入標記管理
//    只有透過「一鍵開啟」建立的分頁，才會被標記為可自動填入帳密，
//    且每個分頁只能被消費（使用）一次，避免使用者自行瀏覽到同網址時
//    也被長駐在背景的邏輯自動套用帳號密碼。
// -----------------------------------------------------------------------
function ocwPendingKey(tabId) { return 'pending_autofill_' + tabId; }

async function ocwMarkTabForAutofill(tabId, siteId) {
  var obj = {};
  obj[ocwPendingKey(tabId)] = siteId;
  await chrome.storage.session.set(obj);
}

/** 讀取並「消耗」某分頁的自動填入標記，取用後立即移除，確保只會生效一次 */
async function ocwConsumeTabAutofill(tabId) {
  var key = ocwPendingKey(tabId);
  var result = await chrome.storage.session.get([key]);
  var siteId = result[key];
  if (siteId) {
    await chrome.storage.session.remove([key]);
  }
  return siteId || null;
}

chrome.tabs.onRemoved.addListener(function (tabId) {
  chrome.storage.session.remove([ocwPendingKey(tabId)]);
});

// -----------------------------------------------------------------------
// 1) 點擊工具列圖示 -> 開啟管理視窗
// -----------------------------------------------------------------------
chrome.action.onClicked.addListener(function () {
  openManagerWindow();
});

async function openManagerWindow() {
  // 若視窗仍存在就直接聚焦，避免開出多個管理視窗
  if (ocwManagerWindowId !== null) {
    try {
      var existing = await chrome.windows.get(ocwManagerWindowId);
      if (existing) {
        chrome.windows.update(ocwManagerWindowId, { focused: true });
        return;
      }
    } catch (e) {
      ocwManagerWindowId = null; // 視窗已關閉
    }
  }

  var data = await ocwGetData();
  var bounds = data.settings.windowBounds || {};
  var createOpts = {
    url: chrome.runtime.getURL(OCW_MANAGER_URL),
    type: 'popup',
    width: bounds.width || 1100,
    height: bounds.height || 720
  };
  if (typeof bounds.left === 'number' && typeof bounds.top === 'number') {
    createOpts.left = bounds.left;
    createOpts.top = bounds.top;
  }

  var win = await chrome.windows.create(createOpts);
  ocwManagerWindowId = win.id;
}

chrome.windows.onRemoved.addListener(function (windowId) {
  if (windowId === ocwManagerWindowId) {
    ocwManagerWindowId = null;
  }
});

// -----------------------------------------------------------------------
// 2) 訊息路由
// -----------------------------------------------------------------------
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return false;

  if (message.type === 'OCW_OPEN_MANAGER') {
    openManagerWindow().then(function () { sendResponse({ ok: true }); });
    return true;
  }

  if (message.type === 'OCW_OPEN_SITES') {
    openSites(message.siteIds).then(function (result) {
      sendResponse({ ok: true, result: result });
    }).catch(function (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    });
    return true;
  }

  if (message.type === 'OCW_LOGOUT_SITES') {
    logoutSites(message.siteIds).then(function (result) {
      sendResponse({ ok: true, result: result });
    }).catch(function (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    });
    return true;
  }

  if (message.type === 'OCW_REQUEST_AUTOFILL') {
    var tabId = sender && sender.tab && sender.tab.id;
    if (tabId === undefined || tabId === null) {
      sendResponse({ ok: true, credential: null });
      return true;
    }
    (async function () {
      try {
        var siteId = await ocwConsumeTabAutofill(tabId);
        if (!siteId) {
          sendResponse({ ok: true, credential: null });
          return;
        }
        var data = await ocwGetData();
        var site = data.sites.filter(function (s) { return s.id === siteId; })[0];
        if (!site) {
          sendResponse({ ok: true, credential: null });
          return;
        }
        sendResponse({ ok: true, credential: ocwResolveCredential(site, data.settings) });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true;
  }

  return false;
});

// -----------------------------------------------------------------------
// 3) 一鍵開啟：建立視窗 + 分頁分組 + (由 content.js 自動填入帳密)
// -----------------------------------------------------------------------
async function openSites(siteIds) {
  var data = await ocwGetData();
  var sites = data.sites.filter(function (s) { return siteIds.indexOf(s.id) !== -1; });
  if (sites.length === 0) return { openedTabs: 0 };

  // 依網站設定隨機挑選網址（若有備用網址，避免單一網站異常卡住整組流程）
  var urls = sites.map(function (s) { return ocwPickUrlForSite(s); });

  // 建立新視窗，一次帶入所有網址（第一個網址會是 active tab）
  var win = await chrome.windows.create({ url: urls, focused: true });
  var tabs = win.tabs || [];

  // 依群組把 tabId 分類，並標記每個分頁對應的網站（供一次性自動填入使用）
  var groupMap = {}; // groupId -> [tabId,...]
  for (var i = 0; i < sites.length; i++) {
    var site = sites[i];
    var tab = tabs[i];
    if (!tab) continue;
    var gid = site.groupId || '__none__';
    if (!groupMap[gid]) groupMap[gid] = [];
    groupMap[gid].push(tab.id);
    await ocwMarkTabForAutofill(tab.id, site.id);
  }

  var groupsById = {};
  data.groups.forEach(function (g) { groupsById[g.id] = g; });

  for (var gidKey in groupMap) {
    if (gidKey === '__none__') continue; // 未分組網站保持獨立分頁
    var tabIds = groupMap[gidKey];
    var groupInfo = groupsById[gidKey];
    if (!tabIds.length) continue;
    try {
      var chromeGroupId = await chrome.tabs.group({ tabIds: tabIds, createProperties: { windowId: win.id } });
      if (groupInfo) {
        await chrome.tabGroups.update(chromeGroupId, {
          title: groupInfo.name || '未命名群組',
          color: groupInfo.color || 'grey'
        });
      }
    } catch (e) {
      // 分組失敗不中斷流程（例如只有 1 個分頁時仍可分組，但保守處理錯誤）
      console.warn('[一鍵精靈] Tab 分組失敗：', e);
    }
  }

  return { openedTabs: tabs.length };
}

// -----------------------------------------------------------------------
// 4) 一鍵登出
// -----------------------------------------------------------------------
async function logoutSites(siteIds) {
  var data = await ocwGetData();
  var sites = data.sites.filter(function (s) { return siteIds.indexOf(s.id) !== -1; });
  var results = [];

  for (var i = 0; i < sites.length; i++) {
    var site = sites[i];
    try {
      if (site.logoutUrl) {
        await logoutViaCustomUrl(site);
        results.push({ id: site.id, method: 'custom-url', ok: true });
      } else {
        await logoutViaCookieClear(site);
        results.push({ id: site.id, method: 'cookie-clear', ok: true });
      }
    } catch (e) {
      results.push({ id: site.id, method: 'error', ok: false, error: String(e && e.message || e) });
    }
  }
  return results;
}

/** 開啟自訂登出網址，若有設定選擇器則嘗試點擊該按鈕 */
function logoutViaCustomUrl(site) {
  return new Promise(function (resolve, reject) {
    chrome.tabs.create({ url: site.logoutUrl, active: false }, function (tab) {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      var tabId = tab.id;

      function onUpdated(updatedTabId, changeInfo) {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);

        var afterInject = function () {
          // 讓使用者可以看到登出結果，短暫延遲後關閉分頁
          setTimeout(function () {
            chrome.tabs.remove(tabId, function () { resolve(true); });
          }, 1500);
        };

        if (site.logoutSelector) {
          chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: function (selector) {
              var el = document.querySelector(selector);
              if (el) el.click();
            },
            args: [site.logoutSelector]
          }).then(afterInject).catch(afterInject);
        } else {
          afterInject();
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

/** 清除該網站主要網址與所有備用網址對應網域的 Cookie 與網站資料 */
async function logoutViaCookieClear(site) {
  var allUrls = ocwGetAllUrlsForSite(site);
  if (!allUrls.length) throw new Error('無法解析網址：' + site.url);

  var origins = [];
  for (var u = 0; u < allUrls.length; u++) {
    var hostname = ocwGetHostname(allUrls[u]);
    if (!hostname) continue;

    // 清除該網域（含子網域）所有 cookie
    var cookies = await chrome.cookies.getAll({ domain: hostname });
    var extra = await chrome.cookies.getAll({ domain: hostname.replace(/^www\./, '') });
    var all = cookies.concat(extra);
    var seen = {};
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      var key = c.name + '|' + c.domain + '|' + c.path;
      if (seen[key]) continue;
      seen[key] = true;
      var protocol = c.secure ? 'https://' : 'http://';
      var cookieUrl = protocol + c.domain.replace(/^\./, '') + c.path;
      try {
        await chrome.cookies.remove({ url: cookieUrl, name: c.name });
      } catch (e) {
        // 忽略單一 cookie 清除失敗
      }
    }

    try {
      origins.push(new URL(allUrls[u]).origin);
    } catch (e) {
      // 略過無法解析的網址
    }
  }

  // 使用 browsingData 進一步清除這些網站的 localStorage / IndexedDB 等資料
  if (origins.length) {
    try {
      await chrome.browsingData.remove(
        { origins: origins },
        { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true }
      );
    } catch (e) {
      console.warn('[一鍵精靈] browsingData 清除失敗：', e);
    }
  }

  return true;
}
