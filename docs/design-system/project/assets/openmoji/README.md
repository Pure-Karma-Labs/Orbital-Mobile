# OpenMoji glyphs

Orbital uses **OpenMoji** as its sole emoji set. Black 1.5px outline, flat fill.
License: CC-BY-SA 4.0. Attribution: https://openmoji.org/

## Loading

The mobile app bundles the SVG subset listed below. For HTML mocks we load
each glyph from the OpenMoji CDN by codepoint:

```
https://cdn.jsdelivr.net/npm/openmoji@15.1.0/color/svg/{CODEPOINT}.svg
```

(Replace `{CODEPOINT}` with the uppercased hex codepoint, e.g. `1F4AC` for 💬.)

## Glyphs used in the spec

| Codepoint | Glyph | Used as |
|---|---|---|
| `1F4AC` | 💬 | Threads tab, reply count |
| `1F4E8` | 📨 | Chats tab |
| `2699` | ⚙️  | Settings tab (`2699-FE0F` with VS) |
| `1F50D` | 🔍 | Search bar icon |
| `1F4F7` | 📷 | Has-media indicator, camera, attachment |
| `1F5BC` | 🖼️  | Photo library |
| `1F600` | 😀 | Emoji picker / react |
| `1F4CE` | 📎 | Attachment |
| `27A4`  | ➤  | Send icon (alt) |
| `2197`  | ↗  | Reply context |
| `21B3`  | ↳  | Reply-to indicator |
| `1F319` | 🌙 | Dark theme |
| `2600`  | ☀️  | Light theme |
| `1F504` | 🔄 | System theme |
| `1F514` | 🔔 | Notifications |
| `1F4F3` | 📳 | Sounds / vibration |
| `1F512` | 🔒 | Privacy / invite-only |
| `1F441` | 👁 | Read receipts |
| `1F4C1` | 📁 | Storage |
| `1F4E4` | 📤 | Invite, share |
| `1F6AA` | 🚪 | Log out |
| `1FA90` | 🪐 | Family Orbit / planet (default) |
| `1F30D` | 🌍 | College Friends |
| `1F3E0` | 🏠 | Roommates |
| `1F465` | 👥 | Members |
| `1F517` | 🔗 | Join with code |
| `25B6`  | ▶️  | Video play |
| `1F4BE` | 💾 | Save (in lightbox) |
| `26A0`  | ⚠️  | Warning banner |
| `231B`  | ⏳ | Expiring media |

## Sparkle

The glyph `✦` (`U+2726` BLACK FOUR POINTED STAR) is rendered as **plain Unicode text** in `colors.text.tertiary` or `colors.blue`, not as an emoji. Used for empty-state warmth.
