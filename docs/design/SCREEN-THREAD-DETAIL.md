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
│ │ Author · Sep 12, 2:45 PM  ││  ← Absolute, never "5m ago"
│ │ Post body text here...    ││
│ │ [📷 Photo Grid]           ││
│ └───────────────────────────┘│
│                              │
│ ┃ ↳ Replying to @Author      │  ← Tap: jump + highlight
│ ┃ Replier · Sep 12, 2:47 PM  │  ← Blue 8% bg, blue border
│ ┃ Reply body text here...    │
│ ┃ [–] hide 2 replies         │  ← Collapse toggle
│                              │
│    ┃ ↳ Replying to @Replier  │  ← Purple 8% bg, purple border
│    ┃ Nester · Sep 12, 2:51PM │
│    ┃ More text...            │
│    ┃ [+] 3 replies           │  ← Collapsed branch
│                              │
│       ┃ ↳ Replying to a      │  ← Blue 12% bg, blue border
│       ┃   hidden reply       │  ← Not touchable, names nobody
│       ┃ Deeper               │  ← Depth ≥ 2: name line…
│       ┃ Sep 12, 3:04 PM      │  ← …timestamp on line 2
│       ┃ Even more text...    │
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
| Timestamp | `fontFamily.mono`, `fontSize.xs` (10), `colors.textTertiary`, `letterSpacing.tight` (0.1) — absolute date + time, see Timestamps |
| Reply context | "↳ Replying to @[Author]" — `fontFamily.mono`, `fontSize.xs` (10); `colors.blue` when it is a jump control, `colors.textTertiary` for the untouchable "earlier reply" / "hidden reply" variants |
| Collapse toggle | "[–] hide N replies" / "[+] N replies" — `fontFamily.mono`, `fontSize.xs` (10), `colors.textTertiary` |
| Body text | `fontFamily.body`, `fontSize.base` (13), `colors.textPrimary`, `lineHeight.relaxed` (1.5) |
| Media | Photo grid below text (see SCREEN-MEDIA-GALLERY for grid layouts) |
| Gap: author → body | `spacing.xs` (4) |
| Gap: body → media | `spacing.sm` (8) |

### Timestamps

Both the original post and every reply show an **absolute** date + time. Nothing in the thread reads "5m ago" — relative times made an old reply and a fresh one look alike once a thread ran over days.

| Property | Value |
|---|---|
| Current year | "Sep 12, 3:04 PM" |
| Past years | "Sep 12, 2025, 3:04 PM" |
| Source | Shared `src/utils/formatPostTimestamp.ts` — one visible formatter plus its spelled-out screen-reader variant, used by both `ThreadHeader` and `ReplyItem`, so the two can never drift apart |
| Style | `fontFamily.mono`, `fontSize.xs` (10), `colors.textTertiary`, `letterSpacing.tight` (0.1) |
| Depth 0–1 (Levels 1–2) | Inline on the header row, right of the author name |
| Depth ≥ 2 (Level 3 and deeper) | Second line under the author name (still inside the author control) — an indented row keeps the name readable at 375pt instead of truncating it to fit the time |
| Accessibility | The author control's label carries the long form: "Actions for [Author], posted September 12 at 3:04 PM" |

`depth` here is the `ReplyItem` prop, not the visual level: depth 0 is a top-level reply (Level 1 in the layout mock), so the second line starts at Level 3. The original post always shows its timestamp inline.

### Reply Context Line (Jump Control)

The "↳ Replying to @[Author]" line is the row's first line, above the header row, and it is a `TouchableOpacity` whenever the parent reply is loaded and on screen. Pressing it scrolls the list to the parent row and briefly highlights it — the same highlight a notification deep link uses.

| Property | Value |
|---|---|
| Text | "↳ Replying to @[Author]" — `fontFamily.mono`, `fontSize.xs` (10), `colors.blue` (the untouchable variants stay `colors.textTertiary`, so colour alone distinguishes a jumpable line) |
| Position | First line of the reply row, directly above the header row (avatar · author name · timestamp) |
| Touch target | Full line width × 32pt frame + `hitSlop` `{top: 8, bottom: 8, left: 0, right: 0}` = 48pt effective height. The frame holds an 8pt (`spacing.sm`) margin below it so the bottom band lands in empty space instead of on the author block |
| Action | Scrolls the list to the parent row and briefly highlights it |
| Accessibility | `accessibilityRole="button"`, label "Go to [Author]'s reply" — no `@`, since the label is spoken; the visible text keeps it. On arrival the screen announces "Showing reply from [Author]" (jump and deep link only — a landing needs no announcement) |

The author control directly below it drops its `hitSlop.top` to 0 for exactly this reason: any top slop there would reach up under the context line, and a near-miss below the line would open the Block/Report sheet instead of jumping. (It keeps its usual 4pt when there is no jump control above — a top-level reply, or the untouchable variants.) A miss on this line must never open an action sheet.

**Parent states** (computed in `replyTree.ts`, from the loaded tree — never from the row alone):

| `parentState` | Line | Touchable |
|---|---|---|
| `none` | No context line — this is a top-level reply | — |
| `jumpable` | "↳ Replying to @[Author]" — names the parent | Yes — jumps to the parent row |
| `orphan` | "↳ Replying to an earlier reply" | No — the parent is not loaded (a later page, or deleted) |
| `hidden` | "↳ Replying to a hidden reply" | No — the parent's author is blocked; the line never names them |

### Collapse / Expand

A reply with visible descendants renders a footer control below its body: `[–] hide N replies` when expanded, `[+] N replies` when collapsed. Collapsing skips the row's whole subtree in the list; the row itself stays.

| Property | Value |
|---|---|
| Label | "[–] hide N replies" (expanded) / "[+] N replies" (collapsed); singular for one ("hide 1 reply") |
| Type | `fontFamily.mono`, `fontSize.xs` (10), `colors.textTertiary` |
| Position | Below the reply body and its media, inside the reply row |
| Touch target | `minWidth` 44 × 32pt frame + 8pt vertical `hitSlop` = 44 × 48pt effective, with an 8pt (`spacing.sm`) top margin so the upper band clears the media gallery / link preview above |
| Shown when | The row has at least one **visible** descendant. N counts the row's whole subtree with blocked authors excluded — a nested collapse does not reduce it, so the number says how much this toggle is responsible for, not how many rows are painted right now |
| Persistence | Per-screen-session only. Collapse state is **not** persisted and resets when the screen unmounts |
| Original post | Never collapsible — `ThreadHeader` carries no toggle |
| Deep link | A deep link into a collapsed branch expands its ancestors so the target row is on screen |
| Accessibility | `accessibilityRole="button"`, `accessibilityState={{ expanded }}`, label "Show N replies to [Author]" / "Hide N replies to [Author]" (the display name, no `@` — it is spoken, not read) |

### Reply Arrow

Each reply row (`ReplyItem`) carries one explicit reply control at the **top-right of its header row** — the same row as the avatar, author name, and timestamp. There is no action bar below the message, no whole-row tap, and no swipe gesture.

| Property | Value |
|---|---|
| Glyph | OpenMoji ↩️ (`21A9-FE0F`) at 16pt, tinted `colors.textSecondary` — the raster is all-black, so untinted it is invisible on dark rows |
| Position | Top-right of the header row (avatar · author name · timestamp) |
| Touch target | 44 × 32pt frame + 8pt vertical `hitSlop` = 44 × 48pt effective |
| Action | Sets the reply context ("Replying to @name" above the composer) and focuses the composer text input, opening the keyboard |
| Unsynced rows | Still rendered, but dimmed (`opacity` 0.5) and inert while the reply is pending / syncing / failed — so the row does not shift when it syncs |
| Accessibility | Reads "Reply to [Author], button" |

The avatar / author name / timestamp remain a separate tappable control that opens the block/report action sheet — it reads "Actions for [Author], posted September 12 at 3:04 PM, button" (the timestamp lives inside the control, so the label carries it in long form) and is disabled on your own rows. Its `hitSlop` drops its top component to 0 under a jump control, so it cannot steal a tap aimed at that control. The row container itself is not announced as a button.

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

- **Tap reply arrow (↩️, top-right of a reply's header row)** → Sets reply context, focuses composer input (keyboard opens). Dimmed and inert until the reply syncs. This is the only way to reply to a specific message — the reply row as a whole is not tappable, and there is no swipe gesture
- **Tap the "↳ Replying to @name" context line** → Scrolls to the parent reply and briefly highlights it. Only when the parent is loaded and visible (`jumpable`); the "earlier reply" and "hidden reply" variants are plain text
- **Tap the collapse toggle ([–] / [+], below a reply's body)** → Hides or shows that reply's subtree for this screen session — not persisted, and never offered on the original post
- **Tap avatar / author name / timestamp** → Block/report action sheet (disabled on your own replies)
- **Tap media** → Opens media lightbox (full screen)
- **Long press reply body** → Native text selection; no reply action fires
- **Pull down** → Refresh for new replies
- **Scroll** → Thread scrolls vertically; deeply nested content wraps within its available width

## Content Examples

**Realistic sample for Figma mockup:**

- **Original post (Level 0):** "Has anyone tried the new farmer's market on Oak Street? Thinking of going this Saturday." — Mom, Sep 12, 10:30 AM
- **Reply (Level 1):** "Yes! The honey vendor is amazing. Get the wildflower variety." — Sarah, Sep 12, 10:45 AM
- **Reply (Level 2):** "Good call, I'll add it to the list. How's parking?" — Mom, Sep 12, 11:02 AM
- **Reply (Level 3):** "Street parking on Elm is free on weekends. Get there before 10." — Alex, Sep 12, 11:15 AM (depth 2 — timestamp on its own second line)
- **Reply (Level 2):** "They also have fresh bread on Saturdays only." — Dad, Sep 12, 11:30 AM

## Light + Dark Mode

- Message backgrounds use rgba tints that adapt to either background
- Left border colors adjust (dark mode uses `#6BA8F0` blue, `#A895F8` purple)
- Reply context bar: `blueTintLight` works in both modes
- Composer surface: `colors.surface` swaps per theme

## Desktop Reference

Reference `OrbitalThreadDetail.tsx` and `OrbitalMessage.tsx` for the reply depth color system. The indentation + border + background pattern is the core visual to preserve. Desktop wraps messages in cards; mobile should do the same but without the sidebar context.
