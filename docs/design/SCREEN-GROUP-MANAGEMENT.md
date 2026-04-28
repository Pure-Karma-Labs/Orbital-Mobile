# Screen: Group Management (Orbits)

## Purpose

Create and join orbits, view/manage members. Accessed via the orbit selector on the Inbox screen and from Settings.

## Components

This is not a single screen but a set of bottom sheets and modals:

1. **Orbit Selector** — Bottom sheet listing user's orbits
2. **Create Orbit** — Modal to create a new orbit
3. **Join Orbit** — Modal to join via invite code
4. **Member List** — Pushed screen showing orbit members
5. **Invite Members** — Share invite code/link

---

## 1. Orbit Selector (Bottom Sheet)

```
┌─────────────────────────────┐
│         ━━━━                │  ← Handle pill
├─────────────────────────────┤
│  ─── Your Orbits ───       │
│                              │
│  🪐  Family Orbit    12 👥 ✓│  ← Active orbit (checkmark)
│  🌍  College Friends  8 👥  │
│  🏠  Roommates        4 👥  │
│                              │
│  ·  ·  ·  ✦  ·  ·  ·      │
│                              │
│  [+ Create Orbit]           │
│  [🔗 Join with Code]        │
│                              │
└─────────────────────────────┘
```

| Property | Value |
|---|---|
| Presentation | Bottom sheet (see MOBILE-PATTERNS) |
| Max height | 60% of screen |

### Orbit Item

| Element | Spec |
|---|---|
| Height | 52pt |
| Icon | OpenMoji planet/emoji, left-aligned |
| Name | `fontFamily.bodyBold`, `fontSize.base` (13), `colors.textPrimary` |
| Member count | "N 👥" in `fontSize.sm` (11), `colors.textSecondary` |
| Active indicator | "✓" in `colors.blue`, right side |
| Tap action | Select orbit, dismiss sheet, refresh inbox |

### Action Buttons

| Button | Style |
|---|---|
| Create Orbit | Secondary (purple bg, white text) |
| Join with Code | Outlined (transparent bg, blue border, blue text) |

---

## 2. Create Orbit (Full-Screen Modal)

```
┌─────────────────────────────┐
│  Cancel   Create Orbit  Done│
├─────────────────────────────┤
│                              │
│   🪐 ← Tap to choose emoji │
│                              │
│  ┌─────────────────────┐    │
│  │  Orbit name...      │    │
│  └─────────────────────┘    │
│  ┌─────────────────────┐    │
│  │  Description         │    │
│  │  (optional)          │    │
│  └─────────────────────┘    │
│                              │
│  ─── Privacy ───            │
│                              │
│  🔒  Invite only        ◉  │
│  🌐  Open to all        ○  │
│                              │
└─────────────────────────────┘
```

| Property | Value |
|---|---|
| Presentation | Full-screen modal, slide up |
| Header | Cancel (left, blue), "Create Orbit" (center, bold), Done (right, blue, disabled when name empty) |

| Element | Spec |
|---|---|
| Emoji picker | 64 × 64pt circle, `colors.surfaceElevated`, `borderRadius.full`, centered |
| Name input | `components.input` tokens, placeholder "Orbit name...", required |
| Description input | `components.input` tokens, multi-line, 3-line min height, optional |
| Privacy selector | Radio buttons, `colors.blue` for selected |
| Horizontal margin | `spacing.base` (16) for all inputs |
| Gap between inputs | `spacing.md` (12) |

---

## 3. Join Orbit (Full-Screen Modal)

```
┌─────────────────────────────┐
│  Cancel    Join Orbit       │
├─────────────────────────────┤
│                              │
│  ╭─────────────────────╮    │
│  │  Enter an invite     │    │
│  │  code to join ✦      │    │
│  ╰─────────────────────╯    │
│                              │
│  ┌─────────────────────┐    │
│  │  Invite code...     │    │
│  └─────────────────────┘    │
│                              │
│  ┌─────────────────────┐    │
│  │     Join Orbit       │    │
│  └─────────────────────┘    │
│                              │
│  Or scan QR code            │
│  [📷 Open Camera]           │
│                              │
└─────────────────────────────┘
```

| Element | Spec |
|---|---|
| ASCII box | Instructional text, mono font, `colors.textTertiary` |
| Code input | `components.input` tokens, monospace font (`fontFamily.mono`), center-aligned, large (`fontSize.xl` 20) |
| Join button | Primary (blue bg, white text, bold), full width, 44pt min height |
| QR option | `colors.blue` link text, underlined |

### Deep Link Handling

`orbital://invite/CODE` deep links auto-fill the code input and show a confirmation: "Join [Orbit Name]?" with orbit details and a Join button.

---

## 4. Member List (Pushed Screen)

```
┌─────────────────────────────┐
│  ‹ Back    Family Orbit     │
├─────────────────────────────┤
│                              │
│  ─── 12 Members ───        │
│                              │
│  (●) Mom            Creator │
│  (●) Dad                    │
│  (●) Alex                   │
│  (○) Sarah                  │
│                              │
│  ·  ·  ·  ✦  ·  ·  ·      │
│                              │
│  [📤 Invite Members]        │
│                              │
└─────────────────────────────┘
```

### Member Item

| Element | Spec |
|---|---|
| Height | 52pt |
| Avatar | 36 × 36pt, `borderRadius.full` |
| Display name | `fontFamily.body`, `fontSize.base` (13), `colors.textPrimary` |
| Role badge | "Creator" in `fontSize.xs` (10), `colors.purple`, bold |
| Presence indicator | 8px circle: `colors.yellow` (online), `colors.textTertiary` (offline) |
| Presence position | Bottom-right of avatar, 1px `colors.surfaceElevated` border |
| Gap: avatar → name | `spacing.md` (12) |

---

## 5. Invite Members

| Property | Value |
|---|---|
| Presentation | Bottom sheet |
| Invite code | `fontFamily.mono`, `fontSize.xl` (20), `colors.textPrimary`, center-aligned, selectable |
| Copy button | "Copy Code" secondary button |
| Share button | "Share Link" primary button → opens system share sheet with `orbital://invite/CODE` |
| QR code | Optional: generated QR code below invite code, 200 × 200pt |
| Expiration | "Expires in 7 days" in `fontSize.sm` (11), `colors.textSecondary` |

---

## States

### Loading (Member List)
Skeleton: avatar circles + text rectangles.

### Empty (No Members Besides Self)
```
╭─────────────────────────────╮
│  Invite friends to your     │
│  orbit! ✦                   │
╰─────────────────────────────╯
```
+ "Invite Members" primary button.

### Error (Invalid Code)
Code input border: `colors.error`. Error text below: "Invalid invite code" in `colors.error`, `fontSize.sm`.

### Success (Joined)
Toast: "Joined [Orbit Name]!" with ✓, auto-navigate to inbox filtered to new orbit.

## Light + Dark Mode

All components use standard tokens that swap per theme. QR code: black on white in light mode, white on dark surface in dark mode.

## Desktop Reference

Reference `CreateGroupModal.tsx`, `JoinGroupModal.tsx`, and `GroupSelector.tsx` for feature parity. Desktop uses inline modals; mobile uses full-screen modals and bottom sheets.
