# Dependency security remediation — 19 September 2026

Original remediation base: `06302f17e58a38c0f601cfe70f9a45986de78405` on `master` (PR #20).

Production backport base: `703265c75c5d8da3fa33e546585d0bb20c6553b7` on `render-monthly-hosting`. The backport preserves the live allocation optimizer, recovery snapshots, membership handling, and all other production features. The API manifest conflict was resolved by retaining `highs` and updating only esbuild. No application logic or database schema changes are included. Production validation passed 91 tests (82 API/allocation, three frontend export/label, six security), and the dependency audit reported zero vulnerabilities. GitHub reported zero open Dependabot alerts after PR #20 merged.

GitHub reported 61 open Dependabot alerts: 11 critical, 25 high, 17 medium and 8 low, across 19 packages. Every reported vulnerable range was checked against every version of its package in the updated lockfile; none still matches. `pnpm audit --json` reports zero vulnerabilities. Its initial total was 60 because the GitHub list includes two esbuild alerts for the same advisory.

No Dependabot malware alerts or repository security advisories/private reports were returned. Code scanning returned HTTP 404, `no analysis found`; this is not evidence of a clean code scan. Secret scanning was not inspected.

## Exposure and fix

- Express parses unauthenticated JSON and URL-encoded bodies before routing. Patched body-parser and qs retain the existing 32 KB limit and authentication controls.
- Eleven critical Orval alerts describe generated-code injection; another concerns external reference resolution. Orval consumes the checked-in API specification during development. No public route accepting OpenAPI input was found. Orval is pinned to 8.22.0, retaining its new restrictive reference defaults.
- DOMPurify/fflate are jsPDF dependencies; tmp/uuid come through ExcelJS. The app exports PDF images and generated workbooks. Exploitation of the advisory-specific sanitization/import APIs through the app was not established.
- Other alerts affect build/development tooling. Package presence alone does not establish a remotely exploitable production endpoint. Initial application-exploitability triage is `needs_review` for every alert; dependency remediation does not assert exploitation occurred.
- Existing security overrides were raised and eight transitive patch floors added. ExcelJS receives UUID 11.1.1, which retains its CommonJS v4 API. Vite remains on major 7; Orval remains on major 8.
- Orval configuration now uses absolute output targets to preserve hand-maintained package exports, the current `formatter` option, and explicit Zod 3 output. Code generation and typechecking of regenerated output were verified; generated application source was then restored to avoid unrelated runtime changes.

## Verification

- `pnpm install --frozen-lockfile` — passed.
- `pnpm --filter @workspace/api-spec run codegen` followed by `pnpm run typecheck` — passed with the updated configuration.
- `pnpm test` — 42 passing tests, including six new security/compatibility checks.
- `pnpm audit --json` — zero vulnerabilities.
- Original qs 6.15.0 threw on the crafted constructor/isBuffer query; original UUID 8.3.2 silently accepted an undersized output buffer. Patched behavior passes regression tests.
- Orval treats template-expression defaults and computed-property names as data, rejects remote and out-of-tree references, and preserves valid query values. ExcelJS writes and reloads a workbook through its UUID v4 conditional-formatting caller.
- `pnpm run build` — passed, including all workspace typechecks and frontend/API builds. Vite emitted non-fatal source-map and bundle-size warnings.
- Isolated production HTTP smoke checks — passed: health, home/login HTML, valid synthetic admin login/session, cookie security flags, unauthenticated admin rejection, cross-origin rejection, malformed/oversized request rejection, and health after a hostile form. A temporary runtime directory was used because Express `sendFile` rejects the `.codex-worktrees` ancestor; the database URL deliberately pointed to an unused port.
- An independent read-only candidate review found no concrete bypass or regression.

No full browser UI or live database workflow was exercised. ExcelJS includes a prebuilt browser bundle with embedded older UUID code; the dependency override updates its Node dependency graph, not that embedded bundle. The app's observed ExcelJS caller uses UUID v4 without an output buffer, and no reachable vulnerable v3/v5/v6 buffer call was found. This is not a claim that every vendored browser library was replaced.

## Alert-by-alert dependency closure

All rows refer to `pnpm-lock.yaml`. “Outside range” means the resolved version no longer matches the specific GitHub advisory range; it is not an exhaustive security guarantee. Alert 32 has no first-patched-version metadata, but 3.4.15 is outside its reported `<=3.4.6` range and the registry audit reports no remaining advisory.

| Alert                                                                              | Severity | Package                  | Resolved version | Advisory            | Result        |
| ---------------------------------------------------------------------------------- | -------- | ------------------------ | ---------------- | ------------------- | ------------- |
| [#85](https://github.com/zsherkar/shift-allocator/security/dependabot/85) | high     | js-yaml                  | 4.3.2            | GHSA-2883-xcg3-v3hh | Outside range |
| [#84](https://github.com/zsherkar/shift-allocator/security/dependabot/84) | medium   | baseline-browser-mapping | 2.11.25          | GHSA-w5vr-8v7q-w6rv | Outside range |
| [#83](https://github.com/zsherkar/shift-allocator/security/dependabot/83) | medium   | qs                       | 6.16.0           | GHSA-4mjr-xmp4-gh2g | Outside range |
| [#82](https://github.com/zsherkar/shift-allocator/security/dependabot/82) | high     | browserslist             | 4.29.0           | GHSA-73wf-gq98-2v4g | Outside range |
| [#81](https://github.com/zsherkar/shift-allocator/security/dependabot/81) | high     | browserslist             | 4.29.0           | GHSA-c83g-rgw3-j3cx | Outside range |
| [#80](https://github.com/zsherkar/shift-allocator/security/dependabot/80) | high     | nanoid                   | 3.3.19           | GHSA-xwg4-73v4-xw9w | Outside range |
| [#79](https://github.com/zsherkar/shift-allocator/security/dependabot/79) | critical | orval                    | 8.22.0           | GHSA-fg9p-mrxr-hvq7 | Outside range |
| [#78](https://github.com/zsherkar/shift-allocator/security/dependabot/78) | critical | orval                    | 8.22.0           | GHSA-88f2-fpv8-89q2 | Outside range |
| [#77](https://github.com/zsherkar/shift-allocator/security/dependabot/77) | critical | orval                    | 8.22.0           | GHSA-w727-8j6c-2rj4 | Outside range |
| [#76](https://github.com/zsherkar/shift-allocator/security/dependabot/76) | critical | orval                    | 8.22.0           | GHSA-2h9g-j24r-h63g | Outside range |
| [#75](https://github.com/zsherkar/shift-allocator/security/dependabot/75) | medium   | fflate                   | 0.8.3            | GHSA-px8p-9vwx-vf98 | Outside range |
| [#74](https://github.com/zsherkar/shift-allocator/security/dependabot/74) | critical | orval                    | 8.22.0           | GHSA-8j6p-r8jg-mxqh | Outside range |
| [#73](https://github.com/zsherkar/shift-allocator/security/dependabot/73) | critical | orval                    | 8.22.0           | GHSA-2w86-xfrc-g85r | Outside range |
| [#72](https://github.com/zsherkar/shift-allocator/security/dependabot/72) | critical | orval                    | 8.22.0           | GHSA-3575-w9fc-c2j6 | Outside range |
| [#71](https://github.com/zsherkar/shift-allocator/security/dependabot/71) | critical | orval                    | 8.22.0           | GHSA-653q-5476-x79g | Outside range |
| [#70](https://github.com/zsherkar/shift-allocator/security/dependabot/70) | critical | orval                    | 8.22.0           | GHSA-6437-gxhq-pqv8 | Outside range |
| [#69](https://github.com/zsherkar/shift-allocator/security/dependabot/69) | high     | fast-uri                 | 3.1.8            | GHSA-jqff-g426-hqxp | Outside range |
| [#68](https://github.com/zsherkar/shift-allocator/security/dependabot/68) | high     | fast-uri                 | 3.1.8            | GHSA-f65p-4m7j-42xc | Outside range |
| [#67](https://github.com/zsherkar/shift-allocator/security/dependabot/67) | medium   | qs                       | 6.16.0           | GHSA-x5fp-wj9c-mxmx | Outside range |
| [#66](https://github.com/zsherkar/shift-allocator/security/dependabot/66) | high     | orval                    | 8.22.0           | GHSA-cxq5-97v7-87j8 | Outside range |
| [#65](https://github.com/zsherkar/shift-allocator/security/dependabot/65) | critical | orval                    | 8.22.0           | GHSA-6mr6-jvcr-2f25 | Outside range |
| [#64](https://github.com/zsherkar/shift-allocator/security/dependabot/64) | critical | orval                    | 8.22.0           | GHSA-p4cg-3328-rvfg | Outside range |
| [#63](https://github.com/zsherkar/shift-allocator/security/dependabot/63) | high     | brace-expansion          | 2.1.7            | GHSA-rgw5-rvv9-x895 | Outside range |
| [#62](https://github.com/zsherkar/shift-allocator/security/dependabot/62) | high     | brace-expansion          | 2.1.7            | GHSA-3jxr-9vmj-r5cp | Outside range |
| [#61](https://github.com/zsherkar/shift-allocator/security/dependabot/61) | high     | nanoid                   | 3.3.19           | GHSA-2v37-7h3g-55p8 | Outside range |
| [#60](https://github.com/zsherkar/shift-allocator/security/dependabot/60) | high     | fast-uri                 | 3.1.8            | GHSA-q3j6-qgpj-74h6 | Outside range |
| [#59](https://github.com/zsherkar/shift-allocator/security/dependabot/59) | high     | fast-uri                 | 3.1.8            | GHSA-v39h-62p7-jpjc | Outside range |
| [#58](https://github.com/zsherkar/shift-allocator/security/dependabot/58) | medium   | postcss                  | 8.5.28           | GHSA-fxqj-rqcc-2cmp | Outside range |
| [#56](https://github.com/zsherkar/shift-allocator/security/dependabot/56) | high     | nanoid                   | 3.3.19           | GHSA-28wg-ghj8-5hjv | Outside range |
| [#55](https://github.com/zsherkar/shift-allocator/security/dependabot/55) | high     | js-yaml                  | 4.3.2            | GHSA-5p4m-2wfm-xmqj | Outside range |
| [#54](https://github.com/zsherkar/shift-allocator/security/dependabot/54) | medium   | dompurify                | 3.4.15           | GHSA-55q2-fjhq-7xh7 | Outside range |
| [#53](https://github.com/zsherkar/shift-allocator/security/dependabot/53) | high     | fast-uri                 | 3.1.8            | GHSA-7p8r-x3mc-p8w7 | Outside range |
| [#52](https://github.com/zsherkar/shift-allocator/security/dependabot/52) | high     | brace-expansion          | 2.1.7            | GHSA-mh99-v99m-4gvg | Outside range |
| [#51](https://github.com/zsherkar/shift-allocator/security/dependabot/51) | high     | postcss                  | 8.5.28           | GHSA-r28c-9q8g-f849 | Outside range |
| [#50](https://github.com/zsherkar/shift-allocator/security/dependabot/50) | high     | postcss                  | 8.5.28           | GHSA-6g55-p6wh-862q | Outside range |
| [#49](https://github.com/zsherkar/shift-allocator/security/dependabot/49) | high     | js-yaml                  | 4.3.2            | GHSA-52cp-r559-cp3m | Outside range |
| [#48](https://github.com/zsherkar/shift-allocator/security/dependabot/48) | high     | fast-uri                 | 3.1.8            | GHSA-v2hh-gcrm-f6hx | Outside range |
| [#47](https://github.com/zsherkar/shift-allocator/security/dependabot/47) | high     | fast-uri                 | 3.1.8            | GHSA-4c8g-83qw-93j6 | Outside range |
| [#46](https://github.com/zsherkar/shift-allocator/security/dependabot/46) | low      | dompurify                | 3.4.15           | GHSA-c2j3-45gr-mqc4 | Outside range |
| [#45](https://github.com/zsherkar/shift-allocator/security/dependabot/45) | high     | linkify-it               | 5.0.2            | GHSA-v245-v573-v5vm | Outside range |
| [#44](https://github.com/zsherkar/shift-allocator/security/dependabot/44) | low      | body-parser              | 2.3.0            | GHSA-v422-hmwv-36x6 | Outside range |
| [#43](https://github.com/zsherkar/shift-allocator/security/dependabot/43) | medium   | js-yaml                  | 4.3.2            | GHSA-h67p-54hq-rp68 | Outside range |
| [#42](https://github.com/zsherkar/shift-allocator/security/dependabot/42) | high     | linkify-it               | 5.0.2            | GHSA-22p9-wv53-3rq4 | Outside range |
| [#41](https://github.com/zsherkar/shift-allocator/security/dependabot/41) | low      | @babel/core              | 7.29.7           | GHSA-4x5r-pxfx-6jf8 | Outside range |
| [#39](https://github.com/zsherkar/shift-allocator/security/dependabot/39) | medium   | dompurify                | 3.4.15           | GHSA-cmwh-pvxp-8882 | Outside range |
| [#38](https://github.com/zsherkar/shift-allocator/security/dependabot/38) | medium   | vite                     | 7.3.6            | GHSA-v6wh-96g9-6wx3 | Outside range |
| [#37](https://github.com/zsherkar/shift-allocator/security/dependabot/37) | high     | vite                     | 7.3.6            | GHSA-fx2h-pf6j-xcff | Outside range |
| [#36](https://github.com/zsherkar/shift-allocator/security/dependabot/36) | low      | dompurify                | 3.4.15           | GHSA-vxr8-fq34-vvx9 | Outside range |
| [#35](https://github.com/zsherkar/shift-allocator/security/dependabot/35) | medium   | dompurify                | 3.4.15           | GHSA-rp9w-3fw7-7cwq | Outside range |
| [#34](https://github.com/zsherkar/shift-allocator/security/dependabot/34) | medium   | markdown-it              | 14.3.2           | GHSA-6v5v-wf23-fmfq | Outside range |
| [#33](https://github.com/zsherkar/shift-allocator/security/dependabot/33) | medium   | dompurify                | 3.4.15           | GHSA-76mc-f452-cxcm | Outside range |
| [#32](https://github.com/zsherkar/shift-allocator/security/dependabot/32) | low      | dompurify                | 3.4.15           | GHSA-x4vx-rjvf-j5p4 | Outside range |
| [#31](https://github.com/zsherkar/shift-allocator/security/dependabot/31) | medium   | dompurify                | 3.4.15           | GHSA-hpcv-96wg-7vj8 | Outside range |
| [#30](https://github.com/zsherkar/shift-allocator/security/dependabot/30) | medium   | dompurify                | 3.4.15           | GHSA-r47g-fvhr-h676 | Outside range |
| [#29](https://github.com/zsherkar/shift-allocator/security/dependabot/29) | low      | dompurify                | 3.4.15           | GHSA-gvmj-g25r-r7wr | Outside range |
| [#26](https://github.com/zsherkar/shift-allocator/security/dependabot/26) | low      | esbuild                  | 0.28.2           | GHSA-g7r4-m6w7-qqqr | Outside range |
| [#25](https://github.com/zsherkar/shift-allocator/security/dependabot/25) | low      | esbuild                  | 0.28.2           | GHSA-g7r4-m6w7-qqqr | Outside range |
| [#24](https://github.com/zsherkar/shift-allocator/security/dependabot/24) | high     | tmp                      | 0.2.7            | GHSA-ph9p-34f9-6g65 | Outside range |
| [#23](https://github.com/zsherkar/shift-allocator/security/dependabot/23) | medium   | qs                       | 6.16.0           | GHSA-q8mj-m7cp-5q26 | Outside range |
| [#22](https://github.com/zsherkar/shift-allocator/security/dependabot/22) | medium   | uuid                     | 11.1.1           | GHSA-w5hq-g745-h8pq | Outside range |
| [#18](https://github.com/zsherkar/shift-allocator/security/dependabot/18) | medium   | postcss                  | 8.5.28           | GHSA-qx2v-qp2m-jg93 | Outside range |

## Delivery boundary

The fix is prepared on an isolated branch. GitHub alerts will close only after the updated lockfile reaches the default branch and GitHub re-evaluates it. Production requires a separate deployment. No production data was changed.
