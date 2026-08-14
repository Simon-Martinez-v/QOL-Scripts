// ==UserScript==
// @name         Save-Command
// @namespace    Alpu
// @version      1.0.0
// @author       Simon Martinez
// @description  Adds a keyboard shortcut (default Ctrl+Enter / Cmd+Enter) that clicks the Save button of whichever shift form is currently open - work plan shift form, multi-shift form, day form, or the AJAX-rendered call centre shift form. Resolves which form to save by focus, then by most-recently-opened, and refuses to guess when it is genuinely ambiguous. Uses only key combinations that Chrome and Edge leave unbound in page context.
// @match        https://workplan.geniussports.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/Simon-Martinez-v/QOL-Scripts
// @supportURL   https://github.com/Simon-Martinez-v/QOL-Scripts/issues
// @updateURL    https://raw.githubusercontent.com/Simon-Martinez-v/QOL-Scripts/main/Save-Command.user.js
// @downloadURL  https://raw.githubusercontent.com/Simon-Martinez-v/QOL-Scripts/main/Save-Command.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---- Why Ctrl+Enter -------------------------------------------------------
  //
  // Chrome and Edge between them claim every single Ctrl+<letter> and
  // Ctrl+<digit>: A select all, B bookmarks bar, C copy, D bookmark page,
  // E omnibox search, F find, G find next, H history, I/J downloads-devtools,
  // K omnibox search, L focus address bar, M mute tab (Edge), N new window,
  // O open file, P print, Q quit, R reload, S save page, T new tab,
  // U view source, V paste, W close tab, X cut, Y redo, Z undo,
  // 1-8 switch tab, 9 last tab, 0/+/- zoom.
  //
  // Some of those (Ctrl+S, Ctrl+D) can be swallowed with preventDefault, but
  // they are still "taken" - muscle memory and enterprise policy both bite.
  //
  // Ctrl+Enter is bound in the omnibox only (it completes a domain), and the
  // omnibox never delivers keydown to the page. In page context it is free in
  // both browsers, on Windows, macOS and Linux. That makes it the safe default.
  //
  // The punctuation keys in ALLOWED_KEYS below are likewise unbound in page
  // context in Chrome and Edge, and are offered as alternatives.

  const ALLOWED_KEYS = ['Enter', ';', "'", '/', '\\', '.', ',', '[', ']'];
  const DEFAULT_KEY = 'Enter';

  const CFG_KEY = 'wfm_save_hotkey_cfg';
  const SUBMIT_LOCKOUT_MS = 1500;

  let lastFireAt = 0;

  // ---- Config ---------------------------------------------------------------

  function loadCfg() {
    let cfg = { enabled: true, key: DEFAULT_KEY, hints: true };
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (raw) Object.assign(cfg, JSON.parse(raw));
    } catch (e) { /* corrupt config - fall back to defaults */ }
    if (ALLOWED_KEYS.indexOf(cfg.key) === -1) cfg.key = DEFAULT_KEY;
    return cfg;
  }

  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* private mode */ }
  }

  const cfg = loadCfg();

  function keyLabel() {
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
    return mod + '+' + (cfg.key === 'Enter' ? '\u21B5' : cfg.key);
  }

  // ---- Form panels ----------------------------------------------------------
  //
  // Every shift-creation surface on this site lives inside one of these
  // containers. The call centre form is injected into #shift_div by
  // cc_shift_form() after the AJAX round trip, so panels are resolved fresh on
  // every keypress rather than cached at load.

  const PANEL_IDS = ['shift_div', 'multi_shift_div', 'day_div', 'cc_shift_div', 'popup_div'];

  function collectPanels() {
    const seen = new Set();
    const panels = [];
    const push = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      panels.push(el);
    };
    PANEL_IDS.forEach((id) => push(document.getElementById(id)));
    document.querySelectorAll('div.form_div').forEach(push);
    return panels;
  }

  function isVisible(el) {
    if (!el) return false;
    // getClientRects() catches the site's .hidden class, inline display:none,
    // and any collapsed ancestor in one check.
    return el.getClientRects().length > 0;
  }

  // ---- Save button detection ------------------------------------------------
  //
  // Anchored on the site's own handler names first, because those survive
  // relabelling and translation. Text matching is only a fallback.

  const STRONG_ONCLICK = [
    'clicksaveshift',        // work plan shift form
    'save_cc_shift',         // call centre shift form
    'check_cc_shift_form',   // older call centre variant
    "multi_action','save",   // multi-shift form Save submit
    'multi_action", "save'
  ];

  const NEGATIVE_LABEL = /preview|delete|cancel|hide|close|back|export|import|refresh|add event|create/i;

  function labelOf(el) {
    if (el.tagName === 'INPUT') return (el.value || '').trim();
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function scoreCandidate(el) {
    const onclick = (el.getAttribute('onclick') || '').toLowerCase();
    const label = labelOf(el);
    const title = (el.getAttribute('title') || '').trim();

    // Preview and Save are sibling submits in the multi-shift form and both
    // read "type=submit" - the onclick payload is what separates them.
    if (NEGATIVE_LABEL.test(label) || NEGATIVE_LABEL.test(title)) {
      const strong = STRONG_ONCLICK.some((sig) => onclick.indexOf(sig) !== -1);
      if (!strong) return 0;
    }

    if (STRONG_ONCLICK.some((sig) => onclick.indexOf(sig) !== -1)) return 100;
    if (/^save\b/i.test(title)) return 60;                       // title="Save shift"
    if (/^save$/i.test(label)) return 50;                        // value="Save"
    if (/^save\b/i.test(label)) return 40;
    return 0;
  }

  function findSaveButton(root) {
    const sel = 'button, input[type="submit"], input[type="button"], a.image_button';
    let best = null;
    let bestScore = 0;
    root.querySelectorAll(sel).forEach((el) => {
      if (el.disabled) return;
      if (!isVisible(el)) return;
      const score = scoreCandidate(el);
      if (score > bestScore) { bestScore = score; best = el; }
    });
    return best;
  }

  // ---- Which panel did the user mean? ---------------------------------------
  //
  // Two forms can be open at once (the work plan page happily shows #shift_div
  // and #multi_shift_div side by side). Saving the wrong one writes real shift
  // data, so ambiguity is reported rather than guessed at.

  const openedAt = new WeakMap();

  function trackVisibility() {
    collectPanels().forEach((panel) => {
      const visible = isVisible(panel);
      const known = openedAt.get(panel);
      if (visible && !known) openedAt.set(panel, Date.now());
      else if (!visible && known) openedAt.delete(panel);
    });
  }

  function resolveTarget() {
    trackVisibility();

    const candidates = [];
    collectPanels().forEach((panel) => {
      if (!isVisible(panel)) return;
      const btn = findSaveButton(panel);
      if (btn) candidates.push({ panel: panel, button: btn, at: openedAt.get(panel) || 0 });
    });

    if (candidates.length === 0) {
      // Nothing recognisable inside a panel - try the document as a whole, for
      // pages whose form is not wrapped in .form_div.
      const loose = findSaveButton(document.body);
      return loose ? { button: loose, reason: 'page' } : null;
    }

    // 1. Focus wins. Clicking into a form is an unambiguous statement of intent.
    const active = document.activeElement;
    if (active && active !== document.body) {
      const focused = candidates.find((c) => c.panel.contains(active));
      if (focused) return { button: focused.button, panel: focused.panel, reason: 'focus' };
    }

    if (candidates.length === 1) {
      return { button: candidates[0].button, panel: candidates[0].panel, reason: 'only form open' };
    }

    // 2. Most recently opened. Distinct enough to be a real signal only if the
    //    gap is meaningful - two panels revealed in the same tick are a tie.
    candidates.sort((a, b) => b.at - a.at);
    if (candidates[0].at - candidates[1].at > 400) {
      return { button: candidates[0].button, panel: candidates[0].panel, reason: 'most recently opened' };
    }

    return { ambiguous: true, count: candidates.length };
  }

  // ---- Feedback -------------------------------------------------------------

  function flash(el) {
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '2px solid #d40000';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, 350);
  }

  let toastEl = null;
  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'wfm-hotkey-toast';
      toastEl.style.cssText = [
        'position:fixed', 'top:12px', 'right:12px', 'z-index:99999',
        'max-width:320px', 'padding:8px 12px',
        'background:#fff', 'border:1px solid #999', 'border-left:4px solid #d40000',
        'box-shadow:0 2px 6px rgba(0,0,0,.2)',
        'font:12px/1.4 Arial,Helvetica,sans-serif', 'color:#222'
      ].join(';');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.style.display = 'none'; }, ms || 3000);
  }

  // ---- Hint badges ----------------------------------------------------------

  function injectHints() {
    if (!cfg.hints) return;
    collectPanels().forEach((panel) => {
      if (!isVisible(panel)) return;
      const btn = findSaveButton(panel);
      if (!btn || btn.dataset.wfmHotkeyHinted) return;
      btn.dataset.wfmHotkeyHinted = '1';

      const hint = document.createElement('span');
      hint.setAttribute('data-wfm-hotkey-hint', '1');
      hint.textContent = keyLabel();
      hint.style.cssText = 'margin-left:6px;font-size:10px;color:#777;white-space:nowrap;vertical-align:middle;';
      btn.insertAdjacentElement('afterend', hint);
    });
  }

  function refreshHintLabels() {
    document.querySelectorAll('[data-wfm-hotkey-hint]').forEach((el) => { el.textContent = keyLabel(); });
  }

  function removeHints() {
    document.querySelectorAll('[data-wfm-hotkey-hint]').forEach((el) => el.remove());
    document.querySelectorAll('[data-wfm-hotkey-hinted]').forEach((el) => { delete el.dataset.wfmHotkeyHinted; });
  }

  // ---- Key handling ---------------------------------------------------------

  function isHotkey(e) {
    if (!(e.ctrlKey || e.metaKey)) return false;
    if (e.altKey || e.shiftKey) return false;   // leave Ctrl+Shift+* to the browser
    if (cfg.key === 'Enter') return e.key === 'Enter';
    return e.key === cfg.key;
  }

  function onKeyDown(e) {
    if (!cfg.enabled) return;
    if (!isHotkey(e)) return;

    const now = Date.now();
    if (now - lastFireAt < SUBMIT_LOCKOUT_MS) {
      e.preventDefault();
      return; // guard against a double tap posting the same shift twice
    }

    const target = resolveTarget();

    if (!target) return;  // no shift form open - let the keystroke pass through

    e.preventDefault();
    e.stopPropagation();

    if (target.ambiguous) {
      toast(target.count + ' forms are open. Click into the one you want, then press ' + keyLabel() + '.', 4000);
      return;
    }

    lastFireAt = now;
    flash(target.button);

    // A real click, not a form.submit(): the site's clickSaveShift() and
    // save_cc_shift() run their own validation and confirm() prompts, and the
    // multi-shift Save sets multi_action before submitting. Bypassing the
    // handler would skip all of that.
    setTimeout(() => target.button.click(), 60);
  }

  window.addEventListener('keydown', onKeyDown, true);

  // ---- Re-apply after LoadPage() and AJAX form renders -----------------------

  let pending = null;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      trackVisibility();
      injectHints();
    }, 150);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style']
  });

  trackVisibility();
  injectHints();

  // ---- Console API ----------------------------------------------------------

  window.wfmSaveKey = {
    help: function () {
      console.log(
        '[WFM Save Hotkey]\n' +
        '  wfmSaveKey.status()        current state\n' +
        '  wfmSaveKey.enable()        turn the hotkey on\n' +
        '  wfmSaveKey.disable()       turn the hotkey off\n' +
        '  wfmSaveKey.setKey(k)       change the key, one of: ' + ALLOWED_KEYS.join(' ') + '\n' +
        '  wfmSaveKey.hints(bool)     show or hide the badge next to Save\n' +
        '  wfmSaveKey.targets()       what the script can currently see\n\n' +
        'Allowed keys are limited to combinations Chrome and Edge leave unbound\n' +
        'in page context. Every Ctrl+letter and Ctrl+digit is claimed by one\n' +
        'browser or the other, so none of them are offered.'
      );
    },
    status: function () {
      const s = { enabled: cfg.enabled, hotkey: keyLabel(), key: cfg.key, hints: cfg.hints };
      console.table(s);
      return s;
    },
    enable: function () { cfg.enabled = true; saveCfg(); injectHints(); return this.status(); },
    disable: function () { cfg.enabled = false; saveCfg(); return this.status(); },
    setKey: function (k) {
      if (ALLOWED_KEYS.indexOf(k) === -1) {
        console.warn('[WFM Save Hotkey] "' + k + '" is not offered. Chrome or Edge already binds it. Pick one of: ' + ALLOWED_KEYS.join(' '));
        return this.status();
      }
      cfg.key = k;
      saveCfg();
      refreshHintLabels();
      return this.status();
    },
    hints: function (on) {
      cfg.hints = !!on;
      saveCfg();
      if (cfg.hints) injectHints(); else removeHints();
      return this.status();
    },
    targets: function () {
      trackVisibility();
      const rows = [];
      collectPanels().forEach((panel) => {
        const visible = isVisible(panel);
        const btn = visible ? findSaveButton(panel) : null;
        rows.push({
          panel: panel.id || panel.className || '(unnamed)',
          visible: visible,
          saveButton: btn ? (labelOf(btn) || btn.getAttribute('title') || btn.tagName) : '-',
          openedAt: openedAt.get(panel) ? new Date(openedAt.get(panel)).toLocaleTimeString() : '-'
        });
      });
      console.table(rows);
      const resolved = resolveTarget();
      console.log('would save:', resolved && resolved.ambiguous
        ? '(ambiguous - ' + resolved.count + ' forms open)'
        : (resolved ? labelOf(resolved.button) + '  [' + resolved.reason + ']' : '(nothing)'));
      return rows;
    }
  };

  console.log('[WFM Save Hotkey] active - ' + keyLabel() + ' saves the open shift form. wfmSaveKey.help() for options.');

})();
