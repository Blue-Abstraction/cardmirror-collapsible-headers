(() => {
  'use strict';

  const PLUGIN_ID = 'cardmirror-collapsible-headers';
  
  const RUNTIME_KEY = '__cardMirrorCollapsibleHeadersRuntime';

  // Hot-reload safety for CardMirror's "Load plugin from file..." workflow.
  // If an installed copy is already running, tear down its live UI/observers
  // before this development copy starts so only one triangle layer exists.
  try {
    window[RUNTIME_KEY]?.destroy?.();
  } catch (err) {
    console.warn('[Collapsible Headers] previous runtime cleanup failed:', err);
  }

const STYLE_ID = 'cardmirror-collapsible-headers-style';
  const COLLAPSE_STYLE_ID = 'cardmirror-collapsible-headers-rules';
  const ROOT_ATTR = 'data-cm-ch-root';
  const OWNED_LAYER_ATTR = 'data-cm-ch-owned';

  function quarantineLegacyRuntime() {
    /*
     * Installed pre-v1 builds cannot be truly unloaded because they never
     * exposed their listener/observer references. For local dev loading, put
     * their existing style elements into a disabled quarantine. Their old
     * closures keep references to those renamed nodes, so any later CSS writes
     * stay disabled instead of overwriting this runtime's active stylesheet.
     */
    const oldStyle = document.getElementById(STYLE_ID);
    if (oldStyle) {
      oldStyle.id = `${STYLE_ID}-legacy-disabled-${Date.now()}`;
      oldStyle.disabled = true;
    }

    const oldCollapseStyle = document.getElementById(COLLAPSE_STYLE_ID);
    if (oldCollapseStyle) {
      oldCollapseStyle.id =
        `${COLLAPSE_STYLE_ID}-legacy-disabled-${Date.now()}`;
      oldCollapseStyle.disabled = true;
    }

    /*
     * Remove whatever legacy layer is visible right now. If an old runtime
     * recreates a layer later, the active stylesheet below permanently hides
     * every .cm-collapse-layer that is not explicitly owned by this runtime.
     */
    for (const layer of document.querySelectorAll('.cm-collapse-layer')) {
      if (!(layer instanceof HTMLElement)) continue;
      if (layer.hasAttribute(OWNED_LAYER_ATTR)) continue;
      layer.remove();
    }
  }

  quarantineLegacyRuntime();
  const HEADING_SELECTOR =
    ':scope > .pmd-pocket, :scope > .pmd-hat, :scope > .pmd-block';

  const collapsedIds = new Set();
  const roots = new Map();
  const buttons = new Map();
  const visibleHeadings = new Set();

  const COLOR_OPTIONS = [
    'Automatic',
    'Red',
    'Orange',
    'Yellow',
    'Green',
    'Blue',
    'Purple',
    'Pink',
    'Gray',
  ];
  const SIZE_OPTIONS = ['Small', 'Medium', 'Large'];

  const COLOR_CSS = {
    Red: 'color-mix(in srgb, #ef4444 78%, var(--pmd-c-text, currentColor))',
    Orange: 'color-mix(in srgb, #f97316 78%, var(--pmd-c-text, currentColor))',
    Yellow: 'color-mix(in srgb, #eab308 74%, var(--pmd-c-text, currentColor))',
    Green: 'color-mix(in srgb, #22c55e 78%, var(--pmd-c-text, currentColor))',
    Blue: 'color-mix(in srgb, #3b82f6 78%, var(--pmd-c-text, currentColor))',
    Purple: 'color-mix(in srgb, #8b5cf6 78%, var(--pmd-c-text, currentColor))',
    Pink: 'color-mix(in srgb, #ec4899 78%, var(--pmd-c-text, currentColor))',
    Gray: 'color-mix(in srgb, #6b7280 72%, var(--pmd-c-text, currentColor))',
  };

  const SIZE_METRICS = {
    Small: { hit: 13, glyph: 7, gap: 2 },
    Medium: { hit: 15, glyph: 8, gap: 2 },
    Large: { hit: 20, glyph: 12, gap: 3 },
  };

  let appearance = {
    color: 'Automatic',
    size: 'Medium',
  };

  let pluginApi = null;
  let unsubscribeSettings = null;

  // Remember the last real editor location so commands still target the
  // correct pane after Search Everything takes keyboard focus.
  let lastEditorContext = null;
  let lastEditorSelectionTarget = null;
  let suppressedRevealTarget = null;
  let pendingRevealTarget = null;
  let revealQueued = false;
  let hostNavigationProbeQueued = false;
  let pendingHostNavigationSelector = '';
  let pendingHostNavigationRoot = null;

  let destroyed = false;
  const startupTimers = [];

  let nextRootToken = 1;
  let collapseStyle = null;
  let cssQueued = false;
  let layoutQueued = false;
  let layoutAllRequested = false;
  const pendingLayoutRoots = new Set();
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
    if (destroyed) return;
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        .cm-collapse-layer:not([data-cm-ch-owned]) {
          display: none !important;
        }

        .cm-collapse-layer[data-cm-ch-owned] {
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
          width: var(--cm-ch-hit-size, 15px);
          height: var(--cm-ch-hit-size, 15px);
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
          font-size: var(--cm-ch-glyph-size, 8px);
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

  function validColor(value) {
    return COLOR_OPTIONS.includes(value) ? value : 'Automatic';
  }

  function validSize(value) {
    return SIZE_OPTIONS.includes(value) ? value : 'Medium';
  }

  function bootstrapSettingsBag() {
    /*
     * CardMirror v1 currently mints CardMirrorPluginApi internally but only
     * hands it to a plugin when one of its commands runs. The official
     * settings gear can therefore exist before this bundle has received api.
     *
     * Until the first command run, read ONLY this plugin's own persisted
     * __settings bag so visual preferences are available at startup.
     * Never write the reserved bag here. Once an api arrives, api.settings
     * becomes the sole source of truth and onChanged handles live updates.
     */
    try {
      const raw = localStorage.getItem(`plugin:${PLUGIN_ID}`);
      if (!raw) return null;
      const bag = JSON.parse(raw);
      return bag && typeof bag === 'object' &&
             bag.__settings && typeof bag.__settings === 'object'
        ? bag.__settings
        : null;
    } catch (_) {
      return null;
    }
  }

  function readBootstrapAppearance() {
    const settings = bootstrapSettingsBag();
    return {
      color: validColor(settings?.triangleColor),
      size: validSize(settings?.triangleSize),
    };
  }

  function updateAllButtonAppearance() {
    for (const [heading, btn] of buttons) {
      applyButtonAppearance(heading, btn);
    }
    queueLayout();
  }

  function setAppearance(nextColor, nextSize) {
    const color = validColor(nextColor);
    const size = validSize(nextSize);
    if (appearance.color === color && appearance.size === size) return;

    appearance = { color, size };
    updateAllButtonAppearance();
  }

  function syncAppearanceFromBootstrap() {
    if (pluginApi) return;
    const next = readBootstrapAppearance();
    setAppearance(next.color, next.size);
  }

  function bindPluginApi(api) {
    if (!api?.settings) return;

    if (pluginApi !== api) {
      pluginApi = api;
      try { unsubscribeSettings?.(); } catch (_) {}
      unsubscribeSettings = api.settings.onChanged((key, value) => {
        if (key === 'triangleColor') {
          setAppearance(String(value), appearance.size);
        } else if (key === 'triangleSize') {
          setAppearance(appearance.color, String(value));
        }
      });
    }

    setAppearance(
      String(api.settings.get('triangleColor') ?? 'Automatic'),
      String(api.settings.get('triangleSize') ?? 'Medium')
    );
  }

  function onPotentialSettingsChange(event) {
    /*
     * Before the first plugin command CardMirror has not exposed the official
     * api object to this bundle yet. A select change in the host settings UI
     * is a cheap signal to reread our own bag on the next frame.
     *
     * Once bindPluginApi() has run, the official onChanged subscription owns
     * this job and this listener becomes a no-op.
     */
    if (pluginApi) return;
    if (!(event.target instanceof HTMLSelectElement)) return;
    requestAnimationFrame(syncAppearanceFromBootstrap);
  }

  function sizeMetrics() {
    return SIZE_METRICS[appearance.size] || SIZE_METRICS.Medium;
  }

  function applyButtonAppearance(heading, btn) {
    if (!(heading instanceof HTMLElement) ||
        !(btn instanceof HTMLButtonElement)) return;

    const metrics = sizeMetrics();
    btn.style.setProperty('--cm-ch-hit-size', `${metrics.hit}px`);
    btn.style.setProperty('--cm-ch-glyph-size', `${metrics.glyph}px`);

    if (appearance.color === 'Automatic') {
      btn.style.color = getComputedStyle(heading).color;
    } else {
      btn.style.color = COLOR_CSS[appearance.color] || getComputedStyle(heading).color;
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
    layer.setAttribute(OWNED_LAYER_ATTR, 'true');

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
      queueLayout(root);
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
      ? new ResizeObserver(() => queueLayout(root))
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
    if (destroyed) return;
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

      if (collapsedIds.has(id)) {
        collapsedIds.delete(id);
      } else {
        suppressRevealForCurrentSelection();
        collapsedIds.add(id);
      }

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
    applyButtonAppearance(heading, btn);
    updateButtonState(heading, btn);
    return btn;
  }

  function updateButtonState(heading, btn = buttons.get(heading)) {
    if (!(btn instanceof HTMLButtonElement)) return;
    applyButtonAppearance(heading, btn);
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
    if (destroyed) return;
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
    const metrics = sizeMetrics();
    const scroller = info.scrollParent;
    let left;
    let top;

    if (isWindowScroller(scroller)) {
      left = textRect.left + window.scrollX - metrics.hit - metrics.gap;
      top = textRect.top + window.scrollY +
        Math.max(0, (textRect.height - metrics.hit) / 2);
    } else {
      const scrollRect = scroller.getBoundingClientRect();
      left = textRect.left - scrollRect.left - scroller.clientLeft +
        scroller.scrollLeft - metrics.hit - metrics.gap;
      top = textRect.top - scrollRect.top - scroller.clientTop +
        scroller.scrollTop + Math.max(0, (textRect.height - metrics.hit) / 2);
    }

    btn.style.display = 'flex';
    btn.style.left = `${Math.round(left)}px`;
    btn.style.top = `${Math.round(top)}px`;

    // Size/manual-color appearance is updated only when settings/state change.
    // Automatic color still follows CardMirror theme/heading color, but reuse
    // the computed style we already needed for visibility instead of forcing a
    // second style read/write on every geometry pass.
    if (appearance.color === 'Automatic' &&
        btn.style.color !== headingStyle.color) {
      btn.style.color = headingStyle.color;
    }
  }

  function layoutVisibleButtons() {
    layoutQueued = false;
    if (destroyed) return;

    const layoutAll = layoutAllRequested;
    const targetRoots = layoutAll ? null : new Set(pendingLayoutRoots);
    layoutAllRequested = false;
    pendingLayoutRoots.clear();

    for (const [heading, btn] of buttons) {
      if (targetRoots && !targetRoots.has(heading.parentElement)) continue;
      placeButton(heading, btn);
    }
  }

  function queueLayout(root = null) {
    if (root instanceof HTMLElement) {
      if (!layoutAllRequested) pendingLayoutRoots.add(root);
    } else {
      // A window resize, collapse-state change, appearance change, or startup
      // pass can affect every pane. Upgrade any pending root-only pass to all.
      layoutAllRequested = true;
      pendingLayoutRoots.clear();
    }

    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(layoutVisibleButtons);
  }

  function runPostEditLayout() {
    postEditLayoutQueued = false;
    if (destroyed) return;
    const targets = [...pendingPostEditRoots];
    pendingPostEditRoots.clear();

    /*
     * CardMirror/ProseMirror may finish its DOM normalization/reflow one frame
     * after the browser's input event. Read header geometry on the SECOND
     * frame so triangles use the final Pocket/Hat/Block positions. Only lay
     * out panes that actually received the edit/reflow signal.
     */
    requestAnimationFrame(() => {
      for (const root of targets) {
        if (root.isConnected) queueLayout(root);
      }
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
    if (destroyed) return;
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

  function commandRoot() {
    if (lastEditorContext?.root instanceof HTMLElement &&
        lastEditorContext.root.isConnected) {
      return lastEditorContext.root;
    }
    return focusedRoot();
  }

  function directChildForNode(node, root) {
    if (!(root instanceof HTMLElement) || !node) return null;
    let el = node instanceof Element ? node : node.parentElement;
    if (!(el instanceof Element) || !root.contains(el)) return null;
    if (el === root) return null;

    while (el.parentElement && el.parentElement !== root) {
      el = el.parentElement;
    }
    return el.parentElement === root && el instanceof HTMLElement ? el : null;
  }

  function containingHeadingForChild(root, child) {
    if (!(root instanceof HTMLElement) || !(child instanceof HTMLElement)) {
      return null;
    }

    const children = Array.from(root.children);
    let index = children.indexOf(child);
    if (index < 0) return null;

    for (let i = index; i >= 0; i--) {
      const candidate = children[i];
      if (candidate instanceof HTMLElement && headingLevel(candidate) != null) {
        return candidate;
      }
    }
    return null;
  }

  function headingById(root, id) {
    if (!(root instanceof HTMLElement) || !id) return null;
    for (const heading of root.querySelectorAll(HEADING_SELECTOR)) {
      if (heading instanceof HTMLElement && headingId(heading) === id) {
        return heading;
      }
    }
    return null;
  }

  function liveEditorContext() {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return null;
    const node = selection.anchorNode || selection.focusNode;
    if (!node) return null;

    const anchorElement = node instanceof Element ? node : node.parentElement;
    if (!(anchorElement instanceof Element)) return null;
    const root = anchorElement.closest('.ProseMirror');
    if (!(root instanceof HTMLElement)) return null;

    const child = directChildForNode(node, root);
    const heading = containingHeadingForChild(root, child);
    return {
      root,
      child,
      sectionId: headingId(heading),
    };
  }

  function sameSelectionTarget(a, b) {
    return !!a && !!b && a.root === b.root && a.child === b.child;
  }

  function rememberEditorContext() {
    const context = liveEditorContext();
    if (context?.root instanceof HTMLElement) {
      lastEditorContext = context;
      if (context.child instanceof HTMLElement) {
        lastEditorSelectionTarget = {
          root: context.root,
          child: context.child,
        };
      }
    }
  }

  function suppressRevealForCurrentSelection() {
    const live = liveEditorContext();
    const target = live?.child instanceof HTMLElement
      ? { root: live.root, child: live.child }
      : lastEditorSelectionTarget;

    suppressedRevealTarget = target?.root instanceof HTMLElement &&
      target?.child instanceof HTMLElement
      ? target
      : null;
  }

  function currentSectionHeading() {
    const live = liveEditorContext();
    if (live?.root instanceof HTMLElement) {
      lastEditorContext = live;
      return headingById(live.root, live.sectionId);
    }

    const root = lastEditorContext?.root;
    if (!(root instanceof HTMLElement) || !root.isConnected) return null;
    return headingById(root, lastEditorContext.sectionId);
  }

  function collapsedAncestorsForTarget(root, child) {
    if (!(root instanceof HTMLElement) || !(child instanceof HTMLElement)) {
      return [];
    }

    const nearest = containingHeadingForChild(root, child);
    if (!(nearest instanceof HTMLElement)) return [];

    let path = sectionPath(root, nearest);

    // If CardMirror jumps directly to a heading, that heading itself is the
    // destination and should remain collapsed. Only hidden ancestors need to
    // open so the heading can become visible.
    if (nearest === child) {
      path = path.slice(0, -1);
    }

    return path.filter(heading => {
      const id = headingId(heading);
      return !!id && collapsedIds.has(id);
    });
  }

  function targetNeedsScroll(root, child) {
    if (!(root instanceof HTMLElement) || !(child instanceof HTMLElement)) {
      return false;
    }
    if (!child.isConnected) return false;

    const rect = child.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return true;

    const info = roots.get(root);
    const scroller = info?.scrollParent;
    const margin = 18;

    if (!scroller || isWindowScroller(scroller)) {
      return rect.top < margin ||
             rect.bottom > window.innerHeight - margin ||
             rect.left < margin ||
             rect.right > window.innerWidth - margin;
    }

    const viewport = scroller.getBoundingClientRect();
    return rect.top < viewport.top + margin ||
           rect.bottom > viewport.bottom - margin ||
           rect.left < viewport.left + margin ||
           rect.right > viewport.right - margin;
  }

  function scrollRevealedTargetIntoView(target) {
    if (destroyed) return;
    const root = target?.root;
    const child = target?.child;
    if (!(root instanceof HTMLElement) ||
        !(child instanceof HTMLElement) ||
        !root.isConnected ||
        !child.isConnected ||
        !root.contains(child)) {
      return;
    }

    if (targetNeedsScroll(root, child)) {
      try {
        child.scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: 'auto',
        });
      } catch (_) {
        try { child.scrollIntoView(); } catch (_) {}
      }
    }

    queueLayout();
  }

  function runAutoReveal() {
    revealQueued = false;
    if (destroyed) return;

    const target = pendingRevealTarget;
    pendingRevealTarget = null;

    const root = target?.root;
    const child = target?.child;
    if (!(root instanceof HTMLElement) ||
        !(child instanceof HTMLElement) ||
        !root.isConnected ||
        !child.isConnected ||
        !root.contains(child)) {
      return;
    }

    const ancestors = collapsedAncestorsForTarget(root, child);
    if (!ancestors.length) return;

    let changed = false;
    for (const heading of ancestors) {
      const id = headingId(heading);
      if (id && collapsedIds.delete(id)) changed = true;
    }
    if (!changed) return;

    // Rebuild the hiding CSS first. CardMirror may already have attempted its
    // own scroll while the destination was display:none, so after two frames
    // make one conservative visibility check and only scroll if still needed.
    commitCollapseState();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollRevealedTargetIntoView(target));
    });
  }

  function queueAutoReveal(target) {
    if (destroyed || collapsedIds.size === 0) return;
    if (!(target?.root instanceof HTMLElement) ||
        !(target?.child instanceof HTMLElement)) {
      return;
    }

    pendingRevealTarget = target;
    if (revealQueued) return;
    revealQueued = true;
    requestAnimationFrame(runAutoReveal);
  }

  function commitCollapseState() {
    queueCollapseCss();
    updateVisibleButtonStates();
    queueLayout();
  }

  function setAllInRoot(root, collapsed) {
    if (!(root instanceof HTMLElement)) return false;
    ensureRoot(root);
    if (collapsed) suppressRevealForCurrentSelection();

    let changed = false;
    // One linear scan. Do not rebuild layout/CSS once per heading.
    for (const heading of root.querySelectorAll(HEADING_SELECTOR)) {
      if (!(heading instanceof HTMLElement)) continue;
      const id = headingId(heading);
      if (!id) continue;
      if (collapsed) {
        if (!collapsedIds.has(id)) {
          collapsedIds.add(id);
          changed = true;
        }
      } else if (collapsedIds.delete(id)) {
        changed = true;
      }
    }

    if (changed) commitCollapseState();
    return changed;
  }

  function setAllInFocusedRoot(collapsed) {
    return setAllInRoot(commandRoot(), collapsed);
  }

  function setLevelInFocusedRoot(level, collapsed) {
    const root = commandRoot();
    if (!(root instanceof HTMLElement)) return false;
    ensureRoot(root);
    if (collapsed) suppressRevealForCurrentSelection();

    let changed = false;
    for (const heading of root.querySelectorAll(HEADING_SELECTOR)) {
      if (!(heading instanceof HTMLElement) || headingLevel(heading) !== level) {
        continue;
      }
      const id = headingId(heading);
      if (!id) continue;
      if (collapsed) {
        if (!collapsedIds.has(id)) {
          collapsedIds.add(id);
          changed = true;
        }
      } else if (collapsedIds.delete(id)) {
        changed = true;
      }
    }

    if (changed) commitCollapseState();
    return changed;
  }

  function toggleCurrentSection(api) {
    const heading = currentSectionHeading();
    if (!(heading instanceof HTMLElement)) {
      api?.showToast?.('Collapsible Headers: place the cursor inside a Pocket, Hat, or Block first.');
      return;
    }

    const id = headingId(heading);
    if (!id) return;
    if (collapsedIds.has(id)) {
      collapsedIds.delete(id);
    } else {
      suppressRevealForCurrentSelection();
      collapsedIds.add(id);
    }
    commitCollapseState();
  }

  function sectionPath(root, heading) {
    if (!(root instanceof HTMLElement) || !(heading instanceof HTMLElement)) {
      return [];
    }

    const children = Array.from(root.children);
    const index = children.indexOf(heading);
    const level = headingLevel(heading);
    if (index < 0 || level == null) return [];

    const path = [heading];
    let ceiling = level;
    for (let i = index - 1; i >= 0 && ceiling > 1; i--) {
      const candidate = children[i];
      if (!(candidate instanceof HTMLElement)) continue;
      const candidateLevel = headingLevel(candidate);
      if (candidateLevel != null && candidateLevel < ceiling) {
        path.push(candidate);
        ceiling = candidateLevel;
      }
    }

    return path.reverse();
  }

  function parentScopeBounds(children, headingIndex, level) {
    let start = -1;
    let end = children.length;

    for (let i = headingIndex - 1; i >= 0; i--) {
      const el = children[i];
      if (!(el instanceof HTMLElement)) continue;
      const candidateLevel = headingLevel(el);
      if (candidateLevel != null && candidateLevel < level) {
        start = i;
        break;
      }
    }

    for (let i = headingIndex + 1; i < children.length; i++) {
      const el = children[i];
      if (!(el instanceof HTMLElement)) continue;
      const candidateLevel = headingLevel(el);
      if (candidateLevel != null && candidateLevel < level) {
        end = i;
        break;
      }
    }

    return { start, end };
  }

  function focusCurrentSection(api) {
    const heading = currentSectionHeading();
    const root = heading?.parentElement;
    if (!(heading instanceof HTMLElement) ||
        !(root instanceof HTMLElement) ||
        !root.classList.contains('ProseMirror')) {
      api?.showToast?.('Collapsible Headers: place the cursor inside a Pocket, Hat, or Block first.');
      return;
    }

    const path = sectionPath(root, heading);
    if (!path.length) return;
    suppressRevealForCurrentSelection();
    const children = Array.from(root.children);
    let changed = false;

    // Focus the whole branch: at each level, expand the path heading and
    // collapse its same-level siblings inside the same parent scope.
    for (const pathHeading of path) {
      const id = headingId(pathHeading);
      const level = headingLevel(pathHeading);
      const index = children.indexOf(pathHeading);
      if (!id || level == null || index < 0) continue;

      if (collapsedIds.delete(id)) changed = true;
      const bounds = parentScopeBounds(children, index, level);

      for (let i = bounds.start + 1; i < bounds.end; i++) {
        const sibling = children[i];
        if (!(sibling instanceof HTMLElement) || sibling === pathHeading) continue;
        if (headingLevel(sibling) !== level) continue;
        const siblingId = headingId(sibling);
        if (siblingId && !collapsedIds.has(siblingId)) {
          collapsedIds.add(siblingId);
          changed = true;
        }
      }
    }

    if (changed) commitCollapseState();
    const currentLevel = headingLevel(heading);
    const name = currentLevel === 1 ? 'Pocket' : currentLevel === 2 ? 'Hat' : 'Block';
    api?.showToast?.(`Collapsible Headers: focused current ${name}.`);
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
    rememberEditorContext();

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
    const live = liveEditorContext();
    lastEditorContext = live?.root === root
      ? live
      : { root, sectionId: lastEditorContext?.root === root ? lastEditorContext.sectionId : '' };
    queueLayout(root);
  }

  function onSelectionChange() {
    const previousTarget = lastEditorSelectionTarget;
    const context = liveEditorContext();

    if (!(context?.root instanceof HTMLElement)) return;

    lastEditorContext = context;
    if (!(context.child instanceof HTMLElement)) return;

    const target = {
      root: context.root,
      child: context.child,
    };
    lastEditorSelectionTarget = target;

    // If we just collapsed the section containing the editor's own cursor,
    // don't immediately undo that action when the browser normalizes focus.
    // Once CardMirror moves selection to a different top-level child, normal
    // auto-reveal behavior resumes.
    if (suppressedRevealTarget) {
      if (sameSelectionTarget(target, suppressedRevealTarget)) return;
      suppressedRevealTarget = null;
    }

    // Selectionchange may fire several times while CardMirror/browser settles
    // one jump. Do no structural work unless the top-level destination changed.
    if (sameSelectionTarget(target, previousTarget)) return;

    queueAutoReveal(target);
  }

  function hostNavigationTarget(selector, rootHint = null) {
    if (!selector) return null;

    const candidates = [];
    const seen = new Set();
    const addRoot = root => {
      if (!(root instanceof HTMLElement) ||
          !root.isConnected ||
          seen.has(root)) return;
      seen.add(root);
      candidates.push(root);
    };

    // Find/comments act on the pane that was active immediately before their
    // UI took focus. Prefer that pane so multi-pane work stays local.
    addRoot(rootHint);
    addRoot(lastEditorContext?.root);
    for (const root of roots.keys()) addRoot(root);

    for (const root of candidates) {
      const marker = root.querySelector(selector);
      if (!(marker instanceof Element)) continue;
      const child = directChildForNode(marker, root);
      if (child instanceof HTMLElement) return { root, child };
    }

    return null;
  }

  function runHostNavigationProbe(retry = false) {
    if (destroyed) return;

    const selector = pendingHostNavigationSelector;
    const rootHint = pendingHostNavigationRoot;
    const target = hostNavigationTarget(selector, rootHint);

    if (target) {
      hostNavigationProbeQueued = false;
      pendingHostNavigationSelector = '';
      pendingHostNavigationRoot = null;
      queueAutoReveal(target);
      return;
    }

    // React/ProseMirror usually publishes the decoration before the first
    // frame, but comments can finish activation one frame later. Retry once;
    // never poll continuously on giant backfiles.
    if (!retry) {
      requestAnimationFrame(() => runHostNavigationProbe(true));
      return;
    }

    hostNavigationProbeQueued = false;
    pendingHostNavigationSelector = '';
    pendingHostNavigationRoot = null;
  }

  function queueHostNavigationProbe(selector, rootHint = null) {
    if (destroyed || collapsedIds.size === 0 || !selector) return;
    pendingHostNavigationSelector = selector;
    if (rootHint instanceof HTMLElement) pendingHostNavigationRoot = rootHint;

    if (hostNavigationProbeQueued) return;
    hostNavigationProbeQueued = true;
    requestAnimationFrame(() => runHostNavigationProbe(false));
  }

  function onHostNavigationInput(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // CardMirror Find changes ProseMirror's transaction selection while the
    // find input owns DOM focus, so browser selectionchange never tells us.
    if (target.closest('.pmd-find-bar')) {
      queueHostNavigationProbe(
        '.pmd-find-match-current',
        lastEditorContext?.root
      );
    }
  }

  function onHostNavigationKeyDown(event) {
    if (event.key !== 'Enter') return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('.pmd-find-bar')) return;

    queueHostNavigationProbe(
      '.pmd-find-match-current',
      lastEditorContext?.root
    );
  }

  function onHostNavigationClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest('.pmd-find-bar, .pmd-find-results-panel, .pmd-find-result-row')) {
      queueHostNavigationProbe(
        '.pmd-find-match-current',
        lastEditorContext?.root
      );
      return;
    }

    if (target.closest('.pmd-comment-thread')) {
      queueHostNavigationProbe(
        '.pmd-annotation-active',
        lastEditorContext?.root
      );
    }
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
        run: api => {
          bindPluginApi(api);
          setAllInFocusedRoot(true);
        },
      },
      {
        id: PLUGIN_ID + '.expand-all',
        label: 'Collapsible Headers: Expand All',
        keywords: ['expand', 'headers', 'outline', 'pocket', 'hat', 'block'],
        defaultKey: null,
        run: api => {
          bindPluginApi(api);
          setAllInFocusedRoot(false);
        },
      },
      {
        id: PLUGIN_ID + '.collapse-pockets',
        label: 'Collapsible Headers: Collapse All Pockets',
        keywords: ['collapse', 'pockets', 'level', 'outline'],
        defaultKey: null,
        run: api => {
          bindPluginApi(api);
          setLevelInFocusedRoot(1, true);
        },
      },
      {
        id: PLUGIN_ID + '.expand-pockets',
        label: 'Collapsible Headers: Expand All Pockets',
        keywords: ['expand', 'pockets', 'level', 'outline'],
        defaultKey: null,
        run: api => {
          bindPluginApi(api);
          setLevelInFocusedRoot(1, false);
        },
      },
      {
        id: PLUGIN_ID + '.collapse-hats',
        label: 'Collapsible Headers: Collapse All Hats',
        keywords: ['collapse', 'hats', 'level', 'outline'],
        defaultKey: null,
        run: api => {
          bindPluginApi(api);
          setLevelInFocusedRoot(2, true);
        },
      },
      {
        id: PLUGIN_ID + '.expand-hats',
        label: 'Collapsible Headers: Expand All Hats',
        keywords: ['expand', 'hats', 'level', 'outline'],
        defaultKey: null,
        run: api => {
          bindPluginApi(api);
          setLevelInFocusedRoot(2, false);
        },
      },
      {
        id: PLUGIN_ID + '.collapse-blocks',
        label: 'Collapsible Headers: Collapse All Blocks',
        keywords: ['collapse', 'blocks', 'level', 'outline'],
        defaultKey: null,
        run: api => {
          bindPluginApi(api);
          setLevelInFocusedRoot(3, true);
        },
      },
      {
        id: PLUGIN_ID + '.expand-blocks',
        label: 'Collapsible Headers: Expand All Blocks',
        keywords: ['expand', 'blocks', 'level', 'outline'],
        defaultKey: null,
        run: api => {
          bindPluginApi(api);
          setLevelInFocusedRoot(3, false);
        },
      },
      {
        id: PLUGIN_ID + '.toggle-current',
        label: 'Collapsible Headers: Toggle Current Section',
        keywords: ['toggle', 'current', 'section', 'cursor', 'collapse', 'expand'],
        defaultKey: null,
        run: api => {
          bindPluginApi(api);
          toggleCurrentSection(api);
        },
      },
      {
        id: PLUGIN_ID + '.focus-current',
        label: 'Collapsible Headers: Focus Current Section',
        keywords: ['focus', 'current', 'section', 'siblings', 'outline'],
        defaultKey: null,
        run: api => {
          bindPluginApi(api);
          focusCurrentSection(api);
        },
      },
    ],
    settings: [
      {
        key: 'triangleColor',
        label: 'Triangle color',
        type: 'select',
        default: 'Automatic',
        options: COLOR_OPTIONS,
        description: 'Automatic follows the heading/theme color.',
      },
      {
        key: 'triangleSize',
        label: 'Triangle size',
        type: 'select',
        default: 'Medium',
        options: SIZE_OPTIONS,
        description: 'Changes the visible triangle and its click target.',
      },
    ],
  };

  try {
    window.__registerCardMirrorPlugin?.(definition);
  } catch (err) {
    console.error('[Collapsible Headers] registration failed:', err);
  }

  function destroyRuntime() {
    if (destroyed) return;
    destroyed = true;

    try { unsubscribeSettings?.(); } catch (_) {}
    unsubscribeSettings = null;
    pluginApi = null;

    document.removeEventListener('input', onEditorInput, true);
    document.removeEventListener('change', onPotentialSettingsChange, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('selectionchange', onSelectionChange, true);
    document.removeEventListener('input', onHostNavigationInput, true);
    document.removeEventListener('keydown', onHostNavigationKeyDown, true);
    document.removeEventListener('click', onHostNavigationClick, true);
    window.removeEventListener('resize', queueLayout);

    for (const timer of startupTimers) clearTimeout(timer);
    startupTimers.length = 0;

    for (const [root, info] of roots) {
      try { info.intersection?.disconnect(); } catch (_) {}
      try { info.mutations?.disconnect(); } catch (_) {}
      try { info.resize?.disconnect(); } catch (_) {}
      try { info.layer?.remove(); } catch (_) {}
    }

    roots.clear();
    buttons.clear();
    visibleHeadings.clear();
    pendingStructureRoots.clear();
    pendingPostEditRoots.clear();
    pendingLayoutRoots.clear();
    layoutAllRequested = false;
    lastEditorContext = null;
    lastEditorSelectionTarget = null;
    suppressedRevealTarget = null;
    pendingRevealTarget = null;
    revealQueued = false;
    hostNavigationProbeQueued = false;
    pendingHostNavigationSelector = '';
    pendingHostNavigationRoot = null;

    try { document.getElementById(STYLE_ID)?.remove(); } catch (_) {}
    try { document.getElementById(COLLAPSE_STYLE_ID)?.remove(); } catch (_) {}
  }

  ensureStyles();
  const initialAppearance = readBootstrapAppearance();
  appearance = initialAppearance;
  discoverRoots();
  queueCollapseCss();
  queueLayout();

  document.addEventListener('input', onEditorInput, true);
  document.addEventListener('change', onPotentialSettingsChange, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('selectionchange', onSelectionChange, true);
  document.addEventListener('input', onHostNavigationInput, true);
  document.addEventListener('keydown', onHostNavigationKeyDown, true);
  document.addEventListener('click', onHostNavigationClick, true);
  window.addEventListener('resize', queueLayout, { passive: true });

  window[RUNTIME_KEY] = {
    destroy: destroyRuntime,
    version: '1.0.0-beta.6',
  };

  // Bounded startup discovery only. There is no permanent document-wide poll.
  for (const delay of [150, 500, 1200, 3000]) {
    startupTimers.push(setTimeout(() => {
      if (destroyed) return;
      discoverRoots();
      queueCollapseCss();
      queueLayout();
    }, delay));
  }
})();
