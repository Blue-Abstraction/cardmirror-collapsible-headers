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
  const TRIANGLE_SIZE_MIN = 6;
  const TRIANGLE_SIZE_MAX = 16;
  const TRIANGLE_SIZE_DEFAULT = 8;
  const DRAG_HIDDEN_ATTR = 'data-cm-ch-drag-hidden';

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

  let appearance = {
    color: 'Automatic',
    size: TRIANGLE_SIZE_DEFAULT,
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
  let collapseAllRequested = false;
  const pendingCollapseRoots = new Set();
  let layoutQueued = false;
  let layoutAllRequested = false;
  const pendingLayoutRoots = new Set();
  let postEditLayoutQueued = false;
  let structureQueued = false;
  const pendingStructureRoots = new Set();
  const pendingPostEditRoots = new Set();

  const RIGHT_DRAG_THRESHOLD_PX = 6;
  let pendingTriangleRightDrag = null;
  let triangleDragProxyActive = false;
  let triangleDragProxyRoot = null;
  let triangleDragSourceId = '';
  let triangleDragSourceLevel = null;
  let triangleDragLastPointer = null;
  let triangleDragCancelled = false;
  let triangleDragPhysicalButtonMask = 0;
  let triangleDragSuppressContextUntil = 0;
  let triangleDragSettlingRoot = null;
  let triangleDragViewportSnapshot = null;
  let dragMaskRefreshQueued = false;
  let reorderIndicator = null;
  let reorderAutoScrollRaf = 0;
  let reorderAutoScrollVelocity = 0;
  const proxiedDragEvents = new WeakSet();
  let themeObserver = null;

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

        .cm-collapse-toggle.cm-ch-dragging {
          opacity: 1;
          cursor: grabbing;
          background: color-mix(in srgb, currentColor 16%, transparent);
        }

        .cm-ch-reorder-indicator {
          position: fixed;
          height: 2px;
          border-radius: 999px;
          background: currentColor;
          opacity: .72;
          pointer-events: none;
          z-index: 2147483000;
          box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 12%, transparent);
        }

        .ProseMirror > [${DRAG_HIDDEN_ATTR}] {
          display: none !important;
        }

        .cm-ch-size-stepper {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }

        .cm-ch-size-stepper > button {
          min-width: 26px;
          height: 26px;
          padding: 0 6px;
          border-radius: 5px;
          line-height: 1;
        }

        .cm-ch-size-stepper > input[type="number"] {
          width: 52px !important;
          text-align: center;
          appearance: textfield;
          -moz-appearance: textfield;
        }

        .cm-ch-size-stepper > input[type="number"]::-webkit-inner-spin-button,
        .cm-ch-size-stepper > input[type="number"]::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
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

  function ensureThemeObserver() {
    if (themeObserver || typeof MutationObserver !== 'function') return;
    const targets = [document.documentElement, document.body].filter(Boolean);
    if (!targets.length) return;

    themeObserver = new MutationObserver(() => {
      if (destroyed || appearance.color !== 'Automatic') return;
      updateAllButtonAppearance();
    });
    for (const target of targets) {
      try {
        themeObserver.observe(target, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme'],
        });
      } catch (_) {}
    }
  }

  function validColor(value) {
    return COLOR_OPTIONS.includes(value) ? value : 'Automatic';
  }

  function validSize(value) {
    if (value === 'Small') return 7;
    if (value === 'Medium') return 8;
    if (value === 'Large') return 12;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return TRIANGLE_SIZE_DEFAULT;
    return Math.max(TRIANGLE_SIZE_MIN, Math.min(TRIANGLE_SIZE_MAX, Math.round(numeric)));
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
          setAppearance(appearance.color, value);
        }
      });
    }

    setAppearance(
      String(api.settings.get('triangleColor') ?? 'Automatic'),
      api.settings.get('triangleSize') ?? TRIANGLE_SIZE_DEFAULT
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
    if (!(event.target instanceof HTMLSelectElement) &&
        !(event.target instanceof HTMLInputElement)) return;
    requestAnimationFrame(() => {
      syncAppearanceFromBootstrap();
      enhanceTriangleSizeSetting();
    });
  }

  function sizeMetrics() {
    const glyph = validSize(appearance.size);
    return {
      glyph,
      hit: Math.max(12, Math.round(glyph * 1.5 + 3)),
      gap: glyph >= 11 ? 3 : 2,
    };
  }

  function setNativeNumberInputValue(input, value) {
    if (!(input instanceof HTMLInputElement)) return;
    const next = String(validSize(value));
    if (input.value === next) return;
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function enhanceTriangleSizeSetting() {
    if (destroyed) return;
    const inputs = document.querySelectorAll('input[type="number"]');
    for (const input of inputs) {
      if (!(input instanceof HTMLInputElement) || input.dataset.cmChSizeEnhanced === '1') continue;
      let container = input.parentElement;
      let depth = 0;
      while (container && depth < 5 && !/Triangle size/i.test(container.textContent || '')) {
        container = container.parentElement;
        depth += 1;
      }
      if (!(container instanceof HTMLElement) || !/Triangle size/i.test(container.textContent || '')) continue;

      input.dataset.cmChSizeEnhanced = '1';
      input.min = String(TRIANGLE_SIZE_MIN);
      input.max = String(TRIANGLE_SIZE_MAX);
      input.step = '1';
      const bounded = validSize(input.value || TRIANGLE_SIZE_DEFAULT);
      if (String(bounded) !== input.value) setNativeNumberInputValue(input, bounded);

      const parent = input.parentElement;
      if (!(parent instanceof HTMLElement)) continue;
      const wrapper = document.createElement('span');
      wrapper.className = 'cm-ch-size-stepper';
      parent.insertBefore(wrapper, input);
      wrapper.appendChild(input);

      const down = document.createElement('button');
      down.type = 'button';
      down.textContent = '▼';
      down.title = `Decrease triangle size (minimum ${TRIANGLE_SIZE_MIN})`;
      down.setAttribute('aria-label', down.title);

      const up = document.createElement('button');
      up.type = 'button';
      up.textContent = '▲';
      up.title = `Increase triangle size (maximum ${TRIANGLE_SIZE_MAX})`;
      up.setAttribute('aria-label', up.title);

      down.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        setNativeNumberInputValue(input, Number(input.value) - 1);
      });
      up.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        setNativeNumberInputValue(input, Number(input.value) + 1);
      });
      input.addEventListener('change', () => {
        const clamped = validSize(input.value);
        if (String(clamped) !== input.value) setNativeNumberInputValue(input, clamped);
      });

      wrapper.insertBefore(down, input);
      wrapper.appendChild(up);
    }
  }

  function queueEnhanceTriangleSizeSetting() {
    requestAnimationFrame(() => {
      enhanceTriangleSizeSetting();
      requestAnimationFrame(enhanceTriangleSizeSetting);
    });
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
      for (const observer of info.headingMutationObservers?.values?.() || []) {
        try { observer.disconnect(); } catch (_) {}
      }
      info.headingMutationObservers?.clear?.();
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
          const current = roots.get(root);
          try { current?.resize?.observe(heading); } catch (_) {}
          try { current?.observeHeadingMutations?.(heading); } catch (_) {}
          ensureButton(heading);
        } else {
          visibleHeadings.delete(heading);
          const current = roots.get(root);
          try { current?.resize?.unobserve(heading); } catch (_) {}
          try { current?.unobserveHeadingMutations?.(heading); } catch (_) {}
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
        const current = roots.get(root);
        if (current) current.structureDirty = true;
        // CardMirror can make several transient top-level DOM changes while its
        // a triangle reorder sequence is active. Rebuilding our entire heading index
        // between individual native Move Container transactions is wasted work.
        // Coalesce it to the final settled structure instead.
        if ((triangleDragProxyActive && triangleDragProxyRoot === root) ||
            triangleDragSettlingRoot === root) {
          // Reorder is committed as a short sequence of native Move Container
          // operations. The intermediate structures are never useful to us;
          // rebuild once after the sequence completes.
        } else {
          queueStructureRefresh(root);
        }
      }
    });
    mutations.observe(root, { childList: true });

    // Heading-only style/inline-structure changes (font size, bold wrappers,
    // etc.) can move the first glyph without resizing the editor root. Track
    // ONLY headings near the viewport. Attaching an observer to every heading
    // in a tournament master file made first-open/navigation unnecessarily
    // expensive even though offscreen headings cannot currently be edited.
    const headingMutationObservers = new Map();

    const observeHeadingMutations = heading => {
      if (!(heading instanceof HTMLElement) || headingMutationObservers.has(heading)) return;
      const observer = new MutationObserver(records => {
        if (triangleDragProxyActive && triangleDragProxyRoot === root) return;

        if (appearance.color === 'Automatic') {
          const btn = buttons.get(heading);
          if (btn) applyButtonAppearance(heading, btn);
        }
        queueLayout(root);
      });
      try {
        observer.observe(heading, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['class', 'style'],
        });
        headingMutationObservers.set(heading, observer);
      } catch (_) {
        try { observer.disconnect(); } catch (_) {}
      }
    };

    const unobserveHeadingMutations = heading => {
      const observer = headingMutationObservers.get(heading);
      if (!observer) return;
      try { observer.disconnect(); } catch (_) {}
      headingMutationObservers.delete(heading);
    };

    /*
     * Text edits that add/remove wrapped lines change the editor's geometry
     * without changing its top-level child list. ResizeObserver gives us a
     * cheap post-layout signal for those reflows. It does NOT rescan headings
     * or rebuild collapse CSS; it only repositions already-materialized
     * triangle buttons.
     */
    const resize = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (triangleDragProxyActive && triangleDragProxyRoot === root) return;
          queueLayout(root);
        })
      : null;
    try { resize?.observe(root); } catch (_) {}

    info = {
      token,
      root,
      scrollParent,
      layer,
      intersection,
      mutations,
      headingMutationObservers,
      observeHeadingMutations,
      unobserveHeadingMutations,
      resize,
      headings: new Set(),
      entries: [],
      entryByHeading: new Map(),
      entryById: new Map(),
      entryIndexByHeading: new Map(),
      collapseRulesText: '',
      structureReady: false,
      structureDirty: false,
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
        for (const observer of info.headingMutationObservers?.values?.() || []) {
        try { observer.disconnect(); } catch (_) {}
      }
      info.headingMutationObservers?.clear?.();
        try { info.resize?.disconnect(); } catch (_) {}
        info.layer.remove();
        roots.delete(root);
      }
    }
  }

  function buildRootStructure(info) {
    const entries = [];
    const stack = [];
    const children = info.root.children;
    const ownerHeadingByChild = new WeakMap();
    let nearestHeading = null;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!(child instanceof HTMLElement)) continue;
      const level = headingLevel(child);
      const id = headingId(child);

      if (level != null && id) {
        while (stack.length && stack[stack.length - 1].level >= level) {
          stack.pop().endIndexExclusive = i;
        }

        const entry = {
          heading: child,
          id,
          level,
          startIndex: i,
          endIndexExclusive: children.length,
          // The outline depth is at most three. Recording the path once makes
          // auto-reveal/focus navigation O(depth) instead of walking backward
          // through every preceding heading on large backfiles.
          ancestorHeadings: stack.map(parent => parent.heading),
        };
        entries.push(entry);
        stack.push(entry);
        nearestHeading = child;
      }

      if (nearestHeading instanceof HTMLElement) {
        ownerHeadingByChild.set(child, nearestHeading);
      }
    }

    for (const entry of stack) entry.endIndexExclusive = children.length;
    info.entries = entries;
    info.ownerHeadingByChild = ownerHeadingByChild;
    info.structureReady = true;
    info.structureDirty = false;
    info.entryByHeading = new Map(entries.map(entry => [entry.heading, entry]));
    info.entryById = new Map(entries.map(entry => [entry.id, entry]));
    info.entryIndexByHeading = new Map(entries.map((entry, index) => [entry.heading, index]));
    return entries;
  }

  function syncRootHeadings(root) {
    const info = ensureLayerFor(root);
    const entries = buildRootStructure(info);
    const next = new Set(entries.map(entry => entry.heading));

    for (const oldHeading of info.headings) {
      if (!next.has(oldHeading)) {
        try { info.intersection.unobserve(oldHeading); } catch (_) {}
        try { info.resize?.unobserve(oldHeading); } catch (_) {}
        try { info.unobserveHeadingMutations?.(oldHeading); } catch (_) {}
        visibleHeadings.delete(oldHeading);
        removeButton(oldHeading);
      }
    }

    for (const heading of next) {
      if (!info.headings.has(heading)) {
        info.intersection.observe(heading);
        // Per-heading resize tracking is enabled by IntersectionObserver only
        // while the heading is near the viewport. Observing every heading on a
        // giant backfile makes browser layout work scale with the whole file.
      }
    }

    info.headings = next;
    queueCollapseCss(root);
  }

  function ensureRoot(root) {
    if (!(root instanceof HTMLElement) || !root.classList.contains('ProseMirror')) {
      return null;
    }
    const info = ensureLayerFor(root);
    if (!info.structureReady || info.structureDirty) syncRootHeadings(root);
    return info;
  }

  function removeButton(heading) {
    const btn = buttons.get(heading);
    if (btn) btn.remove();
    buttons.delete(heading);
  }

  function isMacPlatform() {
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    return /Mac/i.test(platform);
  }

  function clearDragVisibilityMask(root) {
    if (!(root instanceof HTMLElement)) return;
    for (const child of root.children) {
      if (child instanceof HTMLElement) child.removeAttribute(DRAG_HIDDEN_ATTR);
    }
  }

  function refreshDragVisibilityMask(root) {
    if (!(root instanceof HTMLElement) || !root.isConnected) return;
    clearDragVisibilityMask(root);

    const children = Array.from(root.children).filter(child => child instanceof HTMLElement);
    const entries = [];
    const stack = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const level = headingLevel(child);
      const id = headingId(child);
      if (level == null || !id) continue;
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop().endIndexExclusive = i;
      }
      const entry = { id, level, startIndex: i, endIndexExclusive: children.length };
      entries.push(entry);
      stack.push(entry);
    }
    for (const entry of stack) entry.endIndexExclusive = children.length;

    let hiddenUntil = -1;
    for (const entry of entries) {
      if (entry.startIndex < hiddenUntil || !collapsedIds.has(entry.id)) continue;
      for (let i = entry.startIndex + 1; i < entry.endIndexExclusive; i++) {
        children[i]?.setAttribute?.(DRAG_HIDDEN_ATTR, '');
      }
      hiddenUntil = entry.endIndexExclusive;
    }
  }

  function queueDragVisibilityMask(root) {
    if (dragMaskRefreshQueued) return;
    dragMaskRefreshQueued = true;
    queueMicrotask(() => {
      dragMaskRefreshQueued = false;
      if (root === triangleDragProxyRoot || root === triangleDragSettlingRoot) {
        refreshDragVisibilityMask(root);
      }
    });
  }

  function captureViewportSnapshot(root) {
    if (!(root instanceof HTMLElement)) return null;
    const info = roots.get(root);
    const scroller = info?.scrollParent || scrollParentFor(root);
    if (!scroller || isWindowScroller(scroller)) {
      return { root, windowScroll: true, x: window.scrollX, y: window.scrollY };
    }
    return {
      root,
      windowScroll: false,
      scroller,
      x: scroller.scrollLeft,
      y: scroller.scrollTop,
    };
  }

  function restoreViewportSnapshot(snapshot = triangleDragViewportSnapshot) {
    if (!snapshot) return;
    try {
      if (snapshot.windowScroll) {
        window.scrollTo(snapshot.x, snapshot.y);
      } else if (snapshot.scroller?.isConnected) {
        snapshot.scroller.scrollLeft = snapshot.x;
        snapshot.scroller.scrollTop = snapshot.y;
      }
    } catch (_) {}
  }

  function finalizeTriangleDragSettling(root) {
    if (!(root instanceof HTMLElement) || !root.isConnected) {
      if (root instanceof HTMLElement) clearDragVisibilityMask(root);
      triangleDragSettlingRoot = null;
      triangleDragViewportSnapshot = null;
      return;
    }
    const info = roots.get(root);
    if (info) {
      info.structureDirty = true;
      syncRootHeadings(root);
    } else {
      queueCollapseCss(root);
    }

    requestAnimationFrame(() => {
      restoreViewportSnapshot();
      requestAnimationFrame(() => {
        restoreViewportSnapshot();
        clearDragVisibilityMask(root);
        triangleDragSettlingRoot = null;
        triangleDragViewportSnapshot = null;
        queueLayout(root);
      });
    });
  }

  function sameLevelHeadings(root, level) {
    if (!(root instanceof HTMLElement) || level == null) return [];
    const info = ensureRoot(root);
    if (!info) return [];
    return info.entries
      .filter(entry => entry.level === level && entry.heading?.isConnected)
      .map(entry => entry.heading);
  }

  function clearReorderIndicator() {
    try { reorderIndicator?.remove(); } catch (_) {}
    reorderIndicator = null;
  }

  function ensureReorderIndicator() {
    if (reorderIndicator?.isConnected) return reorderIndicator;
    const line = document.createElement('div');
    line.className = 'cm-ch-reorder-indicator';
    document.body.appendChild(line);
    reorderIndicator = line;
    return line;
  }

  function reorderInsertionForPointer(root, source, level, pointerY) {
    const peers = sameLevelHeadings(root, level);
    const sourceIndex = peers.indexOf(source);
    if (sourceIndex < 0) return null;
    const others = peers.filter(heading => heading !== source);
    let insertion = others.length;
    for (let i = 0; i < others.length; i++) {
      const rect = others[i].getBoundingClientRect();
      if (pointerY < rect.top + rect.height / 2) {
        insertion = i;
        break;
      }
    }
    return { peers, others, sourceIndex, desiredIndex: insertion };
  }

  function updateReorderIndicator(root, sourceId, level, clientY) {
    if (!(root instanceof HTMLElement) || !sourceId || level == null) return;
    const source = headingById(root, sourceId);
    if (!(source instanceof HTMLElement)) return;
    const placement = reorderInsertionForPointer(root, source, level, clientY);
    if (!placement) return;
    const { others, desiredIndex } = placement;
    const rootRect = root.getBoundingClientRect();
    let top;
    if (!others.length) {
      top = source.getBoundingClientRect().top;
    } else if (desiredIndex <= 0) {
      top = others[0].getBoundingClientRect().top;
    } else if (desiredIndex >= others.length) {
      top = others[others.length - 1].getBoundingClientRect().bottom;
    } else {
      top = others[desiredIndex].getBoundingClientRect().top;
    }
    const line = ensureReorderIndicator();
    line.style.left = `${Math.max(0, rootRect.left + 4)}px`;
    line.style.width = `${Math.max(24, rootRect.width - 8)}px`;
    line.style.top = `${Math.round(top - 1)}px`;
  }

  function stopReorderAutoScroll() {
    reorderAutoScrollVelocity = 0;
    if (reorderAutoScrollRaf) cancelAnimationFrame(reorderAutoScrollRaf);
    reorderAutoScrollRaf = 0;
  }

  function runReorderAutoScroll() {
    reorderAutoScrollRaf = 0;
    if (!triangleDragProxyActive || !reorderAutoScrollVelocity) return;
    const root = triangleDragProxyRoot;
    if (!(root instanceof HTMLElement) || !root.isConnected) return;
    const info = roots.get(root);
    const scroller = info?.scrollParent || scrollParentFor(root);
    try {
      if (!scroller || isWindowScroller(scroller)) {
        window.scrollBy(0, reorderAutoScrollVelocity);
      } else {
        scroller.scrollTop += reorderAutoScrollVelocity;
      }
    } catch (_) {}
    if (triangleDragLastPointer) {
      updateReorderIndicator(root, triangleDragSourceId, triangleDragSourceLevel, triangleDragLastPointer.y);
    }
    reorderAutoScrollRaf = requestAnimationFrame(runReorderAutoScroll);
  }

  function updateReorderAutoScroll(root, clientY) {
    const info = roots.get(root);
    const scroller = info?.scrollParent || scrollParentFor(root);
    const rect = !scroller || isWindowScroller(scroller)
      ? { top: 0, bottom: window.innerHeight }
      : scroller.getBoundingClientRect();
    const margin = 54;
    let velocity = 0;
    if (clientY < rect.top + margin) {
      const ratio = Math.min(1, Math.max(0, (rect.top + margin - clientY) / margin));
      velocity = -Math.max(3, Math.round(16 * ratio));
    } else if (clientY > rect.bottom - margin) {
      const ratio = Math.min(1, Math.max(0, (clientY - (rect.bottom - margin)) / margin));
      velocity = Math.max(3, Math.round(16 * ratio));
    }
    reorderAutoScrollVelocity = velocity;
    if (velocity && !reorderAutoScrollRaf) {
      reorderAutoScrollRaf = requestAnimationFrame(runReorderAutoScroll);
    } else if (!velocity) {
      stopReorderAutoScroll();
    }
  }

  function maskCollapsedContentInSource(root, sourceId) {
    if (!(root instanceof HTMLElement) || !sourceId) return;
    clearDragVisibilityMask(root);
    const info = ensureRoot(root);
    const source = info?.entryById?.get(sourceId);
    if (!source) return;
    const children = root.children;
    let hiddenUntil = -1;
    for (const entry of info.entries) {
      if (entry.startIndex < source.startIndex || entry.startIndex >= source.endIndexExclusive) continue;
      if (entry.startIndex < hiddenUntil || !collapsedIds.has(entry.id)) continue;
      const end = Math.min(entry.endIndexExclusive, source.endIndexExclusive);
      for (let i = entry.startIndex + 1; i < end; i++) {
        const child = children[i];
        if (child instanceof HTMLElement) child.setAttribute(DRAG_HIDDEN_ATTR, '');
      }
      hiddenUntil = end;
    }
  }

  function dispatchNativeMoveSteps(root, heading, sourceId, delta, onComplete = null) {
    if (!(root instanceof HTMLElement) || !(heading instanceof HTMLElement) || !delta) {
      if (typeof onComplete === 'function') onComplete();
      return;
    }

    const rect = firstTextRect(heading);
    const headingRect = heading.getBoundingClientRect();
    const x = Math.max(headingRect.left + 3, rect.left + 2);
    const y = rect.top + Math.max(2, rect.height / 2);

    // Select the heading once, then use CardMirror's own schema-aware Move
    // Container Up/Down key path. This is deliberately NOT the page-drag
    // controller: no synthetic pointer drag or hidden modifier state exists.
    const mouseInit = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
    };
    heading.dispatchEvent(new MouseEvent('mousedown', mouseInit));
    heading.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
    heading.dispatchEvent(new MouseEvent('click', { ...mouseInit, buttons: 0 }));
    restoreViewportSnapshot();

    const mac = isMacPlatform();
    const key = delta > 0 ? 'ArrowDown' : 'ArrowUp';
    const steps = Math.min(250, Math.abs(delta));
    const init = {
      bubbles: true,
      cancelable: true,
      key,
      code: key,
      altKey: true,
      ctrlKey: !mac,
      metaKey: mac,
    };

    // ProseMirror transactions are synchronous. Keep the sequence in one task
    // so the browser never paints intermediate section positions. CardMirror's
    // current structural move command is sibling-based and effectively instant
    // even on large tournament files, so this is cheaper than a pointer-drag
    // controller continuously recalculating drop geometry.
    for (let i = 0; i < steps; i++) {
      root.dispatchEvent(new KeyboardEvent('keydown', init));
      root.dispatchEvent(new KeyboardEvent('keyup', init));
    }
    restoreViewportSnapshot();
    queueMicrotask(() => {
      restoreViewportSnapshot();
      if (typeof onComplete === 'function') onComplete();
    });
  }

  function finalizeTriangleDragSettling(root) {
    stopReorderAutoScroll();
    clearReorderIndicator();
    if (!(root instanceof HTMLElement) || !root.isConnected) {
      if (root instanceof HTMLElement) clearDragVisibilityMask(root);
      triangleDragSettlingRoot = null;
      triangleDragViewportSnapshot = null;
      return;
    }
    const info = roots.get(root);
    if (info) {
      info.structureDirty = true;
      syncRootHeadings(root);
    } else {
      queueCollapseCss(root);
    }

    // Restore the viewport while CardMirror/ProseMirror finish measuring the
    // structural edit. Remove the temporary mask only after collapse CSS for
    // the new order has already been rebuilt.
    requestAnimationFrame(() => {
      restoreViewportSnapshot();
      requestAnimationFrame(() => {
        restoreViewportSnapshot();
        clearDragVisibilityMask(root);
        triangleDragSettlingRoot = null;
        triangleDragViewportSnapshot = null;
        queueLayout(root);
      });
    });
  }

  function startTriangleDragProxy(heading, btn, event) {
    const root = heading.parentElement;
    if (!(root instanceof HTMLElement) || !root.classList.contains('ProseMirror')) return false;
    const id = headingId(heading);
    const level = headingLevel(heading);
    if (!id || level == null) return false;

    triangleDragProxyActive = true;
    triangleDragProxyRoot = root;
    triangleDragSourceId = id;
    triangleDragSourceLevel = level;
    triangleDragLastPointer = { x: event.clientX, y: event.clientY };
    triangleDragCancelled = false;
    triangleDragPhysicalButtonMask = pendingTriangleRightDrag?.buttonMask || 2;
    triangleDragSuppressContextUntil = performance.now() + 1000;
    btn.classList.add('cm-ch-dragging');
    updateReorderIndicator(root, id, level, event.clientY);
    updateReorderAutoScroll(root, event.clientY);
    rememberEditorContext();
    return true;
  }

  function dispatchProxiedDragMove(event) {
    if (!(event instanceof PointerEvent) || proxiedDragEvents.has(event)) return;

    if (!triangleDragProxyActive && pendingTriangleRightDrag) {
      const pending = pendingTriangleRightDrag;
      if (pending.pointerId && event.pointerId && pending.pointerId !== event.pointerId) return;
      if (pending.buttonMask && !(event.buttons & pending.buttonMask)) {
        pendingTriangleRightDrag = null;
        return;
      }
      const dx = event.clientX - pending.startX;
      const dy = event.clientY - pending.startY;
      if ((dx * dx) + (dy * dy) < RIGHT_DRAG_THRESHOLD_PX * RIGHT_DRAG_THRESHOLD_PX) return;

      pendingTriangleRightDrag = null;
      if (!pending.heading?.isConnected || !pending.btn?.isConnected) return;
      if (!startTriangleDragProxy(pending.heading, pending.btn, event)) return;
    }

    if (!triangleDragProxyActive) return;
    if (triangleDragPhysicalButtonMask && !(event.buttons & triangleDragPhysicalButtonMask)) {
      finishTriangleDragProxy(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    triangleDragLastPointer = { x: event.clientX, y: event.clientY };
    updateReorderIndicator(
      triangleDragProxyRoot,
      triangleDragSourceId,
      triangleDragSourceLevel,
      event.clientY,
    );
    updateReorderAutoScroll(triangleDragProxyRoot, event.clientY);
  }

  function finishTriangleDragProxy(cancelled = false) {
    if (!triangleDragProxyActive) return;

    const root = triangleDragProxyRoot;
    const sourceId = triangleDragSourceId;
    const sourceLevel = triangleDragSourceLevel;
    const pointer = triangleDragLastPointer;

    pendingTriangleRightDrag = null;
    triangleDragProxyActive = false;
    triangleDragProxyRoot = null;
    triangleDragSourceId = '';
    triangleDragSourceLevel = null;
    triangleDragLastPointer = null;
    triangleDragCancelled = false;
    triangleDragPhysicalButtonMask = 0;
    stopReorderAutoScroll();
    clearReorderIndicator();
    for (const btn of buttons.values()) btn.classList.remove('cm-ch-dragging');

    if (cancelled || !(root instanceof HTMLElement) || !root.isConnected || !sourceId || sourceLevel == null || !pointer) {
      triangleDragSuppressContextUntil = performance.now() + 250;
      return;
    }

    const source = headingById(root, sourceId);
    if (!(source instanceof HTMLElement)) return;
    const placement = reorderInsertionForPointer(root, source, sourceLevel, pointer.y);
    if (!placement) return;
    const delta = placement.desiredIndex - placement.sourceIndex;
    triangleDragSuppressContextUntil = performance.now() + 350;
    if (!delta) return;

    triangleDragViewportSnapshot = captureViewportSnapshot(root);
    triangleDragSettlingRoot = root;
    maskCollapsedContentInSource(root, sourceId);
    dispatchNativeMoveSteps(root, source, sourceId, delta, () => finalizeTriangleDragSettling(root));
  }

  function onTriangleDragPointerUp(event) {
    if (!(event instanceof PointerEvent) || proxiedDragEvents.has(event)) return;

    if (!triangleDragProxyActive && pendingTriangleRightDrag) {
      const pending = pendingTriangleRightDrag;
      if (!pending.pointerId || !event.pointerId || pending.pointerId === event.pointerId) {
        pendingTriangleRightDrag = null;
        triangleDragSuppressContextUntil = performance.now() + 250;
      }
      return;
    }
    if (!triangleDragProxyActive) return;
    event.preventDefault();
    event.stopPropagation();
    triangleDragLastPointer = { x: event.clientX, y: event.clientY };
    finishTriangleDragProxy(false);
  }

  function onTriangleDragPointerCancel() {
    pendingTriangleRightDrag = null;
    finishTriangleDragProxy(true);
  }

  function onTriangleDragAbort() {
    pendingTriangleRightDrag = null;
    finishTriangleDragProxy(true);
  }

  function onTriangleContextMenu(event) {
    const target = event.target;
    if (pendingTriangleRightDrag ||
        triangleDragProxyActive ||
        performance.now() < triangleDragSuppressContextUntil ||
        (target instanceof Element && target.closest('.cm-collapse-toggle'))) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function createButton(heading) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-collapse-toggle';
    btn.tabIndex = -1;

    btn.addEventListener('pointerdown', event => {
      const macSecondary = isMacPlatform() && event.button === 0 && event.ctrlKey;
      const rightButton = event.button === 2 || macSecondary;

      if (rightButton) {
        // Right-click only arms our own lightweight reorder gesture. It never
        // enters CardMirror's native page-drag mode, so an ordinary secondary
        // click cannot strand or freeze the editor.
        event.preventDefault();
        event.stopPropagation();
        pendingTriangleRightDrag = {
          heading,
          btn,
          pointerId: event.pointerId || 0,
          buttonMask: macSecondary ? 1 : 2,
          startX: event.clientX,
          startY: event.clientY,
        };
        triangleDragSuppressContextUntil = performance.now() + 1000;
        return;
      }

      if (event.button !== 0) return;
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

      commitCollapseState(heading.parentElement);
    });

    btn.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
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
    const id = headingId(heading);
    const collapsed = !!id && collapsedIds.has(id);
    btn.textContent = collapsed ? '▶' : '▼';
    btn.title = (collapsed ? 'Expand section' : 'Collapse section') + ' · Right-drag to reorder';
    btn.setAttribute('aria-label', btn.title);
  }

  function updateVisibleButtonStates(root = null) {
    for (const heading of visibleHeadings) {
      if (root instanceof HTMLElement && heading.parentElement !== root) continue;
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

  function buildRulesForRoot(info) {
    const rules = [];
    let hiddenUntil = -1;

    // `entries` is rebuilt only when ProseMirror's top-level structure changes.
    // Command spam therefore scales with heading count, not every card/body
    // paragraph in a giant backfile.
    for (const entry of info.entries) {
      if (entry.startIndex < hiddenUntil) continue;
      if (!collapsedIds.has(entry.id)) continue;
      emitCollapsedRule(
        rules,
        info,
        entry.startIndex,
        entry.endIndexExclusive
      );
      hiddenUntil = entry.endIndexExclusive;
    }

    info.collapseRulesText = rules.join('\n');
  }

  function rebuildCollapseCss() {
    cssQueued = false;
    if (destroyed) return;
    ensureStyles();
    discoverRoots();

    const updateAll = collapseAllRequested;
    const targets = updateAll ? null : new Set(pendingCollapseRoots);
    collapseAllRequested = false;
    pendingCollapseRoots.clear();

    for (const info of roots.values()) {
      if (!info.root.isConnected) continue;
      if (!targets || targets.has(info.root)) buildRulesForRoot(info);
    }

    collapseStyle.textContent = Array.from(roots.values())
      .filter(info => info.root.isConnected && info.collapseRulesText)
      .map(info => info.collapseRulesText)
      .join('\n');

    // CSS visibility changed. Restrict state/geometry work to the pane(s)
    // whose collapse state changed whenever possible.
    requestAnimationFrame(() => {
      if (!targets) {
        queueLayout();
      } else {
        for (const root of targets) queueLayout(root);
      }
    });
  }

  function queueCollapseCss(root = null) {
    if (root instanceof HTMLElement) {
      if (!collapseAllRequested) pendingCollapseRoots.add(root);
    } else {
      collapseAllRequested = true;
      pendingCollapseRoots.clear();
    }
    if (cssQueued) return;
    cssQueued = true;
    requestAnimationFrame(rebuildCollapseCss);
  }

  function firstTextRect(heading) {
    const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
      const value = node.nodeValue || '';
      const firstVisible = value.search(/\S/);
      if (firstVisible >= 0) {
        try {
          const range = document.createRange();
          range.setStart(node, firstVisible);
          range.setEnd(node, Math.min(value.length, firstVisible + 1));
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

    const headingRect = heading.getBoundingClientRect();

    if (
      headingRect.width <= 0 ||
      headingRect.height <= 0 ||
      (typeof heading.checkVisibility === 'function' &&
       !heading.checkVisibility({ checkVisibilityCSS: true }))
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

    // Appearance is updated at button creation, on plugin setting changes,
    // visible-heading style mutations, and host theme changes. Scroll/layout
    // passes therefore stay geometry-only and avoid a computed-style read for
    // every visible heading.
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
    // During a native section drag CardMirror owns all visual feedback. Avoid
    // competing geometry reads/writes while it auto-scrolls and calculates
    // drop slots; one consolidated layout runs when the gesture finishes.
    if ((triangleDragProxyActive &&
         (root == null || root === triangleDragProxyRoot)) ||
        (triangleDragSettlingRoot &&
         (root == null || root === triangleDragSettlingRoot))) {
      return;
    }

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
      const info = roots.get(root);
      if (root.isConnected && info?.structureDirty) syncRootHeadings(root);
    }

    for (const root of targets) {
      if (root.isConnected) queueLayout(root);
    }
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

    const info = ensureRoot(root);
    const cached = info?.ownerHeadingByChild?.get(child);
    if (cached instanceof HTMLElement && cached.isConnected) return cached;

    // Fallback for the narrow interval between a ProseMirror DOM mutation and
    // the next structure-index refresh. This should be rare; the normal path
    // above is O(1).
    let candidate = child;
    while (candidate && candidate.parentElement === root) {
      if (headingLevel(candidate) != null) return candidate;
      candidate = candidate.previousElementSibling;
    }
    return null;
  }

  function headingById(root, id) {
    if (!(root instanceof HTMLElement) || !id) return null;
    const info = ensureRoot(root);
    return info?.entryById?.get(id)?.heading || null;
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

    // Navigation to already-visible content should be nearly free. This also
    // avoids touching the structural index when the nav pane jumps to a normal
    // expanded section on a giant document. Hidden descendants have no client
    // rects because collapse uses display:none.
    if (!cssQueued && child.getClientRects().length > 0) return [];

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

    queueLayout(root);
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
    commitCollapseState(root);
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

  function commitCollapseState(root = null) {
    queueCollapseCss(root);
    // Arrow state can update immediately; geometry must wait until the new
    // collapse CSS has actually landed, which rebuildCollapseCss schedules.
    // Avoiding an extra pre-CSS layout pass matters when commands are spammed.
    if (root instanceof HTMLElement) updateVisibleButtonStates(root);
    else updateVisibleButtonStates();
  }

  function rootInfo(root) {
    if (!(root instanceof HTMLElement)) return null;
    return ensureRoot(root);
  }

  function setAllInRoot(root, collapsed) {
    const info = rootInfo(root);
    if (!info) return false;
    if (collapsed) suppressRevealForCurrentSelection();

    let changed = false;
    for (const entry of info.entries) {
      if (collapsed) {
        if (!collapsedIds.has(entry.id)) {
          collapsedIds.add(entry.id);
          changed = true;
        }
      } else if (collapsedIds.delete(entry.id)) {
        changed = true;
      }
    }

    if (changed) commitCollapseState(root);
    return changed;
  }

  function setAllInFocusedRoot(collapsed) {
    return setAllInRoot(commandRoot(), collapsed);
  }

  function setLevelInFocusedRoot(level, collapsed) {
    const root = commandRoot();
    const info = rootInfo(root);
    if (!info) return false;
    if (collapsed) suppressRevealForCurrentSelection();

    let changed = false;
    for (const entry of info.entries) {
      if (entry.level !== level) continue;
      if (collapsed) {
        if (!collapsedIds.has(entry.id)) {
          collapsedIds.add(entry.id);
          changed = true;
        }
      } else if (collapsedIds.delete(entry.id)) {
        changed = true;
      }
    }

    if (changed) commitCollapseState(root);
    return changed;
  }

  function toggleCurrentSection(api) {
    const heading = currentSectionHeading();
    const root = heading?.parentElement;
    if (!(heading instanceof HTMLElement) || !(root instanceof HTMLElement)) {
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
    commitCollapseState(root);
  }

  function sectionPath(root, heading) {
    const info = rootInfo(root);
    if (!info || !(heading instanceof HTMLElement)) return [];
    const entry = info.entryByHeading.get(heading);
    if (!entry) return [];
    return [...(entry.ancestorHeadings || []), heading];
  }

  function entryScopeBounds(info, heading) {
    const entry = info.entryByHeading.get(heading);
    const index = info.entryIndexByHeading.get(heading);
    if (!entry || index == null) return null;

    let start = -1;
    let end = info.entries.length;
    for (let i = index - 1; i >= 0; i--) {
      if (info.entries[i].level < entry.level) {
        start = i;
        break;
      }
    }
    for (let i = index + 1; i < info.entries.length; i++) {
      if (info.entries[i].level < entry.level) {
        end = i;
        break;
      }
    }
    return { start, end, index, entry };
  }

  function toggleAllUnderCurrentSection(api) {
    const heading = currentSectionHeading();
    const root = heading?.parentElement;
    const info = rootInfo(root);
    if (!(heading instanceof HTMLElement) || !(root instanceof HTMLElement) || !info) {
      api?.showToast?.('Collapsible Headers: place the cursor inside a Pocket, Hat, or Block first.');
      return;
    }

    const current = info.entryByHeading.get(heading);
    if (!current) return;
    const descendants = info.entries.filter(entry =>
      entry.startIndex > current.startIndex &&
      entry.startIndex < current.endIndexExclusive &&
      entry.level > current.level
    );

    if (!descendants.length) {
      const name = current.level === 1 ? 'Pocket' : current.level === 2 ? 'Hat' : 'Block';
      api?.showToast?.(`Collapsible Headers: current ${name} has no headers underneath.`);
      return;
    }

    // If anything underneath is open, collapse the whole descendant tree. If
    // everything is already collapsed, the same command expands it all. The
    // current heading's own state is intentionally left untouched.
    const collapse = descendants.some(entry => !collapsedIds.has(entry.id));
    if (collapse) suppressRevealForCurrentSelection();
    for (const entry of descendants) {
      if (collapse) collapsedIds.add(entry.id);
      else collapsedIds.delete(entry.id);
    }
    commitCollapseState(root);

    const name = current.level === 1 ? 'Pocket' : current.level === 2 ? 'Hat' : 'Block';
    api?.showToast?.(
      `Collapsible Headers: ${collapse ? 'collapsed' : 'expanded'} all headers under current ${name}.`
    );
  }

  function focusCurrentSection(api) {
    const heading = currentSectionHeading();
    const root = heading?.parentElement;
    const info = rootInfo(root);
    if (!(heading instanceof HTMLElement) ||
        !(root instanceof HTMLElement) ||
        !info) {
      api?.showToast?.('Collapsible Headers: place the cursor inside a Pocket, Hat, or Block first.');
      return;
    }

    const path = sectionPath(root, heading);
    if (!path.length) return;
    suppressRevealForCurrentSelection();
    let changed = false;

    // Focus the whole branch: at each level, expand the path heading and
    // collapse its same-level siblings inside the same parent scope. Work only
    // over the cached heading index, never every top-level card/body node.
    for (const pathHeading of path) {
      const bounds = entryScopeBounds(info, pathHeading);
      if (!bounds) continue;
      const { entry, start, end } = bounds;

      if (collapsedIds.delete(entry.id)) changed = true;
      for (let i = start + 1; i < end; i++) {
        const sibling = info.entries[i];
        if (sibling.heading === pathHeading || sibling.level !== entry.level) continue;
        if (!collapsedIds.has(sibling.id)) {
          collapsedIds.add(sibling.id);
          changed = true;
        }
      }
    }

    if (changed) commitCollapseState(root);
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
        id: PLUGIN_ID + '.toggle-all-under-current',
        label: 'Collapsible Headers: Toggle All Under Current Section',
        keywords: ['toggle', 'collapse', 'expand', 'all', 'under', 'current', 'section', 'descendants'],
        defaultKey: null,
        run: api => {
          bindPluginApi(api);
          toggleAllUnderCurrentSection(api);
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
        type: 'number',
        default: TRIANGLE_SIZE_DEFAULT,
        description: `Use ▼ / ▲ to adjust the triangle size (${TRIANGLE_SIZE_MIN}–${TRIANGLE_SIZE_MAX}).`,
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
    document.removeEventListener('click', queueEnhanceTriangleSizeSetting, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('selectionchange', onSelectionChange, true);
    document.removeEventListener('input', onHostNavigationInput, true);
    document.removeEventListener('keydown', onHostNavigationKeyDown, true);
    document.removeEventListener('click', onHostNavigationClick, true);
    document.removeEventListener('pointermove', dispatchProxiedDragMove, true);
    document.removeEventListener('pointerup', onTriangleDragPointerUp, true);
    document.removeEventListener('pointercancel', onTriangleDragPointerCancel, true);
    document.removeEventListener('contextmenu', onTriangleContextMenu, true);
    window.removeEventListener('blur', onTriangleDragAbort);
    window.removeEventListener('resize', queueLayout);
    try { themeObserver?.disconnect(); } catch (_) {}
    themeObserver = null;

    for (const timer of startupTimers) clearTimeout(timer);
    startupTimers.length = 0;

    for (const [root, info] of roots) {
      clearDragVisibilityMask(root);
      try { info.intersection?.disconnect(); } catch (_) {}
      try { info.mutations?.disconnect(); } catch (_) {}
      for (const observer of info.headingMutationObservers?.values?.() || []) {
        try { observer.disconnect(); } catch (_) {}
      }
      info.headingMutationObservers?.clear?.();
      try { info.resize?.disconnect(); } catch (_) {}
      try { info.layer?.remove(); } catch (_) {}
    }

    if (triangleDragProxyRoot instanceof HTMLElement) clearDragVisibilityMask(triangleDragProxyRoot);

    roots.clear();
    buttons.clear();
    visibleHeadings.clear();
    pendingStructureRoots.clear();
    pendingPostEditRoots.clear();
    pendingLayoutRoots.clear();
    pendingCollapseRoots.clear();
    collapseAllRequested = false;
    layoutAllRequested = false;
    lastEditorContext = null;
    lastEditorSelectionTarget = null;
    suppressedRevealTarget = null;
    pendingRevealTarget = null;
    revealQueued = false;
    hostNavigationProbeQueued = false;
    pendingHostNavigationSelector = '';
    pendingHostNavigationRoot = null;
    stopReorderAutoScroll();
    clearReorderIndicator();
    pendingTriangleRightDrag = null;
    triangleDragProxyActive = false;
    triangleDragProxyRoot = null;
    triangleDragSourceId = '';
    triangleDragSourceLevel = null;
    triangleDragLastPointer = null;
    triangleDragCancelled = false;
    triangleDragPhysicalButtonMask = 0;
    triangleDragSuppressContextUntil = 0;
    triangleDragSettlingRoot = null;
    triangleDragViewportSnapshot = null;
    dragMaskRefreshQueued = false;

    try { document.getElementById(STYLE_ID)?.remove(); } catch (_) {}
    try { document.getElementById(COLLAPSE_STYLE_ID)?.remove(); } catch (_) {}
  }

  ensureStyles();
  ensureThemeObserver();
  const initialAppearance = readBootstrapAppearance();
  appearance = initialAppearance;
  discoverRoots();
  queueCollapseCss();
  queueLayout();
  queueEnhanceTriangleSizeSetting();

  document.addEventListener('input', onEditorInput, true);
  document.addEventListener('change', onPotentialSettingsChange, true);
  document.addEventListener('click', queueEnhanceTriangleSizeSetting, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('selectionchange', onSelectionChange, true);
  document.addEventListener('input', onHostNavigationInput, true);
  document.addEventListener('keydown', onHostNavigationKeyDown, true);
  document.addEventListener('click', onHostNavigationClick, true);
  document.addEventListener('pointermove', dispatchProxiedDragMove, true);
  document.addEventListener('pointerup', onTriangleDragPointerUp, true);
  document.addEventListener('pointercancel', onTriangleDragPointerCancel, true);
  document.addEventListener('contextmenu', onTriangleContextMenu, true);
  window.addEventListener('blur', onTriangleDragAbort);
  window.addEventListener('resize', queueLayout, { passive: true });

  window[RUNTIME_KEY] = {
    destroy: destroyRuntime,
    version: '1.0.0-beta.11',
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
