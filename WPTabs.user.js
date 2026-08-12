// ==UserScript==
// @name         WFM Tab Title
// @namespace    wfm
// @version      1.1.0
// @description  Replaces the static "Workplan" tab title with the actual page heading plus context (date, sport, search term), so multiple WorkPlan tabs are tellable apart.
// @author       simmart
// @match        https://workplan.geniussports.com/*
// @run-at       document-end
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Simon-Martinez-v/QOL-Scripts/main/WPTabs.user.js
// @downloadURL  https://raw.githubusercontent.com/Simon-Martinez-v/QOL-Scripts/main/WPTabs.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ==========================================================================
  // Config (persisted in localStorage, changeable from the console via
  // window.wfmTitle.* — see the API block at the bottom).
  // ==========================================================================

  const LS = {
    suffix: 'wfm-title-suffix',   // string appended to every title, e.g. ' · WP'
    context: 'wfm-title-context', // '1' = append date/search context, '0' = heading only
    debug: 'wfm-title-debug'
  };

  const DEFAULT_SUFFIX = '';
  const MAX_LEN = 70;
  const SEP = ' · ';

  // Long headings shortened so the useful part survives tab truncation.
  const SHORTEN = [
    [/^Work Plan Shifts Administration$/i, 'Work Plan'],
    [/^Call Center Shifts Administration$/i, 'Call Center'],
    [/^Staff Administration$/i, 'Staff'],
    [/\s+Administration$/i, '']
  ];

  // Path segment -> friendly name, used only when no <h2> is present.
  const PATH_NAMES = {
    admin_work_plan: 'Work Plan',
    work_plan: 'Work Plan Shifts',
    admin_call_center: 'Call Center',
    admin_staff: 'Staff',
    work_history: 'Work History',
    my_hours: 'My Hours',
    schedule: 'Availability',
    hrcorner: 'HR Corner',
    profile_settings: 'Settings',
    home: 'Home'
  };

  const DATE_RE = /\b(\d{4}-\d{2}-\d{2}|\d{2}[./]\d{2}[./]\d{4})\b/g;

  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (e) { /* private mode / quota — non-fatal */ }
  }

  function debug() {
    if (lsGet(LS.debug, '0') === '1') {
      console.log('[wfm-title]', ...arguments);
    }
  }

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // ==========================================================================
  // Heading + context extraction
  // ==========================================================================

  function contentRoot() {
    return document.querySelector('td.right_content') || document.body;
  }

  function headings() {
    return Array.from(contentRoot().querySelectorAll('h2'))
      .map((h) => clean(h.textContent))
      .filter(Boolean);
  }

  function shorten(heading) {
    let out = heading;
    for (const [re, replacement] of SHORTEN) {
      if (re.test(out)) {
        out = clean(out.replace(re, replacement));
        break;
      }
    }
    return out || heading;
  }

  // Turns a secondary heading into a compact context string:
  //   "All shifts for day: 30.07.2026"                  -> "30.07.2026"
  //   "Events from 2026-08-03 00:00 to 2026-08-04 ... [42]" -> "03/08 → 04/08 [42]"
  //   "Search 911 in User ID"                           -> "Search 911"
  function contextFrom(text) {
    const dates = [...new Set(text.match(DATE_RE) || [])];

    if (dates.length) {
      const parts = dates.length === 1
        ? [dates[0]]
        : [dates[0], dates[dates.length - 1]];
      let out = parts.join(' → ');
      const count = text.match(/\[(\d+)\]/);
      if (count) out += ' [' + count[1] + ']';
      return out;
    }

    if (/^Search\b/i.test(text)) {
      const term = text.match(/^Search\s+(.+?)(?:\s+in\s+.*)?$/i);
      return term ? 'Search ' + clean(term[1].replace(/<[^>]*>/g, '')) : text;
    }

    return '';
  }

  // Call Center gets its own rule: the shown date and the selected sport only,
  // read from the live filter controls (#show_date / #sport) rather than the
  // heading, so it tracks filter changes. Falls back to the heading, then URL.
  //   -> "Call Center · 2026-08-03 · Football LD"
  function callCenterContext() {
    if (!/^\/admin_call_center(\/|$)/.test(location.pathname)) return null;

    const sel = document.getElementById('sport');
    const sport = sel && sel.selectedIndex >= 0
      ? clean(sel.options[sel.selectedIndex].textContent)
      : '';

    const dateEl = document.getElementById('show_date');
    let date = dateEl ? clean(dateEl.value) : '';

    if (!date) {
      const hs = headings();
      for (let i = 1; i < hs.length && !date; i++) {
        const m = hs[i].match(DATE_RE);
        if (m) date = m[0];
      }
    }
    if (!date) date = (location.pathname.match(DATE_RE) || [])[0] || '';

    // Swap to [sport, date] here if you'd rather the sport led.
    return [date, sport].filter(Boolean).join(SEP);
  }

  // Dates straight off the URL, for pages whose heading carries no context.
  function contextFromUrl() {
    const dates = [...new Set(location.pathname.match(DATE_RE) || [])];
    if (!dates.length) return '';
    return dates.length === 1 ? dates[0] : dates[0] + ' → ' + dates[dates.length - 1];
  }

  // Fallback when the page has no <h2>: match the sidebar link for this URL,
  // otherwise prettify the first path segment.
  function fallbackName() {
    const here = location.pathname.replace(/\/+$/, '');
    let best = '';
    let bestLen = -1;

    document.querySelectorAll('td.left_content a[href]').forEach((a) => {
      let path;
      try {
        path = new URL(a.href, location.origin).pathname.replace(/\/+$/, '');
      } catch (e) {
        return;
      }
      if (!path) return;
      if ((here === path || here.startsWith(path + '/')) && path.length > bestLen) {
        bestLen = path.length;
        best = clean(a.textContent);
      }
    });
    if (best) return best;

    const seg = here.split('/').filter(Boolean)[0];
    if (!seg) return 'Home';
    if (PATH_NAMES[seg]) return PATH_NAMES[seg];
    return seg.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function buildTitle() {
    const hs = headings();
    const base = hs.length ? shorten(hs[0]) : fallbackName();

    let context = '';
    if (lsGet(LS.context, '1') === '1') {
      const cc = callCenterContext();
      if (cc !== null) {
        context = cc;
      } else {
        for (let i = 1; i < hs.length; i++) {
          context = contextFrom(hs[i]);
          if (context) break;
        }
        if (!context) context = contextFromUrl();
      }
    }

    const suffix = lsGet(LS.suffix, DEFAULT_SUFFIX);
    let title = context ? base + SEP + context : base;
    if (suffix) title += suffix;
    if (title.length > MAX_LEN) title = title.slice(0, MAX_LEN - 1).trim() + '…';

    return title || 'Workplan';
  }

  // ==========================================================================
  // Apply + keep applied across LoadPage() re-renders
  // ==========================================================================

  let lastApplied = null;

  function apply() {
    const next = buildTitle();
    if (next === lastApplied && document.title === next) return next;
    lastApplied = next;
    document.title = next;
    debug('title ->', next);
    return next;
  }

  let timer = null;
  function scheduleApply() {
    clearTimeout(timer);
    timer = setTimeout(apply, 150);
  }

  apply();

  // The site swaps content via LoadPage() innerHTML writes, so watch the
  // content cell. document.title lives in <head>, outside this subtree, so
  // our own writes can never re-trigger the observer.
  const observer = new MutationObserver(scheduleApply);
  observer.observe(contentRoot(), { childList: true, subtree: true });

  window.addEventListener('popstate', scheduleApply);
  window.addEventListener('hashchange', scheduleApply);

  // Some pages finish populating tables a beat after load.
  setTimeout(apply, 800);

  // ==========================================================================
  // Console API
  // ==========================================================================

  window.wfmTitle = {
    refresh: apply,
    preview: buildTitle,
    headings,
    setSuffix(s) {
      lsSet(LS.suffix, s == null ? '' : s);
      return apply();
    },
    setContext(on) {
      lsSet(LS.context, on ? '1' : '0');
      return apply();
    },
    setDebug(on) {
      lsSet(LS.debug, on ? '1' : '0');
      return lsGet(LS.debug, '0') === '1';
    },
    config() {
      return {
        suffix: lsGet(LS.suffix, DEFAULT_SUFFIX),
        context: lsGet(LS.context, '1') === '1',
        debug: lsGet(LS.debug, '0') === '1'
      };
    }
  };
})();
