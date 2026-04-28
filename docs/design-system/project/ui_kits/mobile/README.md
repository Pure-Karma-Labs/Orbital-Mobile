# Orbital Mobile — UI Kit

A single interactive HTML file (`index.html`) presenting the Orbital mobile app inside an iPhone 14 frame (390 × 844 pt, 47pt top safe area, 34pt home indicator). Click through:

- **Auth** (Login → Signup) with the welcome ASCII banner
- **Inbox** thread list with day separators, unread/active states, orbit selector
- **Thread Detail** with the **reply depth color system** (the hero)
- **Composer** (new thread) modal
- **Settings** with profile card, ASCII section headers, storage quota bar
- **Orbit Selector** bottom sheet
- **Lightbox** preview

All screens share tokens from `/colors_and_type.css`. Components are inlined as small JSX modules below; `index.html` glues them together.

## Files

```
index.html             ← interactive prototype, iPhone-14 framed
phone.jsx              ← <PhoneFrame> + status bar + tab bar
chrome.jsx             ← <Header>, <BottomSheet>, ASCII helpers
auth.jsx               ← <AuthScreen>
inbox.jsx              ← <InboxScreen>, <ThreadItem>, <DaySeparator>
thread.jsx             ← <ThreadDetail>, <Message>, <ReplyComposer>
composer.jsx           ← <ComposerModal>
settings.jsx           ← <SettingsScreen>, <ProfileCard>, <QuotaBar>
orbits.jsx             ← <OrbitSelectorSheet>
```

## Caveats

- **No real photos.** Photo attachments render as solid color tiles + camera glyph.
- **Static data.** Sending a reply or creating a thread cycles through canned states for the demo.
- **Light mode only** in the prototype. The CSS supports `[data-theme="dark"]`; flip it to verify.
- **OpenMoji is loaded from CDN** (`cdn.jsdelivr.net/npm/openmoji@15.1.0`) by codepoint.
