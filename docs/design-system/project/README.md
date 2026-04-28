# Orbital Mobile — Design System

> "The Internet When It Was Good." A messaging app whose visual identity is a deliberate, faithful homage to the early-2000s consumer Internet (AIM / MSN Messenger / AOL / phpBB / GeoCities). The retro choices below are not bugs and not oversights — they are the brand.

---

## What is Orbital?

Orbital is a private messaging app for small groups ("orbits" — your family, your roommates, your college friends). It blends modern threaded reply UX with the warmth and texture of the early consumer web: web-safe fonts, solid color blocks, ASCII separators, OpenMoji emoji with black outlines, and 3px corner radii. It feels like 2004, on purpose.

The mobile app is a port of an existing **desktop** app. Tokens, components and copy are already implemented in code; this design system documents and packages them for ongoing design work — primarily mocks, prototypes and Figma frames.

## Hard rules (read these before opening any file)

1. **No gradients, ever.** Solid color fills only.
2. **3px corner radius is the default.** Avatars, badges and the bottom-sheet handle use full-pill (`9999px`). Modals are `4px`. Nothing gets bumped to 8 or 12.
3. **13px is the body text size.** Touch targets are large (44pt min height), but the type inside them stays small. The combination of generous tap area + compact retro type is intentional.
4. **Verdana is body/UI.** It stands in for Bitstream Vera Sans (open-source ancestor, metrically near-identical). Trebuchet MS for headers, Courier New for monospace / timestamps / ASCII art.
5. **OpenMoji emoji.** Black outlines + flat color is part of the brand. Never substitute system emoji.
6. **Reference device is iPhone 14** — 390 × 844pt, 47pt top safe area (Dynamic Island), 34pt bottom (home indicator).

## The hero feature

The **Reply Depth Color System** on the Thread Detail screen is Orbital's visual signature. Replies alternate blue → purple at increasing tint opacity (8% → 12%) as they nest, reinforced by a 3px left border stripe and 24px-per-level indentation (capped at 96px / level 4+). Triple reinforcement: indent + border + tint. If exactly one screen looks perfect in any deliverable, this is the one.

---

## Sources

This system was built from the following materials, which the user supplied as Markdown:

| File (in `uploads/`) | Contents |
|---|---|
| `MOBILE-DESIGN-FOUNDATION.md` | Single source of truth: colors, type, spacing, components, reply depth, ASCII art |
| `MOBILE-PATTERNS.md` | Mobile-only patterns: tab bar, navigation, bottom sheets, gestures, haptics, empty states |
| `SCREEN-AUTH.md` | Login + Signup |
| `SCREEN-INBOX.md` | Thread list (main screen) |
| `SCREEN-THREAD-DETAIL.md` | Nested replies + depth colors |
| `SCREEN-COMPOSER.md` | New thread / reply modal |
| `SCREEN-SETTINGS.md` | Settings + profile |
| `SCREEN-GROUP-MANAGEMENT.md` | Orbits — create / join / members |
| `SCREEN-MEDIA-GALLERY.md` | Photo grids + lightbox |

Referenced (but not provided in this project) desktop source files for visual fidelity:
`OrbitalThreadList.tsx`, `OrbitalThreadItem.tsx`, `OrbitalThreadDetail.tsx`, `OrbitalMessage.tsx`, `OrbitalLogin.tsx`, `OrbitalComposer.tsx`, `OrbitalSettings.tsx`, `OrbitalPhotoGallery.tsx`, `OrbitalPhotoLightbox.tsx`, `CreateGroupModal.tsx`, `JoinGroupModal.tsx`, `GroupSelector.tsx`, plus theme files in `src/theme/`. If you have access to that codebase, prefer it as ground truth over screenshots.

---

## Index — what's in this folder

```
README.md                  ← this file
SKILL.md                   ← invocable skill prompt (Claude Code compatible)
colors_and_type.css        ← all design tokens as CSS custom properties
fonts/                     ← webfonts (substitutes; see "Font substitutions" below)
assets/                    ← logos, OpenMoji set, ASCII art snippets
preview/                   ← Design System tab cards (one HTML per concept)
ui_kits/
  mobile/
    README.md
    index.html             ← interactive iPhone-14-framed click-thru prototype
    *.jsx                  ← per-screen + per-component React sources
uploads/                   ← original brief files (kept for reference)
```

## Content fundamentals

### Voice

- **Warm, direct, personal.** Not corporate, not "playful" in a forced way. Talks like a friend who's been using the Internet since the modem days.
- **"Your orbit," not "your group."** Orbits are the core noun. Members are members, not "users." Threads, not "conversations."
- **Second person ("you"), low-key first-person plural ("we") in onboarding only.** Avoid "users" in copy.
- **No marketing-speak.** No "Empower," "Reimagine," "Streamline," "Unlock." If a sentence could appear on any SaaS landing page, rewrite it.
- **Punctuation is calm.** Periods are fine. Em-dashes are fine. Avoid !!!, avoid ALL CAPS for excitement (ALL CAPS is reserved for system labels and section headers). One sparkle ✦ per screen, max.

### Casing

- **Sentence case** for buttons, titles, list rows, and tab labels: "New thread", "Log out", "Family Orbit". (Proper nouns — orbit names like "Family Orbit", people's names — stay capitalized.)
- **ALL CAPS via mono font** for ASCII section headers: `─── Account Settings ───` is the canonical pattern, not literally uppercased Latin text but mono-font small-cap-feeling separators.
- **lowercase** for placeholder text: "Search threads...", "Type a reply...", "Write something..."

### Tone examples (lifted from the spec)

- Welcome banner: `╔══ Welcome to Orbital! ══╗` / `║   Your orbit awaits...   ║` — earnest, retro, slightly cheesy in a charming way.
- Empty inbox: "No threads yet — create your first! ✦"
- Empty members list: "Invite friends to your orbit! ✦"
- Joined-orbit toast: "Joined [Orbit Name]!"
- Log out confirmation: "Log out of Orbital?"
- Error: "Couldn't load replies. Try again." (contraction; admits the failure; no shame; no apology theatre.)

### Emoji

- **OpenMoji only.** Black 1.5px outline, flat color, slightly hand-drawn feel. Used:
  - Inline in messages (1.15em, vertical-align -0.15em)
  - As reactions (1.8em, centered)
  - In tab bar / list-row icons (1em equivalent)
- **Never decorative.** No emoji-as-pattern, no emoji-confetti, no emoji card backgrounds.
- **Sparkle ✦** is the one true Orbital glyph. Used in empty states, separators, and quiet moments of warmth. Use sparingly — once per screen at most.

### ASCII art

ASCII separators and boxes (mono font, `colors.textTertiary`) are a primary content element, not decoration. The library:

```
─── Today ───                    Day separator / section header
·  ·  ·  ✦  ·  ·  ·               Section break
╭───────────────────────╮         Soft box (empty states, instructions)
│  No threads yet       │
╰───────────────────────╯

╔═══════════════════════════╗     Heavy box (welcome banner only)
║   Welcome to Orbital!     ║
╚═══════════════════════════╝

[●] Online   [○] Offline   [◐] Away   [⊙] DnD     Status indicators
```

Limit: 2–3 ASCII elements per screen. They are texture, not decoration.

---

## Visual foundations

### Color

A solid, flat palette of three families plus a warm neutral set. **Never gradients.**

- **Blue (#5B9FED)** — primary buttons, level-1 / level-3 replies, active states, links. The "trust" color.
- **Purple (#9B87F5)** — secondary buttons, level-2 / level-4+ replies, "Creator" role badge. The co-primary.
- **Yellow (#FFC700)** — notification badges, @mentions, online presence dot. **The accent — used sparingly and only for "look at this."**
- **Warm neutrals** — Warm Canvas (`#FAF9F7` background), Soft Pearl (`#F2F0ED` surface), Cloud White (`#FFFFFF` elevated). Warmer than typical iOS gray; this is part of the cozy texture.
- **Ink Navy (`#2A2D35`)** primary text — slightly bluer-than-black, never pure `#000`.
- **Tints** — `rgba` overlays at 8% / 12% / 15% for reply backgrounds and @mention pills. The same tint sits on top of either light or dark surfaces and reads correctly in both.
- **Semantic** — Success `#48BB78`, Warning `#F59E0B`, Error `#F56565`. Identical in light + dark.

Dark mode darkens the neutrals (`#1A1D24` Midnight Canvas, `#24272F` Charcoal Panel) and lightens the blue/purple a touch (`#6BA8F0`, `#A895F8`) for contrast. Yellow stays.

### Type

- **Verdana (body) / Trebuchet MS (headers) / Courier New (mono).** All web-safe; no custom webfont download required for the app. (Bitstream Vera Sans / Vera Sans Mono are bundled in the production binary; for the web preview we use the Verdana / Trebuchet / Courier triad and the open `Bitstream Vera Sans` Google-Fonts-adjacent fallback.)
- **Scale:** 32 (display) → 20 (h2) → 16 (h3) → 14 (large body) → **13 (THE body default)** → 11 (caption / ASCII) → 10 (timestamps).
- **Weights:** Regular (400) and Bold (700) only. No 500 / 600 stops; the extra weights aren't on the retro web-safe stack.
- **Letter spacing:** 0 default; 0.1px on timestamps; 0.5–2.0px on ASCII art.
- **Line height:** Tight (1.2) for displays, snug (1.3) for h2, normal (1.4) for small text, relaxed (1.5) for body.
- **Bold for emphasis. Underline for links.** Underline is required on links — it is the retro web pattern.

### Spacing & layout

- **8px base unit.** Scale: 4 / 8 / 12 / 16 / 24 / 32 / 48.
- **`spacing.base` (16)** is the standard horizontal screen padding.
- **`spacing.lg` (24)** is the reply indent unit. Levels 0 → 4+ indent at 0 / 24 / 48 / 72 / 96 (capped).
- **Vertical rhythm** is loose. Sections breathe with 16–24px between, never crammed.
- **Layouts are flat columns.** No floating cards over hero images; no z-stacked side decorations. Everything is in the linear scroll order.

### Border radius

- **Default 3px.** Buttons, inputs, post cards, attachment thumbnails — all 3px.
- **2px** on tiny things (duration badges).
- **4px** on full modals.
- **9999px / full-pill** on avatars, presence dots, unread badges, the bottom-sheet handle, the storage-quota bar fill.

### Borders

Borders carry a lot of the visual weight. The system leans on borders + flat fills instead of shadows.

- **`colors.borderSubtle` (#E5E7EB)** — 1px hairlines between list items, around inputs at rest, around the original post card.
- **`colors.borderStrong` (#D1D5DB)** — 1px around emphasized cards (the original post in a thread).
- **3px left stripe** on every reply (color per depth) and on every thread list row (color per state). This stripe is the *single most distinctive* component-level mark in the system.
- **2px input border** on focus (vs 1px default) — the focus state is "the border thickens," not "a glow appears."

### Shadows

**Effectively none.** This system replaces shadow with border. The exceptions:

- **Bottom sheet** has the system-default backdrop only (40% black overlay).
- **Lightbox** sits over a solid black background.
- **Floating action button** (none in current spec, but if added: a 1px border + matching surface, not a shadow).

If you find yourself reaching for `box-shadow`, you're modernizing. Stop.

### Backgrounds

- **Solid fills only.** `colors.background` (warm canvas) on most screens; `colors.surface` (soft pearl) on the tab bar, header, and bottom sheets.
- **No images, illustrations, or patterns** as backgrounds anywhere. The texture comes from ASCII art.
- **No frosted glass / backdrop-blur.** A header is a flat band of `colors.surface` with a 1px bottom hairline; that's it.

### Animation

- **Quick and snappy.** No spring physics, no overshoot, no playful bounces.
- `100ms` tap feedback / `150ms` most transitions / `250ms` modal slide-up.
- **Easing is plain `ease`.** Not custom cubic-beziers. (This is a "we don't fuss about motion" decision; the brand is content not interaction.)
- **Crossfade between login/signup** is 150ms.

### Hover / press / focus

- **Hover** (where applicable on web): swap to the `*Hover` token (`blueHover`, `purpleHover`, `yellowHover`). Same hue, slightly darker.
- **Press** on touch: same hover color is used as the pressed state. Plus a light-impact haptic on iOS for primary actions.
- **Disabled:** 50% opacity, no other change.
- **Focus on inputs:** border thickens to 2px and changes to `colors.blue`. (Not a glow, not a shadow ring.)

### Transparency / blur

- **Tints (rgba 8% / 12% / 15%)** are the only deliberate use of transparency in the UI.
- **Lightbox caption + action bars** sit on a black 60% overlay.
- **Lightbox `+N more` overlay** is black 50%.
- **No backdrop-filter blur anywhere.**

### Imagery

- **Photos rendered as-is** in 3px-rounded thumbnails. No filter, no border, no overlay (except `+N more` and video play button).
- **Lightbox always uses solid black background** in both light + dark modes.
- **No b&w / sepia / grain treatments.** The retro mood comes from chrome and type, not photo treatment.

### Cards

- **Flat surface, 1px border, 3px radius.** No shadow.
- The original post in a thread: `colors.surfaceElevated` (#FFF) on `colors.borderStrong` border.
- The profile card in Settings: `colors.surfaceElevated` on `colors.borderSubtle`.

### Density / layout rules

- **Tab bar height:** 49pt + bottom safe area on iOS.
- **Header height:** 44pt + top safe area.
- **List rows:** 52pt for settings, 64pt min for thread items.
- **Touch targets:** 44 × 44pt absolute minimum, even when icon visuals are 24pt.

---

## Iconography

**Three sources, in priority order:**

1. **OpenMoji** (CC-BY-SA 4.0) — *primary*. Used for every emoji-as-icon in the UI: tab bar, list rows, message reactions, attachment bar, settings rows, presence indicators. Black 1.5px outline, flat color. Never substitute system emoji. We pull the SVG set from the OpenMoji CDN at runtime in HTML mocks; the mobile app bundles the relevant subset.
2. **Unicode glyphs** — for navigational chrome where an emoji would be loud:
   - `‹ Back` (single left-pointing angle quote) on back buttons
   - `▾` for dropdowns
   - `▸` for list-row chevrons
   - `↳` for "Replying to" reply-context lines
   - `✓` for active-state checks
   - `✕` for close / dismiss
   - `✦` for the sparkle accent
   - `●` `○` `◐` `⊙` for status dots
   - `─` `╭` `╮` `╰` `╯` `│` `═` `║` `╔` `╗` `╚` `╝` for ASCII boxes
3. **No SVG icon libraries.** No Lucide, Heroicons, Feather, etc. Adding a stroke-icon library would visually conflict with the OpenMoji-and-Unicode language.

**Logos / brand marks** — The Orbital wordmark + planet mark is bundled in `assets/`:

- `orbital-logo-light-lg.svg` / `orbital-logo-light-small.svg` — black-stroke version, for light backgrounds
- `orbital-logo-darkmode-lg.svg` / `orbital-logo-darkmode-small.svg` — white-stroke version, for dark backgrounds
- `orbital-logo-light.png` — 1080×1080 PNG raster (use for app-icon / OG / favicon contexts)

The mark is three solid-fill planets (yellow `#FFC700`, blue `#5B9FED`, purple `#9B87F5`) with black outlines, orbiting an elliptical 12.5px-stroke ring. It is paired with the wordmark "Orbital" in Trebuchet MS Bold, `colors.blue`, and the welcome ASCII banner (`╔══ Welcome to Orbital! ══╗`) in onboarding.

**Animated loader** — The brand mark also exists as a CSS-only loading animation. Source: `assets/orbital-loader.scss`. Three dots orbit a 32px ring at staggered speeds and directions: blue 4s clockwise, purple 2s counter, yellow 7s counter, all linear / infinite. Live preview: the **Brand Loader** card in the Design System tab. Port the SCSS or copy the inline keyframes from `preview/brand-loader.html`.

OpenMoji file pack: a small subset (the ~30 glyphs actually used in the spec) is checked into `assets/openmoji/`. See `assets/openmoji/README.md` for the manifest. Anything not in the checked-in pack should be fetched from the OpenMoji CDN at the same path.

---

## Font substitutions

The mobile app ships **Bitstream Vera Sans** + **Bitstream Vera Sans Mono** as bundled `.ttf`s. For HTML / web previews we don't bundle the binaries (CC-licensed but heavy); we instead rely on the Verdana / Trebuchet MS / Courier New web-safe stack, which is the documented Figma substitute and is metrically near-identical. **No download is needed for the prototypes to render correctly on macOS, Windows, or iOS.**

If you need the actual Bitstream Vera Sans webfont for production:

- Source: <https://www.gnome.org/fonts/> (original release) / [Bitstream Vera Fonts on Wikipedia](https://en.wikipedia.org/wiki/Bitstream_Vera).
- License: Bitstream Vera Fonts Copyright (permissive; modified versions cannot use the Bitstream name).
- Drop the `.ttf`s into `fonts/` and add an `@font-face` rule. The CSS variables in `colors_and_type.css` already have the correct stack ordered.

> **Fonts:** Brand font binaries are now included in `fonts/` for the **Bold** weight of all three families (`Verdana_Bold.ttf`, `Trebuchet_MS_Bold.ttf`, `Courier_New_Bold.ttf`) and wired up via `@font-face` in `colors_and_type.css`. **Regular weights are NOT supplied** — for non-bold body text the stack falls through to the system Verdana / Courier New, which is metrically identical on macOS / Windows / iOS. If you need a fully self-hosted set, drop in the Regular and Italic TTFs and they'll be picked up by the existing `@font-face` declarations.

---

## How to use this system

- **In a Figma frame / mock:** copy values from `colors_and_type.css` and `MOBILE-DESIGN-FOUNDATION.md`. Layer names match token names (`colors.blue`, `spacing.base`, `fontSize.base`).
- **In an HTML prototype:** include `colors_and_type.css`, then write Verdana-stack typography and `var(--color-blue)`-driven palettes. See `ui_kits/mobile/index.html` for a working iPhone-14-framed click-through.
- **In production code:** the canonical files are `src/theme/{colors,typography,spacing,animation,components,tokens}.ts` in the mobile codebase. This design system mirrors them.

---

## Caveats & open questions

- **No real desktop codebase access.** Spec references `OrbitalThreadList.tsx`, `OrbitalMessage.tsx`, etc. — we built from the spec only. **Ask:** if the desktop repo exists somewhere reachable, point us at it and we'll cross-check the UI kit against the source components.
- **No screenshots / Figma file** were supplied — only the markdown brief. The UI kit is a faithful read of the spec, not a visual recreation of an existing UI. Iteration against real screens would tighten this further.
- **Photo placeholders.** Sample threads in the prototype use solid color blocks where photos appear in the spec. Real product photography would replace these.

---

If anything in this readme contradicts `MOBILE-DESIGN-FOUNDATION.md`, the foundation doc wins. It is the source of truth.
