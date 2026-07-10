# BIS Annual Self-Classification Filing — 2026

Filing package for the annual encryption self-classification report required by Supplement No. 8 to Part 742 of the EAR, under License Exception ENC §740.17(b)(1). Tracks issue #276.

- **Report file:** `bis-self-classification-2026.csv` (this directory)
- **Canonical rationale:** `docs/encryption-export-compliance.md` — the CSV values are derived from that document; if classification facts change, update the doc first, then regenerate the year's CSV
- **Derived:** 2026-06-11, from `docs/encryption-export-compliance.md` and codebase verification (libsignal v0.95.0, Cargo.lock)
- **Deadline:** must reach BIS by **February 1, 2027** (covers calendar year 2026)
- **Official sample:** `project-docs/sample-annual-self-classification-report.xlsx` (BIS-provided; our 12-column format and ITEM TYPE match its "Client App" row; our ECCN/AUTHORIZATION TYPE intentionally differ — see Notes below)

## Before sending — fill in the 4 contact cells

The committed CSV intentionally contains `TODO-*` placeholders so personal contact details are never in git. In your **local copy only**:

1. `TODO-SUBMITTER-NAME` → your name
2. `TODO-TELEPHONE` → e.g. `(555) 555-0000`
3. `TODO-EMAIL` → your email address
4. `TODO-MAILING-ADDRESS` → mailing address — **no commas** (commas are reserved as CSV delimiters; the BIS sample writes `555 Elm St. Washington DC 22032`)

All cells ≤50 characters. Do not commit the filled-in copy.

## Email template A — first filing (2026)

> **To:** crypt-supp8@bis.doc.gov
> **To:** enc@nsa.gov
> **Subject:** Annual Self-Classification Report — Pure Karma Labs — 2026
> **Attachment:** `bis-self-classification-2026.csv`
>
> To whom it may concern,
>
> Please find attached the annual self-classification report for encryption items, submitted pursuant to Supplement No. 8 to Part 742 of the Export Administration Regulations and License Exception ENC, 15 C.F.R. §740.17(b)(1). This report covers calendar year 2026.
>
> Manufacturer/exporter: Pure Karma Labs
>
> Please contact me with any questions.
>
> [Name]
> [Title], Pure Karma Labs
> [Phone] · [Email]

## Email template B — subsequent years, no changes

Use this if nothing changed since the prior report (no new products, no change to ECCN, authorization type, or encryption functionality). Attach the prior year's CSV.

> **To:** crypt-supp8@bis.doc.gov
> **To:** enc@nsa.gov
> **Subject:** Annual Self-Classification Report — Pure Karma Labs — [YEAR]
> **Attachment:** prior year's CSV
>
> To whom it may concern,
>
> Pure Karma Labs has no changes to report for calendar year [YEAR] relative to our previously submitted encryption self-classification report (attached for reference), submitted pursuant to Supplement No. 8 to Part 742 of the EAR and License Exception ENC, 15 C.F.R. §740.17(b)(1).
>
> Please contact me with any questions.
>
> [Name]
> [Title], Pure Karma Labs
> [Phone] · [Email]

If encryption functionality **did** change (new algorithms, new products, ECCN change): update `docs/encryption-export-compliance.md`, copy this year's CSV to `bis-self-classification-[YEAR].csv` with corrected values, and use template A.

## Post-send checklist

- [ ] Save the **sent** email to a private location (not this repo). The sent email IS the compliance record — BIS does not acknowledge or respond to self-classification reports (no license number, no registration number; ERNs were eliminated in 2016). Do not wait for a reply.
- [ ] Tick the checkboxes on issue #276 and close it
- [ ] Confirm next year's reminder issue exists ("ops: BIS annual self-classification re-filing")

## Notes on the 2026 values

- **MODEL NUMBER 1.0** — store-facing version (iOS `MARKETING_VERSION` / Android `versionName`); `package.json` 0.0.1 is internal only.
- **AUTHORIZATION TYPE ENC** — the Supp. 8 code for License Exception ENC §740.17(b)(1) (not the CFR section number; not MMKT, which would imply §742.15(b)/5D992).
- **NON-U.S. COMPONENTS YES** — the ML-KEM (Kyber1024) implementation is `libcrux-ml-kem` (Cryspen / INRIA HACL*, European origin), incorporated via libsignal → `spqr` (SparsePostQuantumRatchet). Verified in `packages/orbital-signal/rust/orbital_signal/Cargo.lock`.
- **NON-U.S. MANUFACTURING LOCATIONS NONE** — the app itself is developed/built in the U.S.; this column is about product manufacturing locations, not component origin.
