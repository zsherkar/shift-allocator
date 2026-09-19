# README Media

The images in `images/` were captured on 19 September 2026 from the actual React app built from this repository. They use the read-only fixtures in `scripts/docs-demo.mjs`, not the production service or database. All people are fictional and all email addresses use `example.com`.

The fixture's October 2026 schedule is deterministic and illustrative. It does not run the optimizer and must not be used as evidence of optimizer quality, fairness, or production usage. The app retains its I-House branding and rules even though the repository is now called Shift Allocator.

## Capture the App

```bash
pnpm install --frozen-lockfile
pnpm --filter @workspace/shift-scheduler build
node scripts/docs-demo.mjs
```

The preview binds to `127.0.0.1:4387`. It does not read environment files, connect to PostgreSQL, or accept mutations. Stop it with Ctrl+C. Do not use it as a production server; its synthetic admin session is part of the documentation fixture.

Capture the rendered UI after it has loaded:

| File | Route and UI state |
| --- | --- |
| `dashboard.png` | `/admin/surveys` |
| `create-survey.png` | Dashboard → Create Survey dialog; do not submit |
| `availability.png` | `/respond/demo-october` → enter fictional identity → Next → select a few available shifts → scroll to the top |
| `responses.png` | `/admin/surveys/1` → Responses |
| `allocation.png` | Survey detail → Allocation, before showing the calendar |
| `allocation-stats.png` | Survey detail → Post-Alloc Stats |
| `allocation-audit.png` | Survey detail → Allocation Audit |
| `calendar.png` | Survey detail → Allocation → Show Calendar → Download PNG |

The original browser captures are roughly 1536 × 735 pixels. `calendar.png` is the app's own PNG export, reduced to 1252 × 1962 pixels for the README; it includes the entire month. Other captures preserve the visible interface without replacing labels or results. Different browser dimensions can be used for future captures; the GIF assembler preserves aspect ratio.

## Rebuild the Animation

Requires Python and Pillow. Pillow is only needed for media authoring, not for the application.

```bash
python -m pip install Pillow
python scripts/make-workflow-gif.py
```

The assembler creates `workflow.gif` and `workflow-poster.png`. The GIF is a looping, approximately 19-second guided tour with a common color palette, short fades, and stage labels. It combines captured views rather than pretending to be an uninterrupted recording. Its last panel shows the first two calendar weeks; the README's static calendar contains the complete month.

The screenshots below the animation also provide a non-animated way to inspect the interface. New captures should keep the fictional-data notice and must never contain real credentials, survey tokens, resident names, or email addresses.
