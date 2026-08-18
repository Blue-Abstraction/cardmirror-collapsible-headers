(() => {
  'use strict';

  const PLUGIN_ID = 'cardmirror-collapsible-headers';
  const STYLE_ID = 'cardmirror-collapsible-headers-style';
  const COLLAPSE_STYLE_ID = 'cardmirror-collapsible-headers-rules';
  const ROOT_ATTR = 'data-cm-ch-root';
  const HEADING_SELECTOR =
    ':scope > .pmd-pocket, :scope > .pmd-hat, :scope > .pmd-block';

  const collapsedIds = new Set();
  const roots = new Map();
  const buttons = new Map();
  const visibleHeadings = new Set();

  let nextRootToken = 1;
  let collapseStyle = null;
  let cssQueued = false;
  let layoutQueued = false;
  let postEditLayoutQueued = false;
  let structureQueued = false;
  const pendingStructureRoots = new Set();
  const pendingPostEditRoots = new Set();

  function headingLevel(el) {
    if (!(el instanceof HTMLElement)) return null;
    if (el.classList.contains('pmd-pocket')) return 1;
    if (el.classList.contains('pmd-hat')) return 2;
    if (el.classList.contains('pmd-block')) return 3;
    return null;
  }

  function headingId(el) {
    return el instanceof HTMLElement
      ? (el.getAttribute('data-id') || '').trim()
      : '';
  }

  function ensureStyles() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        .cm-collapse-layer {
          position: absolute;
          left: 0;
          top: 0;
          width: 100%;
          height: 0;
          z-index: 80;
          pointer-events: none;
          overflow: visible;
        }

        .cm-collapse-toggle {
          position: absolute;
          width: 15px;
          height: 15px;
          padding: 0;
          margin: 0;
          border: 0;
          background: transparent;
          color: currentColor;
          opacity: .62;
          pointer-events: auto;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: system-ui, sans-serif;
          font-size: 8px;
          font-weight: 800;
          line-height: 1;
          border-radius: 3px;
          user-select: none;
          -webkit-user-select: none;
        }

        .cm-collapse-toggle:hover {
          opacity: 1;
          background: color-mix(in srgb, currentColor 10%, transparent);
        }

        .cm-collapse-toggle:focus-visible {
          outline: 1px solid currentColor;
          outline-offset: 1px;
        }
      `;
      document.head.appendChild(style);
    }

    collapseStyle = document.getElementById(COLLAPSE_STYLE_ID);
    if (!collapseStyle) {
      collapseStyle = document.createElement('style');
      collapseStyle.id = COLLAPSE_STYLE_ID;
      document.head.appendChild(collapseStyle);
    }
  }

  function cssString(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
  }

  function isWindowScroller(el) {
    return el === document.documentElement ||
           el === document.body ||
           el === document.scrollingElement;
  }

  function scrollParentFor(root) {
    let node = root.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const overflowY = style.overflowY;
      if (/(auto|scroll|overlay)/.test(overflowY)) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function ensureLayerFor(root) {
    const scrollParent = scrollParentFor(root);
    let info = roots.get(root);

    if (
      info &&
      info.scrollParent === scrollParent &&
      info.layer?.isConnected
    ) {
      return info;
    }

    if (info) {
      try { info.intersection?.disconnect(); } catch (_) {}
      try { info.mutations?.disconnect(); } catch (_) {}
      try { info.resize?.disconnect(); } catch (_) {}
      info.layer?.remove();
    }

    const token = root.getAttribute(ROOT_ATTR) || `r${nextRootToken++}`;
    root.setAttribute(ROOT_ATTR, token);

    const layer = document.createElement('div');
    layer.className = 'cm-collapse-layer';
    layer.dataset.cmChFor = token;

    if (isWindowScroller(scrollParent)) {
      document.body.appendChild(layer);
    } else {
      const parentStyle = getComputedStyle(scrollParent);
      if (parentStyle.position === 'static') {
        scrollParent.style.position = 'relative';
      }
      scrollParent.appendChild(layer);
    }

    const intersectionRoot = isWindowScroller(scrollParent)
      ? null
      : scrollParent;

    const intersection = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const heading = entry.target;
        if (!(heading instanceof HTMLElement)) continue;

        if (entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0) {
          visibleHeadings.add(heading);
          ensureButton(heading);
        } else {
          visibleHeadings.delete(heading);
          removeButton(heading);
        }
      }
      queueLayout();
    }, {
      root: intersectionRoot,
      rootMargin: '120px 80px 120px 80px',
      threshold: 0,
    });

    // Top-level child changes are structural (Enter/split/merge/style-node
    // replacement). Ordinary text typing does NOT fire this observer.
    const mutations = new MutationObserver(records => {
      if (records.some(record => record.type === 'childList')) {
        queueStructureRefresh(root);
      }
    });
    mutations.observe(root, { childList: true });

    /*
     * Text edits that add/remove wrapped lines change the editor's geometry
     * without changing its top-level child list. ResizeObserver gives us a
     * cheap post-layout signal for those reflows. It does NOT rescan headings
     * or rebuild collapse CSS; it only repositions already-materialized
     * triangle buttons.
     */
    const resize = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => queueLayout())
      : null;
    try { resize?.observe(root); } catch (_) {}

    info = {
      token,
      root,
      scrollParent,
      layer,
      intersection,
      mutations,
      resize,
      headings: new Set(),
    };
    roots.set(root, info);
    return info;
  }

  function discoverRoots() {
    for (const root of document.querySelectorAll('.ProseMirror')) {
      if (root instanceof HTMLElement) ensureRoot(root);
    }

    for (const [root, info] of [...roots]) {
      if (!root.isConnected) {
        try { info.intersection.disconnect(); } catch (_) {}
        try { info.mutations.disconnect(); } catch (_) {}
        try { info.resize?.disconnect(); } catch (_) {}
        info.layer.remove();
        roots.delete(root);
      }
    }
  }

  function headingsIn(root) {
    return Array.from(root.querySelectorAll(HEADING_SELECTOR))
      .filter(el => el instanceof HTMLElement && headingId(el));
  }

  function syncRootHeadings(root) {
    const info = ensureLayerFor(root);
    const next = new Set(headingsIn(root));

    for (const oldHeading of info.headings) {
      if (!next.has(oldHeading)) {
        try { info.intersection.unobserve(oldHeading); } catch (_) {}
        visibleHeadings.delete(oldHeading);
        removeButton(oldHeading);
      }
    }

    for (const heading of next) {
      if (!info.headings.has(heading)) {
        info.intersection.observe(heading);
      }
    }

    info.headings = next;
  }

  function ensureRoot(root) {
    if (!(root instanceof HTMLElement) || !root.classList.contains('ProseMirror')) {
      return null;
    }
    const info = ensureLayerFor(root);
    if (info.headings.size === 0) syncRootHeadings(root);
    return info;
  }

  function removeButton(heading) {
    const btn = buttons.get(heading);
    if (btn) btn.remove();
    buttons.delete(heading);
  }

  function createButton(heading) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-collapse-toggle';
    btn.tabIndex = -1;

    btn.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();

      const id = headingId(heading);
      if (!id) return;

      if (collapsedIds.has(id)) collapsedIds.delete(id);
      else collapsedIds.add(id);

      queueCollapseCss();
      updateVisibleButtonStates();
      queueLayout();
    });

    return btn;
  }

  function ensureButton(heading) {
    let btn = buttons.get(heading);
    if (btn) return btn;

    const root = heading.parentElement;
    const info = root instanceof HTMLElement ? roots.get(root) : null;
    if (!info) return null;

    btn = createButton(heading);
    buttons.set(heading, btn);
    info.layer.appendChild(btn);
    updateButtonState(heading, btn);
    return btn;
  }

  function updateButtonState(heading, btn = buttons.get(heading)) {
    if (!(btn instanceof HTMLButtonElement)) return;
    const id = headingId(heading);
    const collapsed = !!id && collapsedIds.has(id);
    btn.textContent = collapsed ? '▶' : '▼';
    btn.title = collapsed ? 'Expand section' : 'Collapse section';
    btn.setAttribute('aria-label', btn.title);
  }

  function updateVisibleButtonStates() {
    for (const heading of visibleHeadings) {
      updateButtonState(heading);
    }
  }

  function emitCollapsedRule(rules, info, startIndex, endIndexExclusive) {
    if (endIndexExclusive <= startIndex + 1) return;

    const firstHidden = startIndex + 2; // nth-child is 1-based
    const lastHidden = endIndexExclusive;
    const token = cssString(info.token);

    rules.push(
      `.ProseMirror[${ROOT_ATTR}="${token}"]` +
      ` > :nth-child(n+${firstHidden}):nth-child(-n+${lastHidden})` +
      `{display:none !important;}`
    );
  }

  function buildRulesForRoot(info, rules) {
    const children = Array.from(info.root.children)
      .filter(el => el instanceof HTMLElement);

    let active = null;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const level = headingLevel(child);

      if (active) {
        // The first same-or-higher heading ends the currently collapsed section.
        if (level != null && level <= active.level) {
          emitCollapsedRule(rules, info, active.startIndex, i);
          active = null;
          // Process this boundary heading below; it may itself be collapsed.
        } else {
          // Everything inside an already-collapsed section is hidden. Nested
          // collapsed rules are redundant until the ancestor expands.
          continue;
        }
      }

      if (level != null) {
        const id = headingId(child);
        if (id && collapsedIds.has(id)) {
          active = { level, startIndex: i };
        }
      }
    }

    if (active) {
      emitCollapsedRule(rules, info, active.startIndex, children.length);
    }
  }

  function rebuildCollapseCss() {
    cssQueued = false;
    ensureStyles();
    discoverRoots();

    const rules = [];
    for (const info of roots.values()) {
      if (!info.root.isConnected) continue;
      buildRulesForRoot(info, rules);
    }
    collapseStyle.textContent = rules.join('\n');

    // CSS visibility changed. Reposition only the small set of currently
    // materialized buttons; IntersectionObserver removes newly hidden ones.
    requestAnimationFrame(() => {
      updateVisibleButtonStates();
      queueLayout();
    });
  }

  function queueCollapseCss() {
    if (cssQueued) return;
    cssQueued = true;
    requestAnimationFrame(rebuildCollapseCss);
  }

  function firstTextRect(heading) {
    const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
      if ((node.nodeValue || '').trim()) {
        try {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = Array.from(range.getClientRects())
            .filter(r => r.width > 0 && r.height > 0);
          range.detach?.();
          if (rects.length) return rects[0];
        } catch (_) {}
      }
      node = walker.nextNode();
    }

    const rect = heading.getBoundingClientRect();
    return {
      left: rect.left + rect.width / 2,
      top: rect.top,
      bottom: rect.bottom,
      width: 0,
      height: rect.height,
    };
  }

  function placeButton(heading, btn) {
    const root = heading.parentElement;
    const info = root instanceof HTMLElement ? roots.get(root) : null;
    if (!info || !heading.isConnected || !btn.isConnected) return;

    const headingStyle = getComputedStyle(heading);
    const headingRect = heading.getBoundingClientRect();

    if (
      headingStyle.display === 'none' ||
      headingStyle.visibility === 'hidden' ||
      headingRect.width <= 0 ||
      headingRect.height <= 0
    ) {
      btn.style.display = 'none';
      return;
    }

    const textRect = firstTextRect(heading);
    const scroller = info.scrollParent;
    let left;
    let top;

    if (isWindowScroller(scroller)) {
      left = textRect.left + window.scrollX - 17;
      top = textRect.top + window.scrollY +
        Math.max(0, (textRect.height - 15) / 2);
    } else {
      const scrollRect = scroller.getBoundingClientRect();
      left = textRect.left - scrollRect.left - scroller.clientLeft +
        scroller.scrollLeft - 17;
      top = textRect.top - scrollRect.top - scroller.clientTop +
        scroller.scrollTop + Math.max(0, (textRect.height - 15) / 2);
    }

    btn.style.display = 'flex';
    btn.style.left = `${Math.round(left)}px`;
    btn.style.top = `${Math.round(top)}px`;
    btn.style.color = headingStyle.color;
  }

  function layoutVisibleButtons() {
    layoutQueued = false;
    for (const [heading, btn] of buttons) {
      placeButton(heading, btn);
    }
  }

  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(layoutVisibleButtons);
  }

  function runPostEditLayout() {
    postEditLayoutQueued = false;
    pendingPostEditRoots.clear();

    /*
     * CardMirror/ProseMirror may finish its DOM normalization/reflow one frame
     * after the browser's input event. Read header geometry on the SECOND
     * frame so triangles use the final Pocket/Hat/Block positions.
     */
    requestAnimationFrame(() => {
      queueLayout();
    });
  }

  function queuePostEditLayout(root) {
    if (root instanceof HTMLElement) pendingPostEditRoots.add(root);
    if (postEditLayoutQueued) return;

    postEditLayoutQueued = true;
    requestAnimationFrame(runPostEditLayout);
  }

  function runStructureRefresh() {
    structureQueued = false;
    const targets = [...pendingStructureRoots];
    pendingStructureRoots.clear();

    for (const root of targets) {
      if (root.isConnected) syncRootHeadings(root);
    }

    queueCollapseCss();
    queueLayout();
  }

  function queueStructureRefresh(root) {
    if (root instanceof HTMLElement) pendingStructureRoots.add(root);
    if (structureQueued) return;
    structureQueued = true;
    requestAnimationFrame(runStructureRefresh);
  }

  function focusedRoot() {
    const active = document.activeElement;
    if (active instanceof Element) {
      const root = active.closest('.ProseMirror');
      if (root instanceof HTMLElement) return root;
    }

    return Array.from(document.querySelectorAll('.ProseMirror'))
      .find(el => {
        if (!(el instanceof HTMLElement)) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return cs.display !== 'none' &&
               cs.visibility !== 'hidden' &&
               r.width > 0 &&
               r.height > 0;
      }) || null;
  }

  function setAllInFocusedRoot(collapsed) {
    const root = focusedRoot();
    if (!(root instanceof HTMLElement)) return;

    ensureRoot(root);

    // One linear scan. Do not rebuild layout/CSS once per heading.
    for (const heading of root.querySelectorAll(HEADING_SELECTOR)) {
      if (!(heading instanceof HTMLElement)) continue;
      const id = headingId(heading);
      if (!id) continue;
      if (collapsed) collapsedIds.add(id);
      else collapsedIds.delete(id);
    }

    queueCollapseCss();
    updateVisibleButtonStates();
  }

  function editorRootFromEvent(event) {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    const root = target.closest('.ProseMirror');
    return root instanceof HTMLElement ? root : null;
  }

  function onEditorInput(event) {
    const root = editorRootFromEvent(event);
    if (!root) return; // Smart Search / dialogs / settings: zero plugin work.

    ensureRoot(root);

    /*
     * Typing can change line wrapping/paragraph height above a heading.
     * Do NOT rescan the document or rebuild collapse CSS. Just wait until
     * ProseMirror has finished the edit/reflow, then reread the geometry of
     * the already-visible headings.
     */
    queuePostEditLayout(root);
  }

  function onFocusIn(event) {
    const root = editorRootFromEvent(event);
    if (!root) return;
    ensureRoot(root);
    queueLayout();
  }

  const definition = {
    id: PLUGIN_ID,
    name: 'Collapsible Headers',
    apiVersion: 1,
    commands: [
      {
        id: PLUGIN_ID + '.collapse-all',
        label: 'Collapsible Headers: Collapse All',
        keywords: ['collapse', 'headers', 'outline', 'pocket', 'hat', 'block'],
        defaultKey: null,
        run: () => setAllInFocusedRoot(true),
      },
      {
        id: PLUGIN_ID + '.expand-all',
        label: 'Collapsible Headers: Expand All',
        keywords: ['expand', 'headers', 'outline', 'pocket', 'hat', 'block'],
        defaultKey: null,
        run: () => setAllInFocusedRoot(false),
      },
    ],
    settings: [],
  };

  try {
    window.__registerCardMirrorPlugin?.(definition);
  } catch (err) {
    console.error('[Collapsible Headers] registration failed:', err);
  }

  ensureStyles();
  discoverRoots();
  queueCollapseCss();
  queueLayout();

  document.addEventListener('input', onEditorInput, true);
  document.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('resize', queueLayout, { passive: true });

  // Bounded startup discovery only. There is no permanent document-wide poll.
  for (const delay of [150, 500, 1200, 3000]) {
    setTimeout(() => {
      discoverRoots();
      queueCollapseCss();
      queueLayout();
    }, delay);
  }
})();
