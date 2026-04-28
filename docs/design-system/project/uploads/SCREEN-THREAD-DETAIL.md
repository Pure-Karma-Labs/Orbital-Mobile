# Screen: Thread Detail

## Purpose

The most complex screen. Displays a thread's original post and all nested replies with the depth-based color system. Users can read, reply, and react.

## Layout

```
┌─────────────────────────────┐
│        Status Bar            │
├─────────────────────────────┤
│  ‹ Back    Thread Title      │  ← Header
├─────────────────────────────┤
│                              │
│ ┌───────────────────────────┐│
│ │ Level 0: Original Post    ││  ← White bg, gray border
│ │ Author · 2:45 PM          ││
│ │ Post body text here...    ││
│ │ [📷 Photo Grid]           ││
│ └───────────────────────────┘│
│                              │
│ ┃ Level 1: First reply       │  ← Blue 8% bg, blue border
│ ┃ ↳ Replying to Author      │
│ ┃ Reply body text here...   │
│ ┃                            │
│    ┃ Level 2: Nested reply   │  ← Purple 8% bg, purple border
│    ┃ ↳ Replying to Replier   │
│    ┃ More text...            │
│    ┃                         │
│       ┃ Level 3: Deeper      │  ← Blue 12% bg, blue border
│       ┃ ↳ Replying to...    │
│       ┃ Even more text...   │
│                              │
├─────────────────────────────┤
│  [Type a reply...]    [Send] │  ← Fixed reply composer
├─────────────────────────────┤
│  💬 Threads  📨 Chats  ⚙️   │  ← Tab bar
└─────────────────────────────┘
```

## Header

| Property | Value |
|---|---|
| Back button | "‹ Back" in `colors.blue`, `fontSize.base` (13) |
| Title | Thread title, `fontFamily.bodyBold`, `fontSize.lg` (16), single line truncated |
| Background | `colors.surface` |
| Bottom border | 1px `colors.borderSubtle` |

## Message Components

### Original Post (Level 0)

| Property | Value |
|---|---|
| Background | `colors.surfaceElevated` (#FFFFFF) |
| Border | 1px `colors.borderStrong` |
| Border radius | `borderRadius.base` (3) |
| Padding | `spacing.md` (12) |
| Horizontal margin | `spacing.base` (16) |
| Top margin | `spacing.base` (16) |

### Nested Reply (Levels 1-4+)

| Property | Value |
|---|---|
| Background | Per reply depth color system (see Foundation) |
| Left border | 3px, color per depth level |
| Border radius | `borderRadius.base` (3) |
| Padding | `spacing.md` (12) |
| Left margin | `threadIndent.perLevel` (24) × min(level, 4) |
| Right margin | `spacing.base` (16) |
| Top margin | `spacing.sm` (8) between siblings |

### Reply Depth Colors (Quick Reference)

| Level | Left Indent | Background | 3px Left Border |
|---|---|---|---|
| 0 | 0px | White (`surfaceElevated`) | transparent |
| 1 | 24px | Blue 8% (`blueTintLight`) | Blue (`#5B9FED`) |
| 2 | 48px | Purple 8% (`purpleTintLight`) | Purple (`#9B87F5`) |
| 3 | 72px | Blue 12% (`blueTint`) | Blue (`#5B9FED`) |
| 4+ | 96px | Purple 12% (`purpleTint`) | Purple (`#9B87F5`) |

> **Mobile indent exploration:** On 390pt screens, Level 4 leaves ~262pt for content. Generate both 24px/level and 16px/level variants in Figma to compare readability.

### Message Content Layout

| Element | Spec |
|---|---|
| Author name | `fontFamily.bodyBold`, `fontSize.base` (13), `colors.textPrimary` |
| Timestamp | `fontFamily.mono`, `fontSize.xs` (10), `colors.textTertiary`, `letterSpacing.tight` (0.1) |
| Reply context | "↳ Replying to [Author]" — `fontFamily.mono`, `fontSize.sm` (11), `colors.textTertiary` |
| Body text | `fontFamily.body`, `fontSize.base` (13), `colors.textPrimary`, `lineHeight.relaxed` (1.5) |
| Media | Photo grid below text (see SCREEN-MEDIA-GALLERY for grid layouts) |
| Gap: author → body | `spacing.xs` (4) |
| Gap: body → media | `spacing.sm` (8) |

### Message Action Bar

Below each message, visible on tap or always visible (explore both in Figma):

| Action | Icon | Color |
|---|---|---|
| Reply | ↩️ | `colors.textSecondary` |
| React | 😀 | `colors.textSecondary` |
| More | ··· | `colors.textSecondary` |

Touch target: 44 × 32pt per action. Font: `fontSize.sm` (11).

## Reply Composer (Fixed at Bottom)

| Property | Value |
|---|---|
| Position | Fixed above tab bar, above keyboard when active |
| Background | `colors.surface` |
| Top border | 1px `colors.borderSubtle` |
| Padding | `spacing.sm` (8) horizontal, `spacing.sm` (8) vertical |

### Composer Content

| Element | Spec |
|---|---|
| Input field | `components.input` tokens, single line expanding to max 4 lines |
| Placeholder | "Type a reply..." in `colors.textTertiary` |
| Attachment button | 📎 (OpenMoji), 44 × 44pt, `colors.textSecondary` |
| Send button | "Send" text or ➤ icon, `colors.blue`, 44 × 44pt, disabled when empty |
| Reply context | When replying to specific message: "Replying to [Author] ✕" bar above input, `colors.blueTintLight` background |

### Keyboard Active State

- `KeyboardAvoidingView` pushes composer above keyboard
- Thread list scrolls to keep context visible
- Reply context bar shows above input when replying to a specific message

## States

### Loading
Skeleton screen matching the layout: one large rectangle (original post) + 3-4 smaller indented rectangles.

### Empty (Thread with No Replies)
Original post shown, then:
```
·  ·  ·  ✦  ·  ·  ·
```
"Be the first to reply" in `colors.textTertiary`, `fontSize.sm`, centered.

### Error
Banner at top: "Couldn't load replies. Try again." with retry button.

### Pull-to-Refresh
Native `RefreshControl` with `colors.blue` spinner for new replies.

## Interactions

- **Tap reply action** → Sets reply context, focuses composer input
- **Swipe right on message** → Quick reply (blue background reveal, haptic at threshold)
- **Tap media** → Opens media lightbox (full screen)
- **Long press message** → Context menu (copy, reply, react)
- **Pull down** → Refresh for new replies
- **Scroll** → Thread scrolls vertically; deeply nested content wraps within its available width

## Content Examples

**Realistic sample for Figma mockup:**

- **Original post (Level 0):** "Has anyone tried the new farmer's market on Oak Street? Thinking of going this Saturday." — Mom, 10:30 AM
- **Reply (Level 1):** "Yes! The honey vendor is amazing. Get the wildflower variety." — Sarah, 10:45 AM
- **Reply (Level 2):** "Good call, I'll add it to the list. How's parking?" — Mom, 11:02 AM
- **Reply (Level 3):** "Street parking on Elm is free on weekends. Get there before 10." — Alex, 11:15 AM
- **Reply (Level 2):** "They also have fresh bread on Saturdays only." — Dad, 11:30 AM

## Light + Dark Mode

- Message backgrounds use rgba tints that adapt to either background
- Left border colors adjust (dark mode uses `#6BA8F0` blue, `#A895F8` purple)
- Reply context bar: `blueTintLight` works in both modes
- Composer surface: `colors.surface` swaps per theme

## Desktop Reference

Reference `OrbitalThreadDetail.tsx` and `OrbitalMessage.tsx` for the reply depth color system. The indentation + border + background pattern is the core visual to preserve. Desktop wraps messages in cards; mobile should do the same but without the sidebar context.
