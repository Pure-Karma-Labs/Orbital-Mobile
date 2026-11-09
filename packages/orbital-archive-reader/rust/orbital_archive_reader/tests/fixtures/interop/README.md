# Interop fixtures

**Real Meta exports are never committed to this repository.** The repository is
public, and an export contains a person's photos, posts and messages. Nothing
derived from a real export — not a file, not a byte range, not a directory
listing — belongs here.

These three archives are **synthetic**: they were generated on 2026-11-09 by
three independent ZIP writers and contain two placeholder files whose contents
were typed by hand:

- `your_instagram_activity/media/posts_1.json` — a 71-byte JSON object with one
  `uri` field.
- `media/posts/a.jpg` — a 48-byte buffer that starts with the JFIF magic and
  says `synthetic-not-a-real-photo`. It is not a decodable image, and it does
  not need to be: this crate never decodes images.

Everything else in the hostile matrix is generated in code by
`tests/support/zipgen.rs`. These three exist only to prove the reader agrees
with writers it did not author, which a self-generated archive cannot show.

| File | Writer | What it exercises |
|---|---|---|
| `infozip_deflate.zip` | Info-ZIP `zip -X -9` | Per-entry method mixing: DEFLATE for the JSON, STORED for the already-incompressible image. General-purpose flags `0x2`. |
| `python_datadescriptor.zip` | CPython `zipfile` writing to a non-seekable sink | General-purpose **bit 3**: sizes and CRC live in a trailing data descriptor, and the central directory is the only trustworthy source. |
| `python_zip64.zip` | CPython `zipfile`, `open(..., force_zip64=True)` | A 20-byte ZIP64 extra field (0x0001) in the local header while the central directory keeps 32-bit values — the shape a strict extra-field parser gets wrong. |

Each file is under 1 KB. Regenerating them is a deliberate act: if a future
change needs a different shape, add a fourth writer rather than editing these,
and record it in this table.
