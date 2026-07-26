/**
 * content.js
 * 一鍵精靈 OneClick Wizard - 自動填入帳號密碼（一次性行為）
 *
 * 重要設計原則：
 * 這支腳本雖然會注入到每個網頁，但「不會」自行比對目前網址是否符合已設定的網站，
 * 也不會長駐重複執行帳密填入。真正的判斷交給 background.js：
 * 只有透過「一鍵開啟」建立的分頁，background 才會標記該分頁可以自動填入，
 * 且這個標記只能被「消費」一次（取用後立即失效）。
 *
 * 因此：使用者自行手動輸入網址、點擊連結、或原本就開著的分頁，
 * 即使網址與已設定的網站相符，也「不會」被自動填入帳密。
 */

(function () {
  var FILL_TIMEOUT_MS = 8000; // 最多嘗試填入 8 秒
  var alreadyFilled = false;

  // 常見帳號欄位選擇器（依優先順序）
  var USERNAME_SELECTORS = [
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[type="email"]',
    'input[name="username" i]',
    'input[name="login" i]',
    'input[name*="email" i]',
    'input[name*="user" i]',
    'input[name*="account" i]',
    'input[name*="login" i]',
    'input[name*="uid" i]',
    'input[name*="uname" i]',
    'input[id="username" i]',
    'input[id="login" i]',
    'input[id*="email" i]',
    'input[id*="user" i]',
    'input[id*="account" i]',
    'input[id*="login" i]',
    'input[id*="uid" i]',
    'input[placeholder*="帳號" i]',
    'input[placeholder*="帳戶" i]',
    'input[placeholder*="使用者" i]',
    'input[placeholder*="用戶" i]',
    'input[placeholder*="信箱" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="username" i]',
    'input[placeholder*="account" i]',
    'input[type="text"]',
    'input[type="tel"]',
    'input:not([type])'
  ];

  var PASSWORD_SELECTORS = [
    'input[type="password"]'
  ];

  function isFillableVisible(el) {
    return !!el && el.offsetParent !== null && !el.disabled && !el.readOnly;
  }

  function findFirstVisible(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var els = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < els.length; j++) {
        if (isFillableVisible(els[j])) return els[j];
      }
    }
    return null;
  }

  /**
   * 找出帳號欄位。許多網站的帳號欄位沒有明確的 name/id/placeholder 關鍵字，
   * 因此在關鍵字比對找不到結果時，進一步以「與密碼欄位同一個表單內、
   * 第一個可見的文字型輸入框」作為合理猜測。
   */
  function findUsernameField(passwordEl) {
    var byKeyword = findFirstVisible(USERNAME_SELECTORS);
    if (byKeyword) return byKeyword;

    var scope = (passwordEl && passwordEl.form) ? passwordEl.form : document;
    var candidates = scope.querySelectorAll(
      'input[type="text"], input[type="email"], input[type="tel"], input:not([type])'
    );
    var visible = Array.prototype.filter.call(candidates, isFillableVisible);
    if (visible.length >= 1) return visible[0];

    return null;
  }

  function setNativeValue(el, value) {
    var proto = Object.getPrototypeOf(el);
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function tryFill(credential) {
    if (alreadyFilled) return true;
    var passEl = findFirstVisible(PASSWORD_SELECTORS);
    var userEl = findUsernameField(passEl);

    var filledSomething = false;
    if (userEl && credential.username && userEl !== passEl) {
      setNativeValue(userEl, credential.username);
      filledSomething = true;
    }
    if (passEl && credential.password) {
      setNativeValue(passEl, credential.password);
      filledSomething = true;
    }

    if (filledSomething) {
      alreadyFilled = true;
      return true;
    }
    return false;
  }

  // 只在最上層分頁詢問一次，避免頁面內每個 iframe 都各自請求
  if (window.top !== window) return;

  chrome.runtime.sendMessage({ type: 'OCW_REQUEST_AUTOFILL' }, function (resp) {
    if (chrome.runtime.lastError) return; // 擴充功能情境失效（例如頁面卸載）時安靜忽略
    if (!resp || !resp.ok || !resp.credential) return;

    var credential = resp.credential;
    if (!credential.username && !credential.password) return;

    // 立即嘗試一次
    if (tryFill(credential)) return;

    // 持續觀察 DOM 變化，處理動態載入的登入表單（但仍只套用「這一次」取得的憑證）
    var observer = new MutationObserver(function () {
      if (tryFill(credential)) {
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    setTimeout(function () {
      observer.disconnect();
    }, FILL_TIMEOUT_MS);
  });
})();
