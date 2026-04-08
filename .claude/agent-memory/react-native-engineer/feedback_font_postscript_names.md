---
name: Font family strings must use PostScript names, not file names
description: React Native resolves fonts by PostScript name embedded in .ttf, not the filename. Bitstream Vera names differ from file names.
type: feedback
---

Always use the PostScript name when specifying `fontFamily` in React Native — not the file name and not an assumed display name.

Bitstream Vera PostScript names (confirmed by reading the binary name table):
- `BitstreamVeraSans-Roman` (file: BitstreamVeraSans.ttf)
- `BitstreamVeraSans-Bold` (file: BitstreamVeraSans-Bold.ttf)
- `BitstreamVeraSans-Oblique` (file: BitstreamVeraSans-Italic.ttf) ← note "Oblique" not "Italic"
- `BitstreamVeraSansMono-Roman` (file: BitstreamVeraSansMono.ttf)
- `BitstreamVeraSansMono-Bold` (file: BitstreamVeraSansMono-Bold.ttf)

**Why:** Using wrong font names results in system font fallback silently — no crash, just wrong rendering. The discrepancy between "Italic" filename and "Oblique" PostScript name is a known Bitstream Vera quirk.

**How to apply:** When adding new fonts, always extract PostScript name from the binary using the name table (nameID=6). Verify using python3 struct parsing before hardcoding strings.
