// IIFE: Edit Mode Module
// Depends on global $, modal(), escapeHtml(), call() from app.js
(function() {
  'use strict';

  // ---- State ----
  var isEditMode = false;
  var selectedElement = null;
  var selectedElementOriginalZIndex = null;
  var dragState = null; // { startX, startY, startLeft, startTop }
  var resizeState = null; // { startX, startY, startWidth, startHeight }
  // Click-through cycling
  var lastClickPoint = null; // { x, y, time }
  var lastElementStack = null; // Array of elements at last click point
  var stackIndex = 0;
  var didDrag = false; // set true during a drag so click handler can skip cycling

  // Which elements are positionable/draggable in edit mode
  var POSITIONABLE_SELECTOR = '.fab, #chatFab, .usagechip, .toolbar';

  var CSS_RESIZE_HANDLE = 'editmode-resize-handle';

  // ---- Helpers ----
  function onEditable(el) {
    return el && el.matches(POSITIONABLE_SELECTOR);
  }

  function px(n) { return Math.round(n) + 'px'; }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  // ---- DOM refs ----
  var editBtn = null;
  var infoBar = null;

  function ensureInfoBar() {
    if (!infoBar) {
      infoBar = document.getElementById('editModeInfo');
      if (!infoBar) {
        infoBar = document.createElement('div');
        infoBar.id = 'editModeInfo';
        document.body.appendChild(infoBar);
      }
    }
    return infoBar;
  }

  function updateInfoBar() {
    var bar = ensureInfoBar();
    if (!isEditMode || !selectedElement) {
      bar.style.display = 'none';
      document.body.classList.remove('element-selected');
      return;
    }
    document.body.classList.add('element-selected');
    bar.style.display = 'flex';
    var left = parseInt(selectedElement.style.left) || 0;
    var top = parseInt(selectedElement.style.top) || 0;
    var w = selectedElement.offsetWidth || 0;
    var h = selectedElement.offsetHeight || 0;
    bar.innerHTML = '<span class="info-item"><span class="info-label">Editing layout</span></span>' +
      '<span class="info-item"><span class="info-label">Pos</span> ' + left + ', ' + top + '</span>' +
      '<span class="info-item"><span class="info-label">Size</span> ' + w + '\u00d7' + h + '</span>';
  }

  // ---- Resize handle ----
  // We create the handle as a separate fixed-position element that tracks
  // the selected element's bounding rect, rather than a child — because
  // many .fab elements are fixed and can't also be relative containers.
  function createResizeHandle() {
    var h = document.createElement('div');
    h.className = 'resize-handle';
    h.id = CSS_RESIZE_HANDLE;
    return h;
  }

  function positionResizeHandle() {
    var h = document.getElementById(CSS_RESIZE_HANDLE);
    if (!h || !selectedElement) return;
    var rect = selectedElement.getBoundingClientRect();
    h.style.position = 'fixed';
    h.style.left = px(rect.right - 6);
    h.style.top = px(rect.bottom - 6);
  }

  function attachResizeHandle(el) {
    detachResizeHandle();
    var h = createResizeHandle();
    document.body.appendChild(h);
    positionResizeHandle();
    h.addEventListener('pointerdown', onResizePointerDown);
    // Reposition on scroll/resize
    window.addEventListener('scroll', positionResizeHandle, {passive: true});
    window.addEventListener('resize', positionResizeHandle, {passive: true});
  }

  function detachResizeHandle() {
    var h = document.getElementById(CSS_RESIZE_HANDLE);
    if (h) h.remove();
    window.removeEventListener('scroll', positionResizeHandle);
    window.removeEventListener('resize', positionResizeHandle);
  }

  // ---- Selection ----
  function selectElement(el) {
    if (selectedElement === el) return;
    deselectElement();
    selectedElement = el;
    if (el) {
      selectedElementOriginalZIndex = el.style.zIndex;
      el.style.zIndex = '9999';
      el.classList.add('selected-for-drag');
      attachResizeHandle(el);
    }
    updateInfoBar();
  }

  function deselectElement() {
    if (selectedElement) {
      selectedElement.classList.remove('selected-for-drag');
      if (selectedElementOriginalZIndex !== null && selectedElementOriginalZIndex !== undefined) {
        selectedElement.style.zIndex = selectedElementOriginalZIndex;
      } else {
        selectedElement.style.zIndex = '';
      }
      detachResizeHandle();
      selectedElement = null;
      selectedElementOriginalZIndex = null;
    }
    lastClickPoint = null;
    lastElementStack = null;
    stackIndex = 0;
    updateInfoBar();
  }

  // ---- Click-through cycling ----
  function getElementStackAtPoint(x, y) {
    var all = document.elementsFromPoint(x, y);
    // We need to get all elements matching our selector, including the edit btn itself (but btn not moveable)
    var pos = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (onEditable(el) && el !== editBtn) {
        pos.push(el);
      }
    }
    // Sort by z-index descending
    pos.sort(function(a, b) {
      var za = parseInt(a.style.zIndex) || 0;
      var zb = parseInt(b.style.zIndex) || 0;
      return zb - za;
    });
    return pos;
  }

  function handleElementClick(e) {
    if (!isEditMode) return;
    // Never process clicks on the edit mode button itself
    if (e.target && (e.target === editBtn || editBtn.contains(e.target))) return;
    // Ignore clicks on resize handle
    if (e.target && e.target.id === CSS_RESIZE_HANDLE) return;
    // If we just finished a drag, don't cycle — the element is already selected
    if (didDrag) return;
    var x = e.clientX;
    var y = e.clientY;
    var now = Date.now();

    // Check if this click is close to previous click (within 8px and 800ms)
    var sameSpot = false;
    if (lastClickPoint && lastElementStack && lastElementStack.length > 0) {
      var dx = x - lastClickPoint.x;
      var dy = y - lastClickPoint.y;
      var dt = now - lastClickPoint.time;
      if (dx * dx + dy * dy <= 64 && dt <= 800) {
        sameSpot = true;
      } else {
        // Reset stack
        lastElementStack = null;
        stackIndex = 0;
      }
    }

    var stack;
    if (sameSpot && lastElementStack) {
      stack = lastElementStack;
      // Cycle index
      stackIndex = (stackIndex + 1) % stack.length;
    } else {
      stack = getElementStackAtPoint(x, y);
      if (stack.length === 0) {
        // Clicked empty space -> deselect
        deselectElement();
        lastClickPoint = null;
        lastElementStack = null;
        stackIndex = 0;
        return;
      }
      stackIndex = 0;
    }

    var target = stack[stackIndex];
    if (target) {
      selectElement(target);
      // Start drag immediately on click (pointerdown)
      // We handle drag on pointerdown via global listener
    }

    lastClickPoint = { x: x, y: y, time: now };
    lastElementStack = stack;
  }

  // ---- Drag handling (pointer events) ----
  function onPointerDown(e) {
    if (!isEditMode) return;
    // Never interfere with the edit mode button itself
    if (e.target && (e.target === editBtn || editBtn.contains(e.target))) return;
    // Ignore if pointer is on resize handle
    if (e.target && e.target.id === CSS_RESIZE_HANDLE) return;

    var el = e.target;
    if (el === selectedElement || (selectedElement && selectedElement.contains(el))) {
      // Already selected — start dragging immediately
      startDrag(e);
    } else if (onEditable(el)) {
      // Select it first, then start dragging (one fluid motion)
      selectElement(el);
      startDrag(e);
    } else {
      deselectElement();
    }
  }

  function startDrag(e) {
    if (!selectedElement) return;
    var rect = selectedElement.getBoundingClientRect();
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top
    };
    // Capture pointer on the selected element so moves track outside
    selectedElement.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!isEditMode) return;
    if (dragState && selectedElement) {
      didDrag = true;
      var dx = e.clientX - dragState.startX;
      var dy = e.clientY - dragState.startY;
      var newLeft = dragState.startLeft + dx;
      var newTop = dragState.startTop + dy;
      selectedElement.style.left = px(newLeft);
      selectedElement.style.top = px(newTop);
      positionResizeHandle();
      updateInfoBar();
      e.preventDefault();
    } else if (resizeState && selectedElement) {
      didDrag = true;
      var dx2 = e.clientX - resizeState.startX;
      var dy2 = e.clientY - resizeState.startY;
      var newW = Math.max(28, resizeState.startWidth + dx2);
      var newH = Math.max(28, resizeState.startHeight + dy2);
      selectedElement.style.width = px(newW);
      selectedElement.style.height = px(newH);
      positionResizeHandle();
      updateInfoBar();
      e.preventDefault();
    }
  }

  function onPointerUp(e) {
    if (dragState) {
      dragState = null;
      saveLayout();
      if (selectedElement) {
        try { selectedElement.releasePointerCapture(e.pointerId); } catch(ex) {}
      }
    }
    if (resizeState) {
      resizeState = null;
      saveLayout();
      if (selectedElement) {
        try { selectedElement.releasePointerCapture(e.pointerId); } catch(ex) {}
      }
    }
    // Reset drag flag after a short delay so the subsequent click handler can read it
    setTimeout(function() { didDrag = false; }, 0);
  }

  function onResizePointerDown(e) {
    if (!isEditMode || !selectedElement) return;
    e.stopPropagation();
    resizeState = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: selectedElement.offsetWidth,
      startHeight: selectedElement.offsetHeight
    };
    selectedElement.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  // ---- Persistence ----
  function saveLayout() {
    if (!selectedElement) return;
    var id = selectedElement.id;
    if (!id) return; // only elements with an ID
    var data;
    try {
      data = JSON.parse(localStorage.getItem('uiLayout') || '{}');
    } catch(e) {
      data = {};
    }
    data[id] = {
      left: parseInt(selectedElement.style.left) || 0,
      top: parseInt(selectedElement.style.top) || 0,
      width: selectedElement.offsetWidth || 0,
      height: selectedElement.offsetHeight || 0
    };
    localStorage.setItem('uiLayout', JSON.stringify(data));
  }

  function restoreLayout() {
    var data;
    try {
      data = JSON.parse(localStorage.getItem('uiLayout') || '{}');
    } catch(e) {
      data = {};
    }
    for (var id in data) {
      if (data.hasOwnProperty(id)) {
        var el = document.getElementById(id);
        if (el && data[id]) {
          var layout = data[id];
          if (layout.left !== undefined) el.style.left = px(layout.left);
          if (layout.top !== undefined) el.style.top = px(layout.top);
          if (layout.width !== undefined) el.style.width = px(layout.width);
          if (layout.height !== undefined) el.style.height = px(layout.height);
        }
      }
    }
  }

  // ---- Reset ----
  function resetLayout() {
    if (typeof modal === 'function') {
      modal('Reset layout',
        '<div class="hint">Reset ALL UI element positions and sizes to their defaults? This cannot be undone.</div>',
        function() {
          localStorage.removeItem('uiLayout');
          location.reload();
        });
    } else {
      if (confirm('Reset all UI positions to defaults?')) {
        localStorage.removeItem('uiLayout');
        location.reload();
      }
    }
  }

  var longPressTimer = null;

  function startLongPressForReset() {
    longPressTimer = setTimeout(function() {
      resetLayout();
    }, 500);
  }

  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  // ---- Toggle ----
  function toggleEditMode() {
    isEditMode = !isEditMode;
    if (isEditMode) {
      document.body.classList.add('edit-mode');
      editBtn.classList.add('active');
      editBtn.textContent = '\u2713'; // checkmark
      // Add pointer event listeners for drag/resize
      document.addEventListener('pointerdown', onPointerDown);
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      // Add click handler for selection
      document.addEventListener('click', handleElementClick);
      // Prevent pull-to-refresh and scrolling during edit mode
      document.body.style.overflow = 'hidden';
      document.body.style.touchAction = 'none';
      // Prevent double-tap zoom on touched elements
      document.body.style.userSelect = 'none';
      // Restore layout in case new elements appeared
      restoreLayout();
    } else {
      document.body.classList.remove('edit-mode');
      editBtn.classList.remove('active');
      editBtn.textContent = '\u270E'; // pencil
      deselectElement();
      // Remove listeners
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('click', handleElementClick);
      document.body.style.overflow = '';
      document.body.style.touchAction = '';
      document.body.style.userSelect = '';
      // Hide info bar
      if (infoBar) infoBar.style.display = 'none';
      // Reset click-through state
      lastClickPoint = null;
      lastElementStack = null;
      stackIndex = 0;
    }
  }

  // ---- Keyboard ----
  function onKeyDown(e) {
    if (isEditMode && e.key === 'Escape') {
      toggleEditMode();
      e.preventDefault();
    }
  }

  // ---- Init ----
  function init() {
    editBtn = document.getElementById('editModeFab');
    if (!editBtn) {
      console.warn('Edit mode: #editModeFab not found, retrying in 500ms');
      setTimeout(init, 500);
      return;
    }

    // Restore layout on DOM ready (requestAnimationFrame)
    requestAnimationFrame(function() {
      restoreLayout();
    });

    // Toggle on click
    editBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleEditMode();
    });

    // Long press for reset
    editBtn.addEventListener('pointerdown', function(e) {
      startLongPressForReset();
    });
    editBtn.addEventListener('pointerup', cancelLongPress);
    editBtn.addEventListener('pointerleave', cancelLongPress);
    editBtn.addEventListener('pointercancel', cancelLongPress);

    // Keyboard
    document.addEventListener('keydown', onKeyDown);

    // Prevent default touch actions on editable elements during edit mode
    // (our editmode.css already covers outlines and cursor, but we need touch-action:none)
    var style = document.createElement('style');
    style.textContent = '.edit-mode .fab, .edit-mode #chatFab, .edit-mode .usagechip { touch-action: none; }';
    document.head.appendChild(style);

    // Create the edit mode overlay (visual indicator)
    var overlay = document.createElement('div');
    overlay.className = 'edit-mode-overlay';
    document.body.appendChild(overlay);
  }

  // Start when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();