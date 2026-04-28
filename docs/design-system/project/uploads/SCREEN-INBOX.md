# Screen: Inbox (Thread List)

## Purpose

The main screen. Shows all threads in the selected orbit, grouped by day, with search and pull-to-refresh.

## Layout

```
┌─────────────────────────────┐
│        Status Bar            │
├─────────────────────────────┤
│  ▾ Family Orbit       [+]   │  ← Orbit selector + New Thread
├─────────────────────────────┤
│  🔍 Search threads...       │  ← Search bar
├─────────────────────────────┤
│  ─── Today ───              │  ← ASCII day separator
│                              │
│  ┃ Thread Title One          │  ← 3px left border (blue=active)
│  ┃ Alex · 2:45 PM · 3 💬    │
│  ┃                           │
│  ┃ Thread Title Two          │  ← 3px left border (purple=unread)
│  ┃ Sarah · 1:20 PM · 7 💬 📷│
│  ┃                           │
│  ─── Yesterday ───           │
│                              │
│  ┃ Thread Title Three        │
│  ┃ Mom · 11:00 AM · 12 💬   │
│                              │
│  ·  ·  ·  ✦  ·  ·  ·       │  ← Section separator
│                              │
├─────────────────────────────┤
│  💬 Threads  📨 Chats  ⚙️   │  ← Tab bar
└─────────────────────────────┘
```

### Orbit Selector

| Property | Value |
|---|---|
| Position | Top of screen, below status bar |
| Height | 44pt |
| Background | `colors.surface` |
| Orbit name | `fontFamily.bodyBold`, `fontSize.lg` (16), `colors.textPrimary` |
| Dropdown indicator | "▾" after name, `colors.textSecondary` |
| Tap action | Opens orbit selector bottom sheet |
| Right action | "+" button for new thread, `colors.blue`, 44pt touch target |
| Bottom border | 1px `colors.borderSubtle` |

### Search Bar

| Property | Value |
|---|---|
| Position | Below orbit selector |
| Height | 36pt |
| Horizontal margin | `spacing.base` (16) |
| Vertical margin | `spacing.sm` (8) top and bottom |
| Background | `colors.surfaceElevated` |
| Border | 1px `colors.borderSubtle`, `borderRadius.base` (3) |
| Placeholder | "Search threads..." in `colors.textTertiary` |
| Icon | 🔍 (OpenMoji) at left, `fontSize.sm` |
| Font | `fontFamily.body`, `fontSize.base` (13) |

### Day Separator

| Property | Value |
|---|---|
| Format | `─── Today ───` / `─── Yesterday ───` / `─── Apr 25 ───` |
| Font | `fontFamily.mono`, `fontSize.sm` (11) |
| Color | `colors.textTertiary` |
| Alignment | Center |
| Padding | `spacing.md` (12) vertical |

### Thread Item

| Property | Value |
|---|---|
| Min height | 64pt |
| Horizontal padding | `spacing.base` (16) |
| Vertical padding | `spacing.md` (12) |
| Left border | 3px, color varies by state (see below) |
| Background | varies by state (see below) |

**Thread Item States:**

| State | Left Border | Background |
|---|---|---|
| Default (read) | `colors.borderSubtle` | `colors.background` |
| Active (selected) | `colors.blue` (3px) | `colors.blueTintLight` (8%) |
| Unread | `colors.purple` (3px) | `colors.purpleTintLight` (8%) |

**Thread Item Content:**

| Element | Spec |
|---|---|
| Title | `fontFamily.bodyBold`, `fontSize.base` (13), `colors.textPrimary`. Single line, truncate with ellipsis. |
| Meta line | `fontFamily.body`, `fontSize.sm` (11), `colors.textSecondary` |
| Meta format | "Author · Time · N 💬" (reply count) with optional 📷 (has media) |
| Unread badge | Yellow pill badge per foundation spec, positioned at right edge |
| Gap between title and meta | `spacing.xs` (4) |

### Section Separator (Between Day Groups)

```
·  ·  ·  ✦  ·  ·  ·
```
Font: mono, `fontSize.sm` (11), `colors.textTertiary`, center, `spacing.sm` (8) vertical padding, `letterSpacing.wider` (2.0).

## States

### Loading (Initial)
Skeleton screen: 5-6 thread-item-shaped rounded rectangles in `colors.borderSubtle`.

### Empty
ASCII empty state box centered:
```
╭───────────────────────╮
│  No threads yet       │
│  Create your first! ✦ │
╰───────────────────────╯
```
+ "New Thread" primary button below.

### Empty Search
```
╭─────────────────────────╮
│  No results for "query" │
╰─────────────────────────╯
```

### Error
Banner at top with retry. Thread list shows last cached data if available.

### Pull-to-Refresh
Native `RefreshControl` with `colors.blue` spinner. Haptic on complete.

## Interactions

- **Tap thread item** → Push to Thread Detail screen
- **Tap orbit selector** → Open orbit selector bottom sheet
- **Tap "+"** → Open composer modal (new thread)
- **Swipe left on thread** → Reveal mute/archive actions
- **Pull down** → Refresh thread list
- **Scroll** → Day separators sticky at top (optional, explore in Figma)

## Light + Dark Mode

All tokens swap automatically. Key differences:
- Thread item backgrounds use the same rgba tints (work on both backgrounds)
- Day separator `colors.textTertiary` is the same hex in both modes (#9CA3AF)

## Desktop Reference

Reference `OrbitalThreadList.tsx` and `OrbitalThreadItem.tsx` for thread item visual treatment (left border, title/meta layout). Do NOT replicate the sidebar list width — mobile uses full-screen width.
