# Screen: Media Gallery & Lightbox

## Purpose

Display media (photos, videos) within thread messages and in a full-screen lightbox viewer. Includes in-message grid layouts, full-screen navigation, and download/expiration handling.

---

## In-Message Photo Grid

Photos attached to a message appear below the message body text. Layout adapts based on count.

### Grid Layouts

**1 Photo:**
```
┌─────────────────────────┐
│                         │
│         Photo           │
│                         │
└─────────────────────────┘
```
Full message width, max height 240pt, `borderRadius.base` (3).

**2 Photos:**
```
┌────────────┐ ┌────────────┐
│            │ │            │
│   Photo 1  │ │   Photo 2  │
│            │ │            │
└────────────┘ └────────────┘
```
Side by side, equal width, `spacing.xs` (4) gap, height 160pt.

**3 Photos:**
```
┌────────────────┐ ┌────────┐
│                │ │ Photo 2│
│    Photo 1     │ ├────────┤
│                │ │ Photo 3│
└────────────────┘ └────────┘
```
Left: 60% width, full height 200pt. Right: 40% width, two stacked, `spacing.xs` (4) gap.

**4+ Photos:**
```
┌────────────┐ ┌────────────┐
│   Photo 1  │ │   Photo 2  │
├────────────┤ ├────────────┤
│   Photo 3  │ │   +3 more  │
└────────────┘ └────────────┘
```
2×2 grid, equal sizing, `spacing.xs` (4) gaps, height 160pt per cell. Last cell shows "+N" overlay if more than 4.

### Grid Properties

| Property | Value |
|---|---|
| Border radius | `borderRadius.base` (3) per image |
| Gap | `spacing.xs` (4) |
| Top margin (from body text) | `spacing.sm` (8) |
| Placeholder | BlurHash or `colors.borderSubtle` background while loading |
| "+N" overlay | Black at 50% opacity, white text, `fontFamily.bodyBold`, `fontSize.xl` (20) |

### Video Thumbnail

| Property | Value |
|---|---|
| Appearance | Same as photo with play button overlay |
| Play icon | ▶️ (OpenMoji) centered, 48 × 48pt, white drop shadow |
| Duration badge | Bottom-right corner, "0:45" in `fontFamily.mono`, `fontSize.xs` (10), white text on black 60% bg, 4px padding, `borderRadius.sm` (2) |

---

## Full-Screen Lightbox

Opened by tapping any photo/video in a message grid.

```
┌─────────────────────────────┐
│ ✕                     1/5   │  ← Close + counter
│                              │
│                              │
│                              │
│         [ Full Photo ]       │
│                              │
│                              │
│                              │
│                              │
│  Author · Apr 25, 2:45 PM  │  ← Caption bar
│  💾 Save    📤 Share         │  ← Action bar
└─────────────────────────────┘
```

### Lightbox Properties

| Property | Value |
|---|---|
| Background | Black (#000000) |
| Presentation | Full-screen modal, fade in at `duration.base` (250ms) |
| Status bar | Hidden (iOS) or light content (Android) |

### Close Button

| Property | Value |
|---|---|
| Position | Top-left, safe area inset |
| Icon | "✕" in white, 44 × 44pt touch target |
| Tap | Dismiss lightbox |

### Image Counter

| Property | Value |
|---|---|
| Position | Top-right, safe area inset |
| Text | "1/5" in white, `fontFamily.mono`, `fontSize.sm` (11) |

### Photo Display

| Property | Value |
|---|---|
| Fit | Aspect-fit (contain), centered |
| Pinch to zoom | Enabled, max 3× zoom |
| Double-tap | Toggle between fit and 2× zoom |

### Navigation

| Property | Value |
|---|---|
| Swipe horizontal | Navigate between photos in the thread |
| Animation | `duration.fast` (150ms) slide |
| Preload | Previous and next images |

### Caption Bar

| Property | Value |
|---|---|
| Position | Bottom, above action bar |
| Background | Black at 60% opacity |
| Text | Author + date, `fontFamily.body`, `fontSize.sm` (11), white |
| Padding | `spacing.md` (12) |

### Action Bar

| Property | Value |
|---|---|
| Position | Bottom, above safe area |
| Background | Black at 60% opacity |
| Padding | `spacing.base` (16) horizontal, `spacing.sm` (8) vertical |

| Action | Icon | Touch Target |
|---|---|---|
| Save | 💾 | 44 × 44pt |
| Share | 📤 | 44 × 44pt |

### Auto-Hide UI

- Tap photo: toggle caption bar, action bar, close button, counter visibility
- Fade in/out at `duration.fast` (150ms)

---

## Video Playback

| Property | Value |
|---|---|
| Player | Native video player (AVPlayer on iOS, ExoPlayer on Android) |
| Controls | Native platform controls (play/pause, scrubber, fullscreen) |
| Autoplay | No — user taps play button |
| Background | Black (#000000) |

---

## Download & Loading States

### Loading (Image)

| Property | Value |
|---|---|
| Placeholder | BlurHash preview (if available) or `colors.borderSubtle` fill |
| Spinner | Circular, white, 24px, centered over placeholder |

### Loading (Full-Size in Lightbox)

| Property | Value |
|---|---|
| Thumbnail | Show grid-size image while full-size loads |
| Progress | Circular progress ring, white, 48px, centered |

### Download Progress

| Property | Value |
|---|---|
| Indicator | Circular progress over blurred thumbnail |
| Color | White ring on black 40% backdrop |
| Size | 48 × 48pt |

---

## Expiration Warning

For media with server-side expiration (ephemeral content):

| Property | Value |
|---|---|
| Banner | Yellow bar at top of lightbox |
| Background | `colors.yellowTint` |
| Text | "Expires in 2 hours" in `fontSize.sm` (11), `colors.yellowDark` |
| Icon | ⏳ (OpenMoji) |

In message grid: small ⏳ badge at top-right corner of expiring thumbnails.

---

## States

### Empty (No Media in Thread)
N/A — media gallery only appears when messages have attachments.

### Error (Failed to Load)
Placeholder with broken image icon (🖼️ with ✕), "Couldn't load image" in `fontSize.sm`, `colors.textTertiary`.
"Retry" link in `colors.blue`.

### Permission Denied (Save)
Toast: "Allow photo access in Settings" with link to app settings.

## Interactions

- **Tap thumbnail in grid** → Open lightbox at that photo
- **Tap "+N" overlay** → Open lightbox at first hidden photo
- **Pinch in lightbox** → Zoom in (max 3×)
- **Swipe down in lightbox** → Dismiss (with drag-to-dismiss animation)
- **Tap video thumbnail** → Open native video player
- **Long press photo** → Context menu: Save, Share, Copy

## Light + Dark Mode

- In-message grids: unaffected (photos are photos)
- Lightbox: always black background regardless of theme
- Grid placeholder: `colors.borderSubtle` adapts per theme
- "+N" overlay: always black 50% opacity (consistent)

## Desktop Reference

Reference `OrbitalPhotoGallery.tsx`, `OrbitalPhotoLightbox.tsx`, and `OrbitalMediaViewer.tsx` for grid layout logic and lightbox interaction patterns. Desktop uses CSS grid; mobile uses flexbox with calculated dimensions.
