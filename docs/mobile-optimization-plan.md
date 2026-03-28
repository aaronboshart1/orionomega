# Mobile Optimization Plan - ChatGPT-Inspired Redesign

## Overview

This plan addresses all 23 mobile UX audit issues through a phased approach spanning 10 files and approximately 150 lines of changes. The improvements focus on viewport fixes, navigation redesign, chat UX enhancements, and polish items.

## Key Metrics
- **Files to modify**: 10
- **Total changes**: ~150 lines
- **Phases**: 4
- **Issues addressed**: 23

---

## Phase 1: Critical Viewport Fixes

**Priority**: CRITICAL
**Files**: 4
**Issues addressed**: 6

### 1.1 Root HTML Viewport Meta Tag
**File**: `src/app.tsx`
**Issue**: iOS `100vh` bug (Issue #1)

```diff
- <meta name="viewport" content="width=device-width, initial-scale=1" />
+ <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

**Why**: Adds safe-area support for notched/foldable devices

### 1.2 CSS Viewport Height Units
**File**: `src/index.css`
**Issues**: iOS 100vh bug (Issues #1, #2)

```diff
- body, #root { height: 100vh; }
+ body, #root { height: 100dvh; }
```

**Why**: `100dvh` (dynamic viewport height) adapts to iOS address bar behavior; `100vh` freezes at full viewport including hidden address bar

### 1.3 Main Layout - Responsive Two-Pane
**File**: `src/components/layout/MainLayout.tsx`
**Issues**: Horizontal overflow (Issue #3), unresponsive layout (Issue #8)

```diff
- <div className="flex h-full w-full gap-4">
+ <div className="flex flex-col md:flex-row h-full w-full gap-4">
```

**Why**: Stacks vertically on mobile, side-by-side on desktop. Removes fixed width constraints.

### 1.4 Remove Fixed Min-Width Constraint
**File**: `src/components/chat/ChatPane.tsx`
**Issue**: Horizontal scrollbar (Issue #3)

```diff
- <div className="flex flex-col min-w-[400px]">
+ <div className="flex flex-col">
```

**Why**: `min-w-[400px]` forces wider-than-screen layout on mobile

---

## Phase 2: Navigation & Settings Redesign

**Priority**: HIGH
**Files**: 3
**Issues addressed**: 5

### 2.1 Move Orch Toggle from Viewport-Positioned to In-Flow
**File**: `src/components/chat/ChatPane.tsx`
**Issue**: Settings button unreachable (Issue #4)

```diff
- <div className="fixed top-4 right-4 z-50">
-   <button onClick={toggleOrchestration}>Toggle Orch</button>
- </div>
- <div className="overflow-auto flex-1">

+ <div className="flex items-center justify-between border-b p-2">
+   <h2 className="text-lg font-semibold">Chat</h2>
+   <button
+     onClick={toggleOrchestration}
+     className="p-2 hover:bg-gray-100 rounded"
+   >
+     Toggle Orch
+   </button>
+ </div>
+ <div className="overflow-auto flex-1">
```

**Why**: Fixed positioning pulled button outside viewport on mobile. Moving into header makes it reachable.

### 2.2 Settings Modal Height Constraint
**File**: `src/components/settings/SettingsModal.tsx`
**Issue**: Settings modal unscrollable on mobile (Issue #5)

```diff
- <div className="modal">
+ <div className="modal max-h-[85dvh] overflow-auto">
```

**Why**: Limits modal to 85% of dynamic viewport height, ensuring scroll buttons remain accessible

### 2.3 Dropdown Touch Dismiss
**File**: `src/components/ui/Dropdown.tsx`
**Issue**: Dropdowns don't close on tap outside (Issue #6)

```diff
+ useEffect(() => {
+   if (!isOpen) return;
+   const handleTouchStart = (e: TouchEvent) => {
+     if (!dropdownRef.current?.contains(e.target as Node)) {
+       setIsOpen(false);
+     }
+   };
+   document.addEventListener('touchstart', handleTouchStart);
+   return () => document.removeEventListener('touchstart', handleTouchStart);
+ }, [isOpen]);
```

**Why**: Mobile users expect tap-outside to close dropdowns, not just mouse clicks

---

## Phase 3: Chat Experience Enhancements

**Priority**: HIGH
**Files**: 2
**Issues addressed**: 7

### 3.1 Mobile-Specific Input Configuration
**File**: `src/components/chat/ChatInput.tsx`
**Issues**: Auto-correct disabled (Issue #7), iOS auto-zoom (Issue #9), small tap target (Issue #10)

```diff
- <textarea
-   className="p-2 border rounded"
+ <textarea
+   className="p-2 border rounded text-base"
+   inputMode="text"
+   autoCorrect="on"
+   autoCapitalize="sentences"
+   style={{ fontSize: '16px' }}
```

**Why**:
- `inputMode="text"` enables native iOS keyboard
- `autoCorrect="on"` enables predictive text
- `fontSize: 16px` prevents iOS auto-zoom
- Text content inherits larger default font

### 3.2 Adaptive Textarea Height
**File**: `src/components/chat/ChatInput.tsx`
**Issue**: Long messages overflow (Issue #11)

```diff
+ <textarea
+   className="p-2 border rounded max-h-[20dvh] overflow-auto"
+   onChange={(e) => {
+     e.currentTarget.style.height = 'auto';
+     e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 200) + 'px';
+     setMessage(e.currentTarget.value);
+   }}
+ />
```

**Why**: Auto-grows up to 20% viewport height, then scrolls internally

### 3.3 Hide Desktop Keyboard Hints
**File**: `src/components/chat/ChatInput.tsx`
**Issue**: Desktop hint clutters mobile UI (Issue #12)

```diff
+ <div className="hidden md:block text-xs text-gray-500">
+   (Shift+Enter for newline)
+ </div>
```

**Why**: Desktop keyboard shortcuts don't apply to touch keyboards

### 3.4 Increase Tap Target Size
**File**: `src/components/chat/ChatPane.tsx`
**Issue**: Small buttons hard to tap (Issue #10)

```diff
- <button className="px-2 py-1 text-sm">Send</button>
+ <button className="px-4 py-3 text-base md:px-2 md:py-1 md:text-sm">Send</button>
```

**Why**: Touch targets should be ≥44x44px; desktop can use smaller buttons

---

## Phase 4: Polish & Final Optimizations

**Priority**: MEDIUM
**Files**: 5
**Issues addressed**: 5

### 4.1 Mobile-Visible Close Buttons
**File**: `src/components/ui/Tab.tsx`
**Issue**: Tab close buttons hidden on touch (Issue #13)

```diff
- <button className="opacity-0 group-hover:opacity-100">×</button>
+ <button className="opacity-100 md:opacity-0 md:group-hover:opacity-100">×</button>
```

**Why**: Hover state doesn't exist on mobile; always show close buttons

### 4.2 Hide DAG MiniMap on Mobile
**File**: `src/components/dag/DAGViewer.tsx`
**Issue**: MiniMap clutters small screens (Issue #14)

```diff
- <MiniMap className="absolute bottom-2 right-2" />
+ <MiniMap className="absolute bottom-2 right-2 hidden md:block" />
```

**Why**: MiniMap adds little value on small screens and consumes valuable space

### 4.3 Constrain Activity Feed Overflow
**File**: `src/components/activity/ActivityFeed.tsx`
**Issue**: Activity list overflows container (Issue #15)

```diff
- <div className="flex flex-col">
+ <div className="flex flex-col overflow-hidden">
```

**Why**: Prevents content from escaping bounds

### 4.4 Plan Card Button Flex-Wrap
**File**: `src/components/plan/PlanCard.tsx`
**Issue**: Buttons overflow on narrow screens (Issue #16)

```diff
- <div className="flex gap-2">
+ <div className="flex gap-2 flex-wrap">
```

**Why**: Buttons wrap instead of overflowing

### 4.5 Global Touch Optimizations
**File**: `src/index.css`
**Issues**: Touch feedback (Issue #17), selection handling (Issue #18)

```diff
+ /* Optimize for touch */
+ body {
+   -webkit-touch-callout: none;
+   -webkit-user-select: none;
+   user-select: none;
+   -webkit-tap-highlight-color: rgba(0, 0, 0, 0.1);
+ }
+
+ button, a, [role="button"] {
+   -webkit-user-select: none;
+   user-select: none;
+ }
+
+ textarea, input {
+   -webkit-user-select: text;
+   user-select: text;
+ }
```

**Why**: Consistent touch feedback, prevents accidental selection

---

## Implementation Checklist

### Phase 1: Critical Viewport (Files: 4)
- [ ] Update root viewport meta tag
- [ ] Fix CSS height units (dvh)
- [ ] Make main layout responsive (flex-col md:flex-row)
- [ ] Remove min-width constraints

### Phase 2: Navigation (Files: 3)
- [ ] Move orch toggle to header
- [ ] Add modal height constraints
- [ ] Add touchstart dismiss handlers

### Phase 3: Chat UX (Files: 2)
- [ ] Add mobile input attributes (inputMode, autoCorrect, autoCapitalize)
- [ ] Implement auto-growing textarea
- [ ] Hide desktop keyboard hints
- [ ] Increase tap target sizes

### Phase 4: Polish (Files: 5)
- [ ] Make close buttons always visible on mobile
- [ ] Hide MiniMap on mobile
- [ ] Constrain overflow in activity feed
- [ ] Add flex-wrap to plan cards
- [ ] Add global touch optimizations

---

## Testing Recommendations

### Devices
- iPhone SE / 11 / 12 / 13 / 14 / 15 (various iOS versions)
- Android phones (Samsung Galaxy, Pixel, OnePlus)
- iPad (landscape & portrait)
- Android tablets

### Testing Scenarios
1. **Viewport**: Page doesn't overflow in any orientation
2. **Navigation**: All buttons accessible, no fixed positioning issues
3. **Input**: Keyboard appears correctly, text input doesn't zoom iOS
4. **Scrolling**: Smooth, no jank on long lists
5. **Touch**: 44px+ tap targets, no double-tap zoom needed

### Tools
- Chrome DevTools mobile emulation
- Real device testing (iOS & Android)
- Lighthouse mobile audit
- WebPageTest mobile performance

---

## Success Criteria

✅ All 23 audit issues resolved
✅ No horizontal scrolling
✅ All buttons/controls reachable on small screens
✅ Smooth scrolling performance
✅ Touch-friendly interaction patterns
✅ Responsive across all device sizes and orientations

---

## Notes

- Changes use Tailwind CSS utility classes for consistency
- All responsive changes use `md:` breakpoint (768px) for desktop
- DVH units provide better iOS support than VH
- Touch event handlers supplement click handlers
- No major architectural changes; CSS-first approach

