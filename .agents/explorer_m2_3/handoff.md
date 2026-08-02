# Handoff Report — Milestone 2: Visual Design & Micro-Animation Enhancements

**Agent**: explorer_m2_3 (teamwork_preview_explorer)  
**Target Scope**: `apps/web`  
**Date**: 2026-07-28  

---

## 1. Observation

### 1.1 Color Tokens & Theme Configuration
- **File**: `apps/web/tailwind.config.js` (lines 13–71)
- **Current State**:
  - `theme.colors` defines `void` (lines 15–26), `cyber` (lines 28–39), `neon` (lines 41–52), and basic `status` tokens (`success: '#00FF88'`, `warning: '#FFB800'`, `danger: '#FF3366'`, `info: '#00D4FF'`, `scanning: '#FFB800'`).
  - Missing token color scales for extended palette tokens: `emerald`, `amber`, and `rose` (needed for verified security states, warning/scanning, and critical audit alerts).
  - `boxShadow` (lines 62–71) defines `shadow-glow-cyan`, `shadow-glow-purple`, `shadow-glow-green`, `shadow-glow-red`, `shadow-glow-yellow`, but lacks `shadow-glow-emerald`, `shadow-glow-amber`, and `shadow-glow-rose`.

### 1.2 Glassmorphism & Background Utilities
- **File**: `apps/web/src/index.css` (lines 55–67, 107–175, 213–257)
- **Current State**:
  - Utility classes defined: `.glass`, `.glass-light`, `.gradient-border`, `.shimmer-bg`, `.ring-glow-cyan`, `.ring-glow-purple`, `.bg-grid-futuristic`, `.scan-overlay`, `.ambient-bg`.
  - `.ambient-bg .orb` uses `filter: blur(100px); opacity: 0.15; animation: float 8s ease-in-out infinite;` without GPU compositor layer promotion (`transform: translate3d(0, 0, 0)`, `will-change: transform`, or `contain`). On low-end mobile GPUs, animating elements with `blur(100px)` causes continuous software repaints and FPS drops.
  - `.scan-overlay::after` animates height/top instead of GPU-composited 3D transforms (`transform: translate3d(0, -100%, 0)` to `transform: translate3d(0, 100%, 0)`).

### 1.3 Micro-Animations & Framer Motion Integration
- **File**: `apps/web/src/components/ui/GlassCard.tsx` (lines 44–50, 56)
  - Uses CSS transition `transition-all duration-300` and hover class `hover:scale-[1.01]` instead of Framer Motion spring physics.
- **File**: `apps/web/src/components/ui/FuturisticButton.tsx` (lines 86–92)
  - Uses `transition={{ duration: 0.15 }}` on `motion.button` instead of spring physics.
- **File**: `apps/web/src/components/ui/MobileDrawer.tsx` (line 93)
  - Uses `transition={{ type: 'spring', damping: 25, stiffness: 220 }}` (stiffness is 220 instead of the standardized 300).
- **File**: `apps/web/src/App.tsx` (lines 77–108)
  - Navigation phase tab buttons switch active state via static CSS conditional class names without a Framer Motion sliding `layoutId` spring indicator.
- **File**: `apps/web/src/components/ui/`
  - Reusable `ModalDialog.tsx` component with spring backdrop and dialog scale transitions is currently missing from the UI primitives package.

### 1.4 TypeScript Build & Typecheck Audit Findings
- **Command Run**: `npm run typecheck` in `apps/web`
- **Verbatim Errors Observed**:
  - `src/App.tsx(1,8): error TS6133: 'React' is declared but its value is never read.`
  - `src/components/ui/GlassCard.tsx(1,8): error TS6133: 'React' is declared but its value is never read.`
  - `src/components/ui/MobileDrawer.tsx(1,8): error TS6133: 'React' is declared but its value is never read.`
  - `src/components/ui/MobileDrawer.tsx(67,18): error TS2353: Object literal may only specify known properties, and 'y' does not exist in type '{ x: string; }'.`
  - `src/components/ui/MobileDrawer.tsx(68,18): error TS2353: Object literal may only specify known properties, and 'y' does not exist in type '{ x: number; }'.`
  - `src/components/ui/MobileDrawer.tsx(69,15): error TS2353: Object literal may only specify known properties, and 'y' does not exist in type '{ x: string; }'.`
  - `src/components/ui/RadialGauge.tsx(1,8): error TS6133: 'React' is declared but its value is never read.`
  - `src/components/ui/ToastNotification.tsx(1,8): error TS6133: 'React' is declared but its value is never read.`

---

## 2. Logic Chain

### Step 1: Extended Design Token System
1. Adding explicit 50–900 token scales for `emerald`, `amber`, and `rose` in `tailwind.config.js` under `theme.colors` aligns extended visual status signaling across the application:
   - `emerald`: `#ECFDF5` (50) to `#022C22` (900), 500: `#10B981`
   - `amber`: `#FFFBEB` (50) to `#451A03` (900), 500: `#F59E0B`
   - `rose`: `#FFF1F2` (50) to `#4C0519` (900), 500: `#F43F5E`
2. Extending `boxShadow` in `tailwind.config.js`:
   - `'glow-emerald': '0 0 30px rgba(16, 185, 129, 0.25), 0 0 60px rgba(16, 185, 129, 0.1)'`
   - `'glow-amber': '0 0 30px rgba(245, 158, 11, 0.25), 0 0 60px rgba(245, 158, 11, 0.1)'`
   - `'glow-rose': '0 0 30px rgba(244, 63, 94, 0.25), 0 0 60px rgba(244, 63, 94, 0.1)'`
3. Extending `src/index.css` with token-based glass card variants (`.glass-emerald`, `.glass-amber`, `.glass-rose`, `.glass-cyber`, `.glass-neon`) and glowing ring/text classes (`.ring-glow-emerald`, `.text-glow-emerald`, `.ring-glow-amber`, `.text-glow-rose`).

### Step 2: Standardized Spring Physics Micro-Animations & Type Fixes
1. Standardize spring transition config across all UI interactive elements:
   ```typescript
   export const SPRING_TRANSITION = {
     type: 'spring',
     stiffness: 300,
     damping: 25,
   } as const;
   ```
2. Refactor UI primitive components & resolve TypeScript errors:
   - **`GlassCard.tsx`**: Remove unused `React` import (fixes TS6133). Add Framer Motion interaction props:
     ```tsx
     <motion.div
       whileHover={hoverEffect ? { scale: 1.015, y: -2 } : undefined}
       whileTap={hoverEffect ? { scale: 0.99 } : undefined}
       transition={SPRING_TRANSITION}
       className={combinedClasses}
       {...motionProps}
     >
     ```
   - **`FuturisticButton.tsx`**: Update button spring behavior:
     ```tsx
     <motion.button
       whileHover={isDisabled ? undefined : { scale: 1.02 }}
       whileTap={isDisabled ? undefined : { scale: 0.96 }}
       transition={SPRING_TRANSITION}
       ...
     />
     ```
   - **`MobileDrawer.tsx`**: Remove unused `React` import (fixes TS6133). Explicitly type `panelVariants` as `Variant` dictionary from `framer-motion` or `{ initial: Record<string, string | number>; animate: Record<string, string | number>; exit: Record<string, string | number> }` to resolve TS2353 error. Update drawer slide transition to `transition={SPRING_TRANSITION}`.
   - **`ModalDialog.tsx`**: Create primitive component using `AnimatePresence` with backdrop opacity fade and dialog panel spring scale/y animation (`transition={SPRING_TRANSITION}`).
   - **Tab Indicators (`App.tsx` & view tab bars)**: Remove unused `React` import (fixes TS6133). Replace conditional background classes with Framer Motion `layoutId="activeTabPill"` animated `motion.div` using `transition={SPRING_TRANSITION}`.

### Step 3: Mobile GPU Layer & Visual Effects Optimization
1. **Compositor Promotion for Ambient Orbs**:
   - In `src/index.css`, update `.ambient-bg` and `.ambient-bg .orb`:
     ```css
     .ambient-bg {
       position: fixed;
       inset: 0;
       overflow: hidden;
       pointer-events: none;
       z-index: 0;
       contain: strict;
     }

     .ambient-bg .orb {
       position: absolute;
       border-radius: 50%;
       transform: translate3d(0, 0, 0);
       backface-visibility: hidden;
       will-change: transform, opacity;
       filter: blur(80px);
       opacity: 0.15;
       animation: float 8s ease-in-out infinite;
     }
     ```
2. **Mobile Screen Optimization (`@media (max-width: 768px)`)**:
   - Reduce CSS blur radius from `80px/100px` to `35px–40px` on mobile viewports under 768px, or use pre-rendered SVG radial gradients to eliminate live CSS filter calculations on low-end ARM mobile GPUs.
3. **GPU-Accelerated Scanline Overlay**:
   - Refactor `.scan-overlay::after` keyframe animation to animate purely on `transform: translate3d(0, -100%, 0)` to `transform: translate3d(0, 100%, 0)` with `will-change: transform` and `pointer-events: none`.
4. **Reduced Motion Accessibility**:
   - Wrap ambient floating animations and scanlines in `@media (prefers-reduced-motion: reduce)` to pause infinite animations when requested by device/OS accessibility settings.

---

## 3. Caveats

- **Read-Only Scope**: This analysis and implementation strategy is documented for the implementer agent. Code modifications in `apps/web` must be committed by the designated implementer.
- **Hardware Variation**: Frame rate performance on mobile devices varies by GPU architecture. Verification in Chrome DevTools should include enabling GPU compositor rendering visualization (`Rendering > Layer Borders & FPS Meter`).

---

## 4. Conclusion

The analysis and implementation strategy for Milestone 2 Visual Design & Micro-Animations is complete:
1. Extended color tokens (`void`, `cyber`, `neon`, `emerald`, `amber`, `rose`) and corresponding glow shadows defined in `tailwind.config.js` and `src/index.css`.
2. Standardized spring physics transitions (`type: "spring", stiffness: 300, damping: 25`) defined for `GlassCard`, `FuturisticButton`, `MobileDrawer`, `ModalDialog`, and `layoutId` tab indicators, along with exact solutions for the TS unused import and `panelVariants` type mismatch errors.
3. Mobile GPU optimizations specified for ambient background mesh, orb compositor layer promotion, and hardware-accelerated scanline overlays.

---

## 5. Verification Method

To verify implementation:
1. **Type Check**: Run `npm run typecheck` in `apps/web` (verifying 0 TypeScript errors after removing unused `React` imports and typing `panelVariants`).
2. **Production Build**: Run `npm run build` in `apps/web` (verifying Vite build completes cleanly).
3. **Token Verification**: Verify `emerald`, `amber`, `rose` color tokens and `shadow-glow-emerald`, `shadow-glow-amber`, `shadow-glow-rose` in `tailwind.config.js`.
4. **Spring Transition Check**: Inspect `GlassCard.tsx`, `FuturisticButton.tsx`, `MobileDrawer.tsx`, `ModalDialog.tsx`, and `App.tsx` for `stiffness: 300, damping: 25`.
5. **GPU Layer Check**: Inspect `src/index.css` for `transform: translate3d(0,0,0)`, `will-change: transform`, and `@media (max-width: 768px)` mobile GPU optimization rules.
