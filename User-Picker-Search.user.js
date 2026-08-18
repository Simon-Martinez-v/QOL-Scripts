// ==UserScript==
// @name         User Picker Search
// @namespace    simon-wfm-logger
// @version      1.0.2
// @description  Replaces the invisible 500ms type-ahead on the user combo (Create/Edit Shift and CC Create Shift) with a visible, editable search box. Substring + multi-token matching on full name and user ID, backspace, arrow keys, Enter to pick, Esc to clear/close. Respects the site's own shift-type / active-user filtering.
// @author       Simon Martinez
// @match        https://workplan.geniussports.com/admin_work_plan/*
// @match        https://workplan.geniussports.com/admin_call_center/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/Simon-Martinez-v/QOL-Scripts
// @supportURL   https://github.com/Simon-Martinez-v/QOL-Scripts/issues
// @updateURL    https://github.com/Simon-Martinez-v/QOL-Scripts/raw/refs/heads/main/User-Picker-Search.user.js
// @downloadURL  https://github.com/Simon-Martinez-v/QOL-Scripts/raw/refs/heads/main/User-Picker-Search.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  const LS_KEY = 'wfm_user_search_enabled';
  const NOMATCH = 'wfm-nomatch';   // our own hide class, kept separate from site's .hidden
  const HL = 'wfm-hl';             // keyboard highlight
  const BOX_CLASS = 'wfm-user-search';

  let enabled = localStorage.getItem(LS_KEY) !== '0';
  let applying = false;            // re-entrancy guard for our own class writes
  let rafPending = false;

  // ---------------------------------------------------------------------------
  // Theme (read from site CSS rather than hardcoding - same approach as sidebar)
  // ---------------------------------------------------------------------------

  function themeAccent() {
    const probe = document.querySelector('li.title');
    if (probe) {
      const bg = getComputedStyle(probe).backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg;
    }
    return '#4a6785';
  }

  function injectStyles() {
    if (document.getElementById('wfm-user-search-style')) return;
    const accent = themeAccent();
    const style = document.createElement('style');
    style.id = 'wfm-user-search-style';
    style.textContent = `
      li.${NOMATCH} { display: none !important; }
      li.${HL} { outline: 2px solid ${accent}; outline-offset: -2px; }
      .${BOX_CLASS} {
        position: sticky; top: 0; z-index: 5;
        display: block;
        padding: 8px; background: #fff;
        border-bottom: 1px solid #ccc;
        box-sizing: border-box;
      }
      .${BOX_CLASS} .wfm-field { position: relative; display: block; }
      .${BOX_CLASS} input[type="text"] {
        display: block !important;
        width: 100% !important;
        box-sizing: border-box !important;
        height: auto !important;
        min-height: 34px !important;
        margin: 0 !important;
        padding: 7px 46px 7px 10px !important;
        font-size: 16px !important;
        line-height: 20px !important;
        font-family: Arial, Helvetica, sans-serif !important;
        font-weight: normal !important;
        letter-spacing: normal !important;
        border: 1px solid #999 !important;
        border-radius: 3px !important;
        background: #fff !important;
        color: #000 !important;
        -webkit-text-fill-color: #000 !important;
        opacity: 1 !important;
        text-transform: none !important;
        text-indent: 0 !important;
      }
      .${BOX_CLASS} input[type="text"]:focus {
        outline: none !important;
        border-color: ${accent} !important;
        box-shadow: 0 0 0 2px rgba(0,0,0,0.10) !important;
      }
      .${BOX_CLASS} input[type="text"]::placeholder {
        color: #999 !important; font-size: 13px !important;
        -webkit-text-fill-color: #999 !important;
      }
      .${BOX_CLASS} .wfm-count {
        position: absolute; right: 9px; top: 50%;
        transform: translateY(-50%);
        font-size: 11px !important; color: #666 !important;
        white-space: nowrap; font-weight: normal !important;
        pointer-events: none; background: transparent !important;
      }
      .${BOX_CLASS} .wfm-count.wfm-zero { color: #c00 !important; font-weight: bold !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Combo discovery
  // ---------------------------------------------------------------------------

  // A "user combo" is any <ul id="..._ul"> whose <li>s carry the site's
  // setUserOption() inline handler. This covers #shift_user_id_ul on the work
  // plan form and the identically-built combo the CC form loads over AJAX.
  function isUserCombo(ul) {
    return !!ul.querySelector('li[onclick*="setUserOption"]');
  }

  function allCombos() {
    return Array.prototype.filter.call(
      document.querySelectorAll('ul[id$="_ul"]'),
      isUserCombo
    );
  }

  function isOpen(ul) {
    return !ul.classList.contains('hidden');
  }

  function openCombo() {
    return allCombos().find(isOpen) || null;
  }

  // ---------------------------------------------------------------------------
  // Matching
  // ---------------------------------------------------------------------------

  function haystack(li) {
    if (li.__wfmHay) return li.__wfmHay;
    const name = (li.getAttribute('data-fullname') || li.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
    const id = li.getAttribute('value') || '';
    const hay = name + ' #' + id;
    li.__wfmHay = hay;
    return hay;
  }

  function matches(li, tokens) {
    const hay = haystack(li);
    for (let i = 0; i < tokens.length; i++) {
      if (hay.indexOf(tokens[i]) === -1) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------

  function visibleItems(ul) {
    return Array.prototype.filter.call(
      ul.querySelectorAll('li'),
      (li) => !li.classList.contains('hidden') && !li.classList.contains(NOMATCH)
    );
  }

  function applyFilter(ul) {
    const box = ul.__wfmBox;
    if (!box) return;

    const raw = box.value.trim().toUpperCase();
    const tokens = raw.split(/\s+/).filter(Boolean);

    applying = true;
    try {
      let shown = 0;
      let eligible = 0;

      Array.prototype.forEach.call(ul.querySelectorAll('li'), (li) => {
        // The site uses .hidden for shift-type / active-user eligibility.
        // Never touch those rows beyond clearing a stale mark of ours.
        if (li.classList.contains('hidden')) {
          if (li.classList.contains(NOMATCH)) li.classList.remove(NOMATCH);
          return;
        }
        eligible++;

        // Keep the "-- Please select --" row available when not searching.
        const isPlaceholder = li.getAttribute('value') === '0';
        const ok = tokens.length === 0
          ? true
          : (isPlaceholder ? false : matches(li, tokens));

        if (ok) {
          if (li.classList.contains(NOMATCH)) li.classList.remove(NOMATCH);
          shown++;
        } else {
          if (!li.classList.contains(NOMATCH)) li.classList.add(NOMATCH);
          li.classList.remove(HL);
        }
      });

      const counter = ul.__wfmCount;
      if (counter) {
        counter.textContent = tokens.length ? (shown + ' / ' + eligible) : (eligible + ' users');
        counter.classList.toggle('wfm-zero', tokens.length > 0 && shown === 0);
      }

      // Keep a highlight on the first match so Enter always has a target.
      const items = visibleItems(ul);
      const stillHighlighted = items.some((li) => li.classList.contains(HL));
      if (!stillHighlighted) {
        clearHighlight(ul);
        if (tokens.length && items.length) highlight(ul, items[0], false);
      }
    } finally {
      applying = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Highlight / selection
  // ---------------------------------------------------------------------------

  function clearHighlight(ul) {
    Array.prototype.forEach.call(ul.querySelectorAll('li.' + HL), (li) =>
      li.classList.remove(HL)
    );
  }

  function highlight(ul, li, scroll) {
    if (!li) return;
    applying = true;
    try {
      clearHighlight(ul);
      li.classList.add(HL);
    } finally {
      applying = false;
    }
    if (scroll !== false && li.scrollIntoView) {
      li.scrollIntoView({ block: 'nearest' });
    }
  }

  function moveHighlight(ul, delta) {
    const items = visibleItems(ul);
    if (!items.length) return;
    let idx = items.findIndex((li) => li.classList.contains(HL));
    if (idx === -1) idx = delta > 0 ? -1 : 0;
    let next = idx + delta;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    highlight(ul, items[next], true);
  }

  function selectHighlighted(ul) {
    const items = visibleItems(ul);
    const target = items.find((li) => li.classList.contains(HL)) || items[0];
    if (!target) return;

    // setUserOption() copies the li's className onto the label span, so strip
    // our highlight class first or the label inherits it.
    applying = true;
    try {
      target.classList.remove(HL);
    } finally {
      applying = false;
    }

    const box = ul.__wfmBox;
    if (box) box.value = '';

    // Fire the site's own inline handler - it calls setUserOption() and
    // setOverallMovement() and hides the list, exactly like a real click.
    target.click();

    applyFilter(ul);
  }

  function closeCombo(ul) {
    if (typeof window.hideElement === 'function') {
      window.hideElement(ul.id);
    } else {
      ul.classList.add('hidden');
    }
  }

  // ---------------------------------------------------------------------------
  // Search box injection
  // ---------------------------------------------------------------------------

  function injectBox(ul) {
    if (ul.__wfmBox && ul.contains(ul.__wfmBox)) return;

    const wrap = document.createElement('div');
    wrap.className = BOX_CLASS;
    // Deliberately a <div>, not an <li>: the site's filter_users() and
    // orderUsers() only ever select/sort "li" children, so a div is invisible
    // to them and always stays as the first child.

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search name or ID';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('data-wfm-user-search', '1');

    const count = document.createElement('span');
    count.className = 'wfm-count';

    const field = document.createElement('div');
    field.className = 'wfm-field';
    field.appendChild(input);
    field.appendChild(count);
    wrap.appendChild(field);
    ul.insertBefore(wrap, ul.firstChild);

    ul.__wfmBox = input;
    ul.__wfmCount = count;

    input.addEventListener('input', () => applyFilter(ul));

    // Clicking in the box must not reach the ancestors that call
    // hideElement('shift_user_id_ul') on click.
    ['click', 'mousedown'].forEach((evt) => {
      wrap.addEventListener(evt, (e) => e.stopPropagation());
    });

    applyFilter(ul);
  }

  function removeBox(ul) {
    const wrap = ul.querySelector('.' + BOX_CLASS);
    if (wrap) wrap.remove();
    ul.__wfmBox = null;
    ul.__wfmCount = null;
    applying = true;
    try {
      Array.prototype.forEach.call(ul.querySelectorAll('li'), (li) => {
        li.classList.remove(NOMATCH);
        li.classList.remove(HL);
      });
    } finally {
      applying = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  function isPrintable(e) {
    return e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  }

  function handleBoxKey(e, ul, box) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveHighlight(ul, 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveHighlight(ul, -1);
        break;
      case 'Enter':
        // Critical: this input lives inside #shiftForm, so a bare Enter would
        // do a native form POST to save_shift.
        e.preventDefault();
        selectHighlighted(ul);
        break;
      case 'Escape':
        e.preventDefault();
        if (box.value) {
          box.value = '';
          applyFilter(ul);
        } else {
          closeCombo(ul);
        }
        break;
      case 'Tab':
        break;
      default:
        break;
    }
  }

  // Capture phase on document: stopPropagation() here prevents the event from
  // ever reaching the site's bubble-phase $(document).keydown type-ahead.
  function onCaptureKeydown(e) {
    if (!enabled) return;
    const ul = openCombo();
    if (!ul) return;
    const box = ul.__wfmBox;
    if (!box) return;

    if (e.target === box) {
      e.stopPropagation();
      handleBoxKey(e, ul, box);
      return;
    }

    // Typing while the list is open but focus is elsewhere: pull it into the
    // search box, unless the user is legitimately typing in another field.
    const tag = (e.target && e.target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (isPrintable(e)) {
      e.stopPropagation();
      e.preventDefault();
      focusBox(box);
      box.value += e.key;
      applyFilter(ul);
    } else if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Backspace'].indexOf(e.key) !== -1) {
      e.stopPropagation();
      focusBox(box);
      if (e.key === 'Backspace') {
        e.preventDefault();
        box.value = box.value.slice(0, -1);
        applyFilter(ul);
      } else {
        handleBoxKey(e, ul, box);
      }
    }
  }

  function focusBox(box) {
    try {
      box.focus({ preventScroll: true });
    } catch (err) {
      box.focus();
    }
  }

  // ---------------------------------------------------------------------------
  // Open/close watching
  // ---------------------------------------------------------------------------

  // If the combo is a floating overlay (absolute/fixed), widening it can't
  // disturb the surrounding form layout - so give the search box room to
  // breathe when the site's own width is cramped.
  const MIN_UL_WIDTH = 300;
  function ensureWidth(ul) {
    const cs = getComputedStyle(ul);
    if (cs.position !== 'absolute' && cs.position !== 'fixed') return;
    if (ul.getBoundingClientRect().width < MIN_UL_WIDTH) {
      ul.style.setProperty('min-width', MIN_UL_WIDTH + 'px', 'important');
    }
  }

  function onComboOpened(ul) {
    injectBox(ul);
    ensureWidth(ul);
    const box = ul.__wfmBox;
    if (!box) return;
    box.value = '';
    applyFilter(ul);
    // Let the site's setScrollbar() run first, then take focus without
    // fighting its scroll position.
    setTimeout(() => {
      if (isOpen(ul) && enabled) focusBox(box);
    }, 60);
  }

  function watchCombo(ul) {
    if (ul.__wfmWatched) return;
    ul.__wfmWatched = true;

    injectBox(ul);
    if (isOpen(ul)) onComboOpened(ul);

    // Open/close is driven by toggleControl() adding/removing .hidden.
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.attributeName !== 'class') continue;
        if (isOpen(ul)) {
          onComboOpened(ul);
        } else {
          clearHighlight(ul);
        }
      }
    }).observe(ul, { attributes: true, attributeFilter: ['class'] });

    // The site re-runs filter_users() on shift type / active filter changes,
    // which rewrites .hidden across every li. Re-apply our layer on top.
    new MutationObserver(() => {
      if (applying || !enabled) return;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (ul.isConnected) {
          injectBox(ul);
          applyFilter(ul);
        }
      });
    }).observe(ul, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }

  function scan() {
    if (!enabled) return;
    injectStyles();
    allCombos().forEach(watchCombo);
  }

  // The CC form arrives as AJAX html (cc_shift_form -> json.html), so the whole
  // combo can be replaced wholesale; the work plan page rebuilds it on
  // LoadPage() navigation.
  const bodyObserver = new MutationObserver(() => {
    if (!enabled) return;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      scan();
    });
  });

  // ---------------------------------------------------------------------------
  // Console API
  // ---------------------------------------------------------------------------

  window.wfmUserSearch = {
    enable() {
      enabled = true;
      localStorage.setItem(LS_KEY, '1');
      scan();
      return 'WFM User Picker Search: enabled';
    },
    disable() {
      enabled = false;
      localStorage.setItem(LS_KEY, '0');
      allCombos().forEach(removeBox);
      return 'WFM User Picker Search: disabled (native type-ahead restored)';
    },
    status() {
      const combos = allCombos();
      return {
        enabled,
        combos: combos.map((ul) => ({
          id: ul.id,
          open: isOpen(ul),
          hasBox: !!ul.__wfmBox,
          total: ul.querySelectorAll('li').length,
          eligible: ul.querySelectorAll('li:not(.hidden)').length
        }))
      };
    },
    rescan() {
      scan();
      return 'rescanned';
    },
    // Run this with the dropdown OPEN if the box still looks wrong.
    diagnose() {
      const ul = openCombo() || allCombos()[0];
      if (!ul) return 'no user combo found on this page';
      const box = ul.__wfmBox;
      if (!box) return 'combo found (' + ul.id + ') but no search box injected';
      const bs = getComputedStyle(box);
      const us = getComputedStyle(ul);
      return {
        ulId: ul.id,
        ulPosition: us.position,
        ulWidth: Math.round(ul.getBoundingClientRect().width),
        ulOverflow: us.overflow + ' / ' + us.overflowX,
        boxWidth: Math.round(box.getBoundingClientRect().width),
        boxHeight: Math.round(box.getBoundingClientRect().height),
        fontSize: bs.fontSize,
        lineHeight: bs.lineHeight,
        fontFamily: bs.fontFamily,
        color: bs.color,
        background: bs.backgroundColor,
        textTransform: bs.textTransform,
        styleTagPresent: !!document.getElementById('wfm-user-search-style')
      };
    }
  };

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  document.addEventListener('keydown', onCaptureKeydown, true);
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  scan();

  console.log('[User Picker Search] v1.0.2 loaded (' + (enabled ? 'enabled' : 'disabled') + ') - window.wfmUserSearch');
})();
