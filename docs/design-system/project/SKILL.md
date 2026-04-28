---
name: orbital-mobile-design
description: Use this skill to generate well-branded interfaces and assets for Orbital Mobile — a messaging app with a deliberate early-2000s Internet (AIM/MSN/AOL) aesthetic. Contains essential design guidelines, colors, type, fonts, OpenMoji icons and UI kit components for prototyping or production.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files. Pay special attention to:

- `MOBILE-DESIGN-FOUNDATION.md` (in `uploads/`) — the canonical token reference. Match these values exactly.
- `colors_and_type.css` — drop-in CSS custom properties for everything in the foundation doc.
- `ui_kits/mobile/index.html` — interactive iPhone-14-framed click-through that demonstrates every screen.
- `assets/openmoji/` — the OpenMoji glyph subset used across the UI.
- `assets/orbital-logo-{light,darkmode}-{lg,small}.svg` + `orbital-logo-light.png` — official wordmark + planet mark in light & dark variants.
- `assets/orbital-loader.scss` — the brand-mark loading animation (three dots orbiting an elliptical ring; see `preview/brand-loader.html` for an inlined CSS port).

**Hard rules (do not bend):**

1. No gradients, ever — solid color fills only.
2. 3px corner radius is the default. Pill (9999px) on avatars, badges, presence dots. 4px on modals. Nothing else.
3. 13px body text. Touch targets are 44pt minimum but the type stays small — that contrast is the point.
4. Verdana for body / UI. Trebuchet MS for headers. Courier New for mono / timestamps / ASCII.
5. OpenMoji emoji only — black outlines + flat color. Never substitute system emoji.
6. iPhone 14 (390 × 844pt, 47pt top, 34pt bottom) is the reference frame for any mobile mock.

**The hero feature** is the reply depth color system — blue/purple alternation at 8% / 12% tint with a 3px left border stripe and 24px-per-level indentation (capped at 96px / level 4+). If one screen looks perfect, it's the Thread Detail screen.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design — a new screen, a marketing page, a deck slide, a feature mock, etc. — confirm light vs dark mode, ask about copy, and act as an expert designer who outputs HTML artifacts or production code, depending on the need.
