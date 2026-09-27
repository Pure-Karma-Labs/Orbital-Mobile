# Orbital Mobile — Mobile-Specific UI Patterns

Patterns that exist only on mobile, with no desktop equivalent. Reference `MOBILE-DESIGN-FOUNDATION.md` for all token values.

---

## Device Frame & Safe Areas

### Reference Devices

| Platform | Device | Screen | Status Bar | Bottom Inset |
|---|---|---|---|---|
| iOS | iPhone 14 (reference) | 390 × 844 pt | 47pt (Dynamic Island) | 34pt (home indicator) |
| Android | Pixel 7 (reference) | 360 × 800 dp | 24dp | 48dp (gesture nav) |

### Safe Area Rules

- **Top:** Content starts below status bar. Headers sit in safe area with status bar inset padding.
- **Bottom:** Tab bar and fixed composers sit above home indicator. Use `SafeAreaView` or `useSafeAreaInsets()`.
- **Status bar style:** Dark content on light mode, light content on dark mode.
- **Landscape:** Not supported for MVP. Portrait lock.

---

## Bottom Tab Bar

Three tabs matching `MainTabNavigator.tsx`:

| Tab | Label | Icon (OpenMoji) | Badge |
|---|---|---|---|
| Threads | "Threads" | 💬 | Yellow unread count |
| Chats | "Chats" | 📨 | Yellow unread count |
| Settings | "Settings" | ⚙️ | None |

### Measurements

| Property | iOS | Android |
|---|---|---|
| Bar height | 49pt + bottom safe area | 56dp + bottom inset |
| Background | `colors.surface` | `colors.surface` |
| Top border | 1px `colors.borderSubtle` | 1px `colors.borderSubtle` |
| Icon size | 24pt | 24dp |
| Label font | `fontFamily.body`, `fontSize.xs` (10) | Same |
| Active tint | `colors.blue` | `colors.blue` |
| Inactive tint | `colors.textTertiary` | `colors.textTertiary` |

---

## Navigation

### Stack Navigation (Push/Pop)

Used for drill-down: Inbox → Thread Detail, Settings → Sub-settings.

**Header Bar:**
| Property | Value |
|---|---|
| Height | 44pt (iOS) / 56dp (Android) + top safe area |
| Background | `colors.surface` |
| Bottom border | 1px `colors.borderSubtle` |
| Title font | `fontFamily.bodyBold`, `fontSize.lg` (16) |
| Title color | `colors.textPrimary` |
| Title alignment | Center (iOS), Left (Android) |

**Back Button:**
| Property | Value |
|---|---|
| Style | "‹ Back" text (retro, not just a chevron) |
| Font | `fontFamily.body`, `fontSize.base` (13) |
| Color | `colors.blue` |
| Touch target | 44 × 44pt minimum |

**Right Action Button:**
- "+" for new thread, "Edit" for settings, etc.
- Same style as back button (blue text, 44pt touch target)

### iOS Swipe-Back Gesture

Default iOS edge swipe for back navigation. No custom override.

---

## Pull-to-Refresh

| Property | Value |
|---|---|
| Available on | Thread list, Thread detail |
| Spinner color | `colors.blue` |
| Implementation | Native `RefreshControl` (no custom animation — retro = simple) |
| Haptic | Notification feedback on refresh complete |

---

## Reply Affordance (Thread Detail)

No swipe gestures ship anywhere in the app — the only horizontal gesture is the iOS edge swipe-back. Swipe-to-reply was specified in an earlier draft of this document; the shipped affordance is an explicit **reply arrow** in each reply row's header. A visible control avoids a gesture collision with selectable text and with the edge swipe-back, and it exposes a real target for VoiceOver/TalkBack. See `SCREEN-THREAD-DETAIL.md` → Reply Arrow.

| Property | Value |
|---|---|
| Trigger | Tap the ↩️ arrow (OpenMoji `21A9-FE0F` tinted `colors.textSecondary`, 16pt) at the top-right of a reply's header row |
| Touch target | 44 × 32pt frame + 8pt vertical `hitSlop` = 44 × 48pt effective |
| Result | Sets "Replying to @name" context above the composer and focuses the composer input |
| Unsynced rows | Arrow dimmed (`opacity` 0.5) and inert while pending / syncing / failed — no layout shift when the reply syncs |
| Accessibility | "Reply to [Author], button"; the row container is not a button |

---

## Long-Press Actions

### Long-Press to Mute (Inbox + Chats)

Owner decision (2026-08-03): per-target notification muting is a **long-press** affordance, not a swipe action. Swipe-to-reveal was specified in an earlier draft of this document and was never implemented — a long press keeps the row's tap target undivided, avoids a gesture collision with selectable text, and maps cleanly onto an `accessibilityActions` entry for VoiceOver/TalkBack.

| Property | Value |
|---|---|
| Trigger | Long press on a thread row (Inbox) or a chat row (Chats) |
| Presentation | Native `Alert.alert` action list — the same idiom as the author block/report menu |
| Options | "Mute notifications" / "Unmute notifications" (whichever the current state allows), plus "Cancel" |
| Muted indicator | OpenMoji `1F515` (🔕) in the row's meta line |
| Accessibility | `accessibilityActions` exposes the same mute/unmute action; `accessibilityHint` announces that a long press opens notification options |
| Detail-screen equivalent | Bell glyph in the navigation header right slot — `1F514` (🔔) unmuted, `1F515` (🔕) muted, 8pt `hitSlop` |
| Not available on | Individual messages inside a DM — the whole row is a navigation tap and carries no long-press action; mute the thread from its detail header instead |

---

## Bottom Sheets

Used for: orbit selector, emoji picker, action menus, share sheet.

| Property | Value |
|---|---|
| Background | `colors.surface` |
| Handle pill | 36 × 4px, `colors.borderStrong`, `borderRadius.full` |
| Handle area padding | `spacing.sm` (8) top |
| Corner radius | `borderRadius.lg` (4) top-left and top-right |
| Backdrop | Black at 40% opacity |
| Max height | 60% of screen |
| Dismiss | Tap backdrop or swipe down |

---

## Full-Screen Modals

Used for: composer (new thread), media lightbox, create/join orbit.

| Property | Value |
|---|---|
| Presentation | Slide up from bottom |
| Background | `colors.background` |
| Close button | Top-left "Cancel" text (blue) or top-right "✕" |
| Duration | `duration.base` (250ms) |

---

## Keyboard Avoidance

| Property | Value |
|---|---|
| Behavior | iOS: `padding`, Android: `height` |
| Implementation | `KeyboardAvoidingView` wrapping input areas |
| Affected screens | Auth (login/signup), Thread detail (reply composer), Composer |
| Scroll behavior | Auto-scroll to focused input |

---

## Touch Targets

| Element | Minimum Size | Notes |
|---|---|---|
| Buttons | 44 × 44pt | Already enforced in `Button.tsx` via `minHeight: 44` |
| Tab bar items | 44 × 49pt | Full tab width |
| Thread list rows | Full width × 64pt min | Comfortable tap area |
| Back button | 44 × 44pt | Including text label |
| Message actions | 44 × 48pt effective | Reply arrow on a reply row: 44 × 32pt frame + 8pt vertical `hitSlop` = 44 × 48pt effective (16pt glyph) |
| Reply context jump | Full line width × 48pt effective | "↳ Replying to @name" line above the author row: 32pt frame + 8pt vertical `hitSlop` = 48pt effective. The top slop lands in the row's own `spacing.md` padding and the bottom slop in an 8pt (`spacing.sm`) gap held open below the frame — without that gap the bottom band would sit on the author block, which wins as the later sibling, and the slop would be dead. No horizontal slop — the line already spans the row's content width |
| Collapse toggle | 44 × 48pt effective | "[–] hide N replies" / "[+] N replies" below a reply's body: 44 × 32pt frame (`minWidth` 44) + 8pt vertical `hitSlop` = 44 × 48pt effective. Its 8pt (`spacing.sm`) top margin keeps the upper band clear of the media gallery / link preview card above, which are themselves pressable |
| Author block (reply row) | Full remaining width × 40pt effective | Avatar · name · timestamp: opens Block/Report. `hitSlop` `{top, bottom: 4, left: 4, right: 0}`, where `top` is 4 normally but **0** when a jump control sits directly above it |
| Indented replies | Full remaining width | The reply row itself is **not** a tap target. Even at max indent, the reply arrow in the header row keeps its full target, and the author block keeps its own (no right `hitSlop`, so the two never overlap) |
| DM message rows | Full width × 44pt min | Whole-row tap retained here — that tap is navigation (it opens the thread) |

**Adjacent touchables:** slop never crosses into a neighbouring control, and where two controls sit side by side the more destructive one gives up the shared edge. The author block carries no right `hitSlop` — the reply arrow sits to its right — and drops its top `hitSlop` to 0 whenever the "↳ Replying to @name" jump control sits directly above it: a near-miss below the context line must scroll to the parent, never open the Block/Report sheet. (With no jump control above — a top-level reply, or the untouchable "earlier reply" / "hidden reply" variants — it keeps its 4pt, since nothing is contesting that edge.)

Slop must also have somewhere to land. React Native hit-tests later siblings first, so a slop band that overlaps the next control is simply dead: every vertical band here is backed by a margin or by the row's padding — `spacing.sm` below the context line, `spacing.sm` above the collapse toggle — rather than by the neighbour's frame.

---

## Empty States

Use ASCII box art from the brand guide. Centered vertically in the content area.

**Structure:**
1. ASCII box (mono font, `colors.textTertiary`)
2. Optional subtitle below box (`fontSize.sm`, `colors.textSecondary`)
3. CTA button below (`colors.blue` primary button)

**Example — Empty Thread List:**
```
╭───────────────────────╮
│  No threads yet       │
│  Create your first! ✦ │
╰───────────────────────╯
```
+ "New Thread" primary button below

**Example — Empty Search:**
```
╭─────────────────────────╮
│  No results for "query" │
╰─────────────────────────╯
```

**Example — No Orbits:**
```
╭─────────────────────────────╮
│  Join an orbit to get       │
│  started! ✦                 │
╰─────────────────────────────╯
```
+ "Join Orbit" and "Create Orbit" buttons below

---

## Haptic Feedback

| Moment | Type | Platform |
|---|---|---|
| Send message | Light impact | iOS: `UIImpactFeedbackGenerator(.light)` |
| Pull-to-refresh complete | Notification (success) | iOS: `UINotificationFeedbackGenerator(.success)` |
| Error (validation, network) | Notification (error) | iOS: `UINotificationFeedbackGenerator(.error)` |
| Long press selection | Selection changed | iOS: `UISelectionFeedbackGenerator()` |

Android: use `ReactNativeHapticFeedback` equivalents.

---

## Loading States

### Skeleton Screens

- Use for: thread list initial load, thread detail load
- Shape: rounded rectangles matching content layout
- Color: `colors.borderSubtle` (static, no shimmer — retro = simple)
- Match the layout dimensions of the loaded content

### Inline Spinners

- Use for: button actions, send message, refresh
- Color: `colors.blue` (primary actions), `colors.textTertiary` (secondary)
- Size: 20px default, 16px for inline-with-text

### Progress Bars

- Use for: media upload, file download
- Track: `colors.borderSubtle`
- Fill: `colors.blue`
- Height: 3px
- Border radius: `borderRadius.full`

---

## Error States

### Inline Errors (Form Validation)

- Text: `colors.error`, `fontSize.sm` (11)
- Position: Below the input field, 4px gap
- Input border: changes to `colors.error`

### Banner Errors (Network, Auth)

- Background: `colors.error` at 10% opacity
- Text: `colors.error`, `fontSize.base` (13)
- Icon: ⚠️ (OpenMoji)
- Position: Top of screen, below header
- Dismiss: tap or auto-dismiss after 5s

### Retry States

- "Something went wrong" message centered in content area
- "Try Again" primary button below
- ASCII box optional for empty-state-like presentation
