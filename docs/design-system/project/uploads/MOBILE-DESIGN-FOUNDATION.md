# Orbital Mobile — Design Foundation

Single source of truth for all design tokens used in Orbital Mobile. Every screen specification references this document.

## Brand Essence

**Core Theme:** "The Internet When It Was Good"
**Aesthetic:** Early 2000s Internet (AIM/MSN/AOL/BBS Era)
**First Impression Goal:** "This feels like 2004 — and I love it."

**Design Principles:**
1. **Retro First, Modern Second** — Web-safe fonts, solid color blocks (no gradients), black-outlined emoji, ASCII art separators
2. **Clarity Through Color** — Reply depth shown through blue/purple color system; indentation + color = double reinforcement
3. **Familiarity Breeds Trust** — Forum threading, buddy lists, yellow badges — patterns grandparents recognize
4. **Warmth Over Polish** — Solid colors feel more human than gradients; slightly rough edges are authentic

**Brand Voice:** "Your orbit" not "your group." Warm, direct, personal.

---

## Color Palette

### Light Mode (Default)

#### Primary — Blue

| Token | Hex | Usage |
|---|---|---|
| `colors.blue` | `#5B9FED` | Primary buttons, level-1 replies, active states |
| `colors.blueHover` | `#4A8CD9` | Pressed/hover state |
| `colors.blueDark` | `#3D7BC4` | Borders, emphasis |
| `colors.blueTintLight` | `rgba(91, 159, 237, 0.08)` | Level-1 reply backgrounds |
| `colors.blueTint` | `rgba(91, 159, 237, 0.12)` | Level-3 reply backgrounds |

#### Co-Primary — Purple

| Token | Hex | Usage |
|---|---|---|
| `colors.purple` | `#9B87F5` | Secondary buttons, level-2 replies |
| `colors.purpleHover` | `#8B75E1` | Pressed/hover state |
| `colors.purpleDark` | `#7B65D1` | Borders, emphasis |
| `colors.purpleTintLight` | `rgba(155, 135, 245, 0.08)` | Level-2 reply backgrounds |
| `colors.purpleTint` | `rgba(155, 135, 245, 0.12)` | Level-4+ reply backgrounds |

#### Accent — Yellow

| Token | Hex | Usage |
|---|---|---|
| `colors.yellow` | `#FFC700` | Notifications, badges, @mentions, presence |
| `colors.yellowHover` | `#FFD633` | Pressed state |
| `colors.yellowDark` | `#EAAD00` | Borders |
| `colors.yellowTint` | `rgba(255, 199, 0, 0.15)` | @mention backgrounds |

#### Neutrals

| Token | Hex | Name | Usage |
|---|---|---|---|
| `colors.background` | `#FAF9F7` | Warm Canvas | Main app background |
| `colors.surface` | `#F2F0ED` | Soft Pearl | Cards, tab bar, panels |
| `colors.surfaceElevated` | `#FFFFFF` | Cloud White | Input fields, top-level posts |
| `colors.textPrimary` | `#2A2D35` | Ink Navy | Body text, headers |
| `colors.textSecondary` | `#6B7280` | Slate Gray | Metadata, labels |
| `colors.textTertiary` | `#9CA3AF` | Mist Gray | Placeholder, disabled, ASCII art |
| `colors.borderSubtle` | `#E5E7EB` | Whisper Gray | Light dividers |
| `colors.borderStrong` | `#D1D5DB` | Soft Shadow | Emphasized borders |

#### Semantic

| Token | Hex | Usage |
|---|---|---|
| `colors.success` | `#48BB78` | Success states |
| `colors.warning` | `#F59E0B` | Warnings |
| `colors.error` | `#F56565` | Errors |

### Dark Mode

| Token | Hex | Usage |
|---|---|---|
| `colors.background` | `#1A1D24` | Midnight Canvas |
| `colors.surface` | `#24272F` | Charcoal Panel |
| `colors.surfaceElevated` | `#2D3139` | Slate Panel |
| `colors.textPrimary` | `#F3F4F6` | Pearl White |
| `colors.textSecondary` | `#C7CCD4` | Silver Gray |
| `colors.textTertiary` | `#9CA3AF` | Fog Gray |
| `colors.borderSubtle` | `#374151` | Shadow Gray |
| `colors.borderStrong` | `#4B5563` | Steel Gray |
| `colors.blue` | `#6BA8F0` | Lightened for dark contrast |
| `colors.purple` | `#A895F8` | Lightened for dark contrast |
| `colors.yellow` | `#FFC700` | Unchanged |

Semantic colors (success, warning, error) remain the same in both modes.

---

## Typography

### Font Families

The app uses **Bitstream Vera Sans** — the open-source ancestor of Verdana, metrically near-identical. Bundled as `.ttf` files in the app binary.

> **For Figma:** Substitute Verdana (body), Trebuchet MS (headers), Courier New (mono). The visual difference is negligible.

| Token | PostScript Name | Figma Substitute | Usage |
|---|---|---|---|
| `fontFamily.body` | `BitstreamVeraSans-Roman` | Verdana Regular | Body text |
| `fontFamily.bodyBold` | `BitstreamVeraSans-Bold` | Verdana Bold | Emphasis, thread titles |
| `fontFamily.bodyItalic` | `BitstreamVeraSans-Oblique` | Verdana Italic | Rare emphasis |
| `fontFamily.header` | `BitstreamVeraSans-Bold` | Trebuchet MS Bold | Section headers |
| `fontFamily.mono` | `BitstreamVeraSansMono-Roman` | Courier New | Timestamps, ASCII art |
| `fontFamily.monoBold` | `BitstreamVeraSansMono-Bold` | Courier New Bold | Emphasized mono |

### Type Scale

All sizes in logical pixels (dp/pt). These are intentionally identical to the desktop — 13px body text is the retro signature.

| Token | Size | Weight | Line Height | Usage |
|---|---|---|---|---|
| `fontSize.2xl` | 32 | Bold | `lineHeight.tight` (1.2) | H1 Display |
| `fontSize.xl` | 20 | Bold | `lineHeight.snug` (1.3) | H2 Section |
| `fontSize.lg` | 16 | Bold | `lineHeight.normal` (1.4) | H3 Subsection |
| `fontSize.md` | 14 | Normal | `lineHeight.relaxed` (1.5) | Body Large |
| `fontSize.base` | 13 | Normal | `lineHeight.relaxed` (1.5) | Body Default (THE standard) |
| `fontSize.sm` | 11 | Normal | `lineHeight.normal` (1.4) | Caption, ASCII art |
| `fontSize.xs` | 10 | Normal | `lineHeight.normal` (1.4) | Timestamps, tiny labels |

### Letter Spacing

| Token | Value (px) | Usage |
|---|---|---|
| `letterSpacing.normal` | 0 | Default |
| `letterSpacing.tight` | 0.1 | Timestamps |
| `letterSpacing.wide` | 0.5 | ASCII art |
| `letterSpacing.wider` | 2.0 | Wide ASCII art |

### Typography Guidelines

- **Bold for emphasis** — use liberally (it's retro)
- **Underline for links** — required (classic web pattern)
- **ALL CAPS for labels** — system text, metadata, section headers
- **Maximum line length** — 65-75 characters for readability

---

## Spacing & Layout

### Spacing Scale (8px base unit)

| Token | Value | Usage |
|---|---|---|
| `spacing.xs` | 4 | Tight spacing |
| `spacing.sm` | 8 | Cozy spacing |
| `spacing.md` | 12 | Comfortable spacing |
| `spacing.base` | 16 | Standard spacing |
| `spacing.lg` | 24 | Spacious (reply indent unit) |
| `spacing.xl` | 32 | Generous |
| `spacing.2xl` | 48 | Wide (rare) |

### Border Radius (Deliberately Retro)

Reduced from modern standards — 3px default, not 8-12px like modern iOS.

| Token | Value | Usage |
|---|---|---|
| `borderRadius.sm` | 2 | Subtle rounding |
| `borderRadius.base` | 3 | Default (buttons, inputs, cards) |
| `borderRadius.md` | 3 | Cards |
| `borderRadius.lg` | 4 | Modals |
| `borderRadius.full` | 9999 | Pills, avatars, badges |

### Thread Indentation

| Token | Value | Usage |
|---|---|---|
| `threadIndent.perLevel` | 24 | Indent per reply depth level |
| `threadIndent.maxIndent` | 96 | Max indent (level 4+, capped) |

> **Mobile consideration:** On a 390pt screen with 16pt horizontal padding, 96px indent leaves ~262pt for content at max depth. Consider exploring 16px/level (64px max) as an alternative during Figma iteration.

---

## Reply Depth Color System

The signature Orbital visual feature. Colors alternate blue → purple with increasing opacity at deeper levels. Combined with left-border stripe and indentation for triple reinforcement.

| Depth | Background | Border (3px left) | Indent |
|---|---|---|---|
| **Level 0** (root post) | `colors.surfaceElevated` (#FFF) | transparent | 0px |
| **Level 1** | `colors.blueTintLight` (blue 8%) | `colors.blue` (#5B9FED) | 24px |
| **Level 2** | `colors.purpleTintLight` (purple 8%) | `colors.purple` (#9B87F5) | 48px |
| **Level 3** | `colors.blueTint` (blue 12%) | `colors.blue` (#5B9FED) | 72px |
| **Level 4+** | `colors.purpleTint` (purple 12%) | `colors.purple` (#9B87F5) | 96px (capped) |

Pattern: Blue at odd levels (1, 3), Purple at even levels (2, 4+). Tint opacity increases from 8% (shallow) to 12% (deep).

---

## Animation

Quick and snappy, not smooth. Simple easing, no spring physics.

| Token | Value | Usage |
|---|---|---|
| `duration.instant` | 100ms | Tap feedback |
| `duration.fast` | 150ms | Most transitions |
| `duration.base` | 250ms | Modal open/close |
| `easing.default` | `ease` | All transitions |

---

## Component Tokens

### Button

| Property | Value |
|---|---|
| Padding | 8px vertical, 16px horizontal |
| Border | 1px |
| Border Radius | 3px (`borderRadius.base`) |
| Font Size | 13px (`fontSize.base`) |
| Font Weight | Bold |
| Min Height | 44px (Apple HIG touch target) |
| Variants | Primary (blue bg), Secondary (purple bg), Destructive (error bg) |
| States | Default, Pressed (hover color), Disabled (50% opacity) |

### Input

| Property | Value |
|---|---|
| Padding | 8px vertical, 12px horizontal |
| Border | 2px |
| Border Radius | 3px |
| Font Size | 13px |
| Background | `colors.surfaceElevated` |
| Border Color | `colors.borderSubtle` (default), `colors.blue` (focused) |
| Placeholder | `colors.textTertiary` |

### Post / Message

| Property | Value |
|---|---|
| Padding | 12px |
| Border Radius | 3px |
| Border | 1px |
| Left Border | 3px (depth indicator stripe — color per depth level) |

### Badge

| Property | Value |
|---|---|
| Padding | 2px vertical, 6px horizontal |
| Min Width | 18px |
| Font Size | 10px (`fontSize.xs`), Bold |
| Border Radius | 9999px (pill) |
| Border | 1px |
| Color | `colors.yellow` background, `colors.textPrimary` text |

---

## Emoji — OpenMoji

Orbital uses OpenMoji for its retro, hand-drawn aesthetic. Black outlines, full color, flat design.

| Property | Value |
|---|---|
| Inline size | 1.15em |
| Reaction size | 1.8em |
| Margin | 0 0.08em |
| Vertical align | -0.15em |

**Usage:**
- In messages: inline with text
- As reactions: 1.8em, centered
- In UI labels (tab icons, button icons): 1em
- Never as decorative background patterns

---

## ASCII Art Library

Monospace font (`fontFamily.mono`), `colors.textTertiary`, max 2-3 ASCII elements per screen.

### Day Separator
```
─── Today ───
```
Font: mono, 11px, `colors.textTertiary`, center-aligned, 12px vertical padding.

### Section Separator
```
·  ·  ·  ✦  ·  ·  ·
```
Font: mono, 11px, `colors.textTertiary`, center-aligned, 8px vertical padding, 0.2em letter-spacing.

### Box (System Messages, Empty States)
```
╭───────────────────────╮
│  No threads yet       │
│  Create your first! ✦ │
╰───────────────────────╯
```
Font: mono, 11px, `colors.textSecondary`, 8px padding, `white-space: pre`.

### Settings Section Header
```
─── Account Settings ───
```
Same as day separator.

### Welcome Banner (Onboarding Only)
```
╔═══════════════════════════╗
║   Welcome to Orbital!     ║
║   Your orbit awaits...    ║
╚═══════════════════════════╝
```

### Status Indicators
```
[●] Online    [○] Offline    [◐] Away    [⊙] Do Not Disturb
```

---

## Source Files

These are the canonical source files in the mobile codebase that implement these tokens:

| File | Contents |
|---|---|
| `src/theme/colors.ts` | Light/dark palettes, `getReplyDepthColors()` |
| `src/theme/typography.ts` | Font families, size scale, weights, spacing |
| `src/theme/spacing.ts` | Spacing scale, border radii, thread indent |
| `src/theme/animation.ts` | Duration, easing |
| `src/theme/components.ts` | Component-level tokens (button, input, post, badge) |
| `src/theme/tokens.ts` | `createTheme()` — single entry-point for complete theme |
