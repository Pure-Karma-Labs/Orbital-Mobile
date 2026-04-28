# Screen: Settings

## Purpose

App settings and profile management. Section-based list layout with ASCII section headers.

## Layout

```
┌─────────────────────────────┐
│        Status Bar            │
├─────────────────────────────┤
│           Settings           │  ← Header
├─────────────────────────────┤
│                              │
│   ┌──────────────────────┐  │
│   │  (Avatar)  Alex G    │  │  ← Profile card
│   │           Edit →     │  │
│   └──────────────────────┘  │
│                              │
│  ─── Appearance ───         │  ← ASCII section header
│                              │
│   🌙  Theme        Light ▾  │  ← List item with value
│                              │
│  ─── Notifications ───      │
│                              │
│   🔔  Push         On    ▸  │
│   📳  Sounds       On    ▸  │
│                              │
│  ─── Privacy ───            │
│                              │
│   🔒  Safety Numbers     ▸  │
│   👁️  Read Receipts  On  ▸  │
│                              │
│  ─── Storage ───            │
│                              │
│   📁  File Library       ▸  │
│   ▓▓▓▓▓▓░░░░  240/500 MB   │  ← Quota bar
│                              │
│  ─── Account ───            │
│                              │
│   📤  Invite Friends     ▸  │
│   🚪  Log Out               │
│                              │
├─────────────────────────────┤
│  💬 Threads  📨 Chats  ⚙️   │
└─────────────────────────────┘
```

## Header

| Property | Value |
|---|---|
| Title | "Settings", `fontFamily.bodyBold`, `fontSize.lg` (16), centered |
| Background | `colors.surface` |
| Bottom border | 1px `colors.borderSubtle` |

## Profile Card

| Property | Value |
|---|---|
| Position | Top of scroll content |
| Padding | `spacing.base` (16) |
| Background | `colors.surfaceElevated` |
| Border | 1px `colors.borderSubtle`, `borderRadius.base` (3) |
| Horizontal margin | `spacing.base` (16) |
| Top margin | `spacing.base` (16) |

| Element | Spec |
|---|---|
| Avatar | 48 × 48pt, `borderRadius.full`, left-aligned |
| Display name | `fontFamily.bodyBold`, `fontSize.md` (14), `colors.textPrimary`, right of avatar |
| Email/handle | `fontSize.sm` (11), `colors.textSecondary`, below name |
| Edit action | "Edit →" in `colors.blue`, `fontSize.base` (13), right side |
| Gap: avatar → text | `spacing.md` (12) |

## ASCII Section Headers

| Property | Value |
|---|---|
| Format | `─── Section Name ───` |
| Font | `fontFamily.mono`, `fontSize.sm` (11) |
| Color | `colors.textTertiary` |
| Alignment | Center |
| Padding | `spacing.base` (16) top, `spacing.sm` (8) bottom |
| Horizontal margin | `spacing.base` (16) |

## List Items

| Property | Value |
|---|---|
| Height | 52pt minimum |
| Horizontal padding | `spacing.base` (16) |
| Background | `colors.background` |
| Bottom border | 1px `colors.borderSubtle` (between items in same section) |

| Element | Spec |
|---|---|
| Icon | OpenMoji emoji, `fontSize.md` (14), left-aligned |
| Label | `fontFamily.body`, `fontSize.base` (13), `colors.textPrimary` |
| Value/chevron | Right side: value text in `colors.textSecondary` or "▸" chevron |
| Gap: icon → label | `spacing.md` (12) |
| Touch target | Full row width × 52pt |

## Storage Quota Bar

| Property | Value |
|---|---|
| Track | `colors.borderSubtle`, 6px height, `borderRadius.full` |
| Fill | `colors.blue` (normal), `colors.warning` (>75%), `colors.error` (>90%) |
| Label | "240/500 MB" in `fontSize.sm` (11), `colors.textSecondary` |
| Position | Below "File Library" item, `spacing.sm` (8) horizontal padding |

## Theme Toggle

| Property | Value |
|---|---|
| Trigger | Tap "Theme" list item |
| Behavior | Bottom sheet or inline picker with: ☀️ Light, 🌙 Dark, 🔄 System |
| Active indicator | `colors.blue` text on selected option |

## Log Out

| Property | Value |
|---|---|
| Style | `colors.error` text (not a standard button — destructive list item) |
| Tap action | Confirmation dialog: "Log out of Orbital?" with Cancel + "Log Out" (destructive) |

## States

### Loading
Skeleton rectangles for profile card and list items.

### Error
Banner at top if settings fail to load/save.

## Interactions

- **Tap list item** → Push to sub-settings screen (notifications detail, privacy detail, etc.)
- **Tap profile card** → Push to profile edit screen
- **Tap theme** → Opens theme picker (bottom sheet)
- **Tap log out** → Confirmation dialog

## Light + Dark Mode

- Section headers and borders swap via tokens
- Theme toggle reflects current state with matching emoji (☀️/🌙)
- Log out text stays `colors.error` in both modes

## Desktop Reference

Reference `OrbitalSettings.tsx` for section organization and feature list. Desktop uses a modal; mobile uses a full tab screen with push navigation to sub-screens.
