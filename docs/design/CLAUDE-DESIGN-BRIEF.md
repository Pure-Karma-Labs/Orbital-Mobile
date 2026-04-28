# Orbital Mobile — Claude Design Brief

Read this first. It overrides your defaults.

## What This Is

A mobile messaging app with a deliberate **early 2000s Internet aesthetic** (AIM/MSN/AOL era). The design language is ported from a working desktop app. Every token value below is intentional and already implemented in code — your job is to faithfully render them in Figma, not improve them.

## Hard Rules

1. **No gradients, ever.** Solid color fills only. This is a brand rule with zero exceptions.
2. **Do not modernize the border radii.** The default is 3px, not 8px or 12px. This is the retro look. Avatars and badges use 9999px (full circle/pill) — everything else stays sharp.
3. **Do not scale up the font sizes.** Body text is 13px. That is THE standard. Touch targets are large (44pt minimum height) but the text inside them stays small. The combination of generous tap areas with compact retro text is the design intent.
4. **Use Verdana** as the body/UI font. It stands in for Bitstream Vera Sans (the open-source equivalent bundled in the app — metrically identical). Use Trebuchet MS for headers, Courier New for monospace/timestamps/ASCII art.
5. **Use OpenMoji-style emoji**, not system emoji. OpenMoji has black outlines and flat color — it's part of the retro identity. If you can't render OpenMoji, use annotated placeholder frames.
6. **Reference device: iPhone 14 (390 × 844pt).** Generate all screens at this frame size with appropriate safe area insets (47pt top, 34pt bottom).

## The Hero Feature

The **reply depth color system** on the Thread Detail screen is the visual signature of Orbital. Blue and purple tints alternate at increasing opacity as replies nest deeper, reinforced by a 3px left border stripe and indentation. If one screen looks perfect, it should be that one. See `SCREEN-THREAD-DETAIL.md` and the "Reply Depth Color System" section in `MOBILE-DESIGN-FOUNDATION.md`.

## Document Map

Read in this order:

1. **`MOBILE-DESIGN-FOUNDATION.md`** — All design tokens (colors, typography, spacing, components). This is the source of truth.
2. **`MOBILE-PATTERNS.md`** — Mobile-specific patterns (tab bar, navigation, gestures, sheets, empty states).
3. **Screen specs** (one per screen, any order):
   - `SCREEN-AUTH.md` — Login + Signup
   - `SCREEN-INBOX.md` — Thread list (main screen)
   - `SCREEN-THREAD-DETAIL.md` — Nested replies with depth colors
   - `SCREEN-COMPOSER.md` — New thread / reply creation
   - `SCREEN-SETTINGS.md` — Settings + profile
   - `SCREEN-GROUP-MANAGEMENT.md` — Create/join orbits, members
   - `SCREEN-MEDIA-GALLERY.md` — Photo grids, lightbox, video

## Output Expectations

- One Figma page per screen, light mode
- Separate pages for dark mode variants
- Use Figma auto-layout where possible so frames resize cleanly
- Name layers and frames using the token names from the foundation doc (e.g., `colors.blue`, `spacing.base`, `fontSize.base`)
