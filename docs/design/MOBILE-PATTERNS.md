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

## Swipe Gestures

### Swipe-to-Reply (Thread Detail)

| Property | Value |
|---|---|
| Direction | Swipe right on a message |
| Reveal | Reply icon on blue background |
| Threshold | 80pt to trigger |
| Haptic | Light impact at trigger threshold |
| Result | Opens reply composer with "Replying to [Author]" context |

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
| Not available on | Individual messages inside a DM (long press there collides with selectable text) — mute the thread from its detail header instead |

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
| Message actions | 44 × 44pt | Reply, react, etc. |
| Indented messages | Full remaining width | Even at max indent, the entire message row is tappable |

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
| Swipe-to-reply threshold | Light impact | iOS: `UIImpactFeedbackGenerator(.light)` |
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
