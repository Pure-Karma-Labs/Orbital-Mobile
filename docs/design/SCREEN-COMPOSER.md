# Screen: Composer (New Thread / Reply)

## Purpose

Full-screen modal for creating new threads or standalone replies with media attachments.

## Layout

```
┌─────────────────────────────┐
│        Status Bar            │
├─────────────────────────────┤
│  Cancel    New Thread   Send │  ← Header
├─────────────────────────────┤
│  ┌─────────────────────┐    │
│  │  Thread title...    │    │  ← Title input (thread mode only)
│  └─────────────────────┘    │
│  ┌─────────────────────┐    │
│  │                     │    │
│  │  Write something... │    │  ← Body input (auto-expanding)
│  │                     │    │
│  │                     │    │
│  └─────────────────────┘    │
│                              │
│  ┌────┐ ┌────┐ ┌────┐      │  ← Attachment previews (if any)
│  │ 📷 │ │ 📷 │ │ ✕  │      │
│  └────┘ └────┘ └────┘      │
│  ▓▓▓▓▓▓▓░░░░░  65%         │  ← Upload progress (if uploading)
│                              │
├─────────────────────────────┤
│  📷  🖼️  😀               │  ← Attachment bar
├─────────────────────────────┤
│         [ Keyboard ]         │
└─────────────────────────────┘
```

## Header

| Property | Value |
|---|---|
| Background | `colors.surface` |
| Bottom border | 1px `colors.borderSubtle` |
| Cancel button | Left, "Cancel" text, `colors.blue`, `fontSize.base` (13) |
| Title | Center, "New Thread" or "Reply", `fontFamily.bodyBold`, `fontSize.lg` (16) |
| Send button | Right, "Send" text, `colors.blue`, `fontFamily.bodyBold`, disabled when empty (50% opacity) |

## Modes

### New Thread Mode
- Title input + body input
- Title: single-line, `fontFamily.bodyBold`, `fontSize.md` (14), placeholder "Thread title..."
- Body: multi-line, auto-expanding, `fontFamily.body`, `fontSize.base` (13), placeholder "Write something..."

### Reply Mode
- Body input only (no title)
- Context bar above input: "Replying to [Author]" with "✕" dismiss, `colors.blueTintLight` background
- Placeholder: "Write a reply..."

## Input Fields

| Property | Value |
|---|---|
| Background | `colors.surfaceElevated` |
| Border | 1px `colors.borderSubtle`, `colors.blue` on focus |
| Border radius | `borderRadius.base` (3) |
| Padding | `spacing.md` (12) |
| Font | `fontFamily.body`, `fontSize.base` (13) |
| Horizontal margin | `spacing.base` (16) |
| Gap between title and body | `spacing.md` (12) |
| Body min height | 120pt |
| Body max height | Expands to fill available space above attachment bar |

## Attachment Bar

| Property | Value |
|---|---|
| Position | Fixed above keyboard |
| Height | 44pt |
| Background | `colors.surface` |
| Top border | 1px `colors.borderSubtle` |
| Padding | `spacing.sm` (8) horizontal |

| Button | Icon | Action |
|---|---|---|
| Camera | 📷 | Open camera |
| Photo Library | 🖼️ | Open photo picker |
| Emoji | 😀 | Open OpenMoji picker (bottom sheet) |

Each button: 44 × 44pt touch target, `colors.textSecondary`.

## Attachment Previews

| Property | Value |
|---|---|
| Position | Above attachment bar, below body input |
| Layout | Horizontal scroll |
| Thumbnail size | 64 × 64pt |
| Border radius | `borderRadius.base` (3) |
| Remove button | "✕" circle at top-right of each thumbnail, 24 × 24pt |
| Gap between thumbnails | `spacing.sm` (8) |
| Padding | `spacing.base` (16) horizontal |

## Upload Progress

| Property | Value |
|---|---|
| Position | Top edge of the composer — under the header in ComposeThread, first child of the ReplyComposer container |
| Track | `colors.borderSubtle`, 3px height, full width (no animation) |
| Fill | `colors.blue`, `borderRadius.full` |
| Label | "14 MB / 32 MB" in `fontSize.xs` (10), `colors.textSecondary`, right-aligned on its own row under the bar |
| Label (other phases) | "Preparing video…" (transcode), "Encrypting…", "Cancelling…" |
| Batch prefix | "(2/3) " before the MB pair when more than one item is selected |
| Cancel | "X" to the right of the label; 44pt target, `hitSlop` 8; never gated on the composer's busy state |

The bar is batch-overall; the MB readout is per item (a cross-item byte total
would jump, since ciphertext length is only known per item). Cancelling is
non-destructive — draft text, selected media and the reply target all survive —
so it is deliberately not confirmation-gated.

## Quota Warning

When approaching storage limit:

| Property | Value |
|---|---|
| Position | Banner below header |
| Background | `colors.yellowTint` |
| Text | "Storage almost full (85% used)", `fontSize.sm` (11), `colors.yellowDark` |
| Icon | ⚠️ (OpenMoji) |

## States

### Default
Empty inputs, send disabled (50% opacity).

### Composing
Text entered, send enabled. Character count optional in `fontSize.xs`, `colors.textTertiary`.

### Uploading
Attachment previews visible, progress bar active, send disabled until upload completes.

### Sending
Send button shows spinner (16px, white), inputs disabled.

### Draft
If user cancels with content: "Discard draft?" confirmation dialog.

## Interactions

- **Cancel** → If content exists, show discard confirmation. If empty, dismiss immediately.
- **Send** → Haptic (light impact), dismiss modal, show success toast on inbox.
- **Keyboard** → `KeyboardAvoidingView` keeps attachment bar above keyboard.
- **Attachment tap** → Full-size preview in lightbox.

## Light + Dark Mode

- Input backgrounds: `colors.surfaceElevated` swaps per theme
- All border and text tokens swap automatically
- Attachment preview thumbnails unaffected by theme

## Desktop Reference

Reference `OrbitalComposer.tsx` for the title + body field layout and attachment handling. Desktop uses a Quill rich text editor; mobile uses plain `TextInput` with basic formatting.
