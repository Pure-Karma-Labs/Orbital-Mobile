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
| Reply context jump | Full line width × 48pt effective | "↳ Replying to @name" line above the author row: 32pt frame + 8pt vertical `hitSlop` = 48pt effective. The top slop lands in the row's own `spacing.md` padding and the bottom slop in an 8pt (`spacing.sm`) gap held open below the frame — without that gap the bottom band would sit on the header row below (inline, on the author handle's full-height frame), which wins as the later sibling, and the slop would be dead. No horizontal slop — the line already spans the row's content width |
| Collapse toggle | 44 × 48pt effective | "[–] hide N replies" / "[+] N replies" below a reply's body: 44 × 32pt frame (`minWidth` 44) + 8pt vertical `hitSlop` = 44 × 48pt effective. Its 8pt (`spacing.sm`) top margin keeps the upper band clear of the media gallery / link preview card above, which are themselves pressable |
| Author handle (reply row) | The name or 44pt, whichever is wider × the row's own height | The author's **name** opens Block/Report, and nothing outside the handle's own frame does: the avatar, the timestamp and the row's padding are inert. Sized entirely by its frame, with no `hitSlop` — `ThreadHeader` 44 × 28pt (the avatar sets the row height), `ReplyItem` inline 44 × 32pt (the reply arrow sets it), `ReplyItem` stacked at depth ≥ 2 44 × ~16pt and left-aligned, DM row 44 × 24pt. Row **heights** are unchanged by the handle; its width is not layout-neutral. `minWidth: 44` extends the frame past any name narrower than 44pt — about five characters — which pushes the timestamp right by up to ~29pt, and that blank part of the frame opens Block/Report exactly as the name does. The 44pt floor is kept anyway, and is a reasoned exception to the 44 × 44 minimum: the frame cannot exceed the row height it was given without changing the layout, a one-character display name must stay hittable — a harasser must not be able to shrink their own report target — and the alternative, a row-wide target, is exactly what #888 removed, because it made a destructive action the default outcome of touching the row |
| Indented replies | Full remaining width | The reply row itself is **not** a tap target. Even at max indent, the reply arrow in the header row keeps its full target and the author handle keeps its own: the handle covers the name, the arrow is a sibling to its right, and with no slop on either side of the edge between them the two cannot overlap |
| DM message rows | Full width × 44pt min | Whole-row tap retained here — that tap is navigation (it opens the thread). The author's name sits on top of it as a 44 × 24pt handle that opens Block/Report; the avatar, the time and the unread dot fall through to the row tap. The row is one merged accessible element, so a screen reader reaches Block/Report through a custom action ("Actions for [Author]") rather than a separate element — and because the row is a bare `View` driven by a gesture handler rather than a Touchable, it has to declare `activate` for itself as well (TalkBack's ACTION_CLICK never reaches the gesture handler), on every row including your own |

**Adjacent touchables:** slop never crosses into a destructive neighbour, and where two controls sit side by side the more destructive one gives up the shared edge. The author handle satisfies that by construction, since it has no slop at all: its frame never leaves its own row, so it cannot reach right into the reply arrow beside it, nor up under the "↳ Replying to @name" jump control above it — a near-miss below the context line scrolls to the parent, and can never open the Block/Report sheet.

Slop must also have somewhere to land. React Native hit-tests later siblings first, so a slop band that overlaps the next control is simply dead: every vertical band here is backed by a margin or by the row's padding — `spacing.sm` below the context line, `spacing.sm` above the collapse toggle — rather than by the neighbour's frame. The stronger form of the rule is to size a control by a real frame instead of a band: `replyButtonStyle` and `collapseToggleStyle` each carry their own 44 × 32pt frame, and the author handle now goes the whole way with a frame and no slop whatsoever. The 8pt gap below the "↳ Replying to @name" line stays load-bearing either way, because the header row begins immediately underneath — and inline, the handle's frame spans that row's full height from its very top edge — so the header row wins any overlapping hit as the later sibling.

One band is left contesting a neighbour on purpose: the reply arrow keeps `hitSlop` `{top: 8, bottom: 8, right: 8, left: 0}`, and within the arrow's horizontal range — the right-hand 44pt of the row — its top band does reach up into the jump control's bottom band. That is deliberate and harmless, because the arrow is the later sibling and wins the overlap: the worst case is a near-miss starting a reply instead of jumping, never one opening Block/Report. It pre-dates #888, so the arrow's slop is unchanged.

**One handle per surface, not a shared component:** `ThreadHeader`, `ReplyItem` and `ChatMessageItem` each own their handle rather than sharing an `AuthorHandle`, because the three differ in text component, font, gutter, accessibility treatment and stacked mode — a shared component would only pass those through — and extraction becomes mandatory if a **fourth** author surface appears, or if the `Actions for X` label, the disabled-on-your-own-rows rule or the `minWidth: 44` floor ever drift between the three.

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
