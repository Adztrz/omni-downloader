---
target: Omni downloader
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
target_identity: "file:/home/adztrz/Desktop/Claude/omni-downloader/omni-downloader.user.js"
target_fingerprint: "sha256:b3aa68f6f3c6661ed3916089c686f29ec0402114ecc56d05232652c82525eb05"
target_path: /home/adztrz/Desktop/Claude/omni-downloader/omni-downloader.user.js
timestamp: 2026-11-22T18-23-33Z
slug: omni-downloader-user-js
---
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Per-row progress and outcomes are good; Copy URL / Copy ffmpeg give no feedback; nothing announced to screen readers |
| 2 | Match System / Real World | 3 | Plain voice; "keep .ts", "Copy ffmpeg", "Ghost" are top-level on every row |
| 3 | User Control and Freedom | 2 | Esc only closes while focus is on the host; dead after any redraw |
| 4 | Consistency and Standards | 3 | Save vs Save video; Ghost status above, Save status below the bar; tabs use aria-pressed |
| 5 | Error Prevention | 2 | DRM on multi-quality HLS only revealed after Save; Ghost misconfig found on click |
| 6 | Recognition Rather Than Recall | 2 | Rows titled by kind, not file name; URL truncated at the end (where the name is) |
| 7 | Flexibility and Efficiency | 2 | Alt+D only; no arrows, no Save all for video/audio; focus lost after every action |
| 8 | Aesthetic and Minimalist Design | 3 | Calm, authored; but 4-6 equal buttons per row, a bone primary on every row |
| 9 | Error Recovery | 2 | Ghost errors excellent; fetch errors are bare "HTTP 403" |
| 10 | Help and Documentation | 2 | Footer hints good, but the Esc hint is false; Ghost setup only in README/menu |
| **Total** | | **24/40** | **Acceptable** |

## Priority Issues
1. [P0] Focus dropped to <body> after every keyboard action (draw() rebuilds main: lines ~701-707, flip 734, 400ms onChange 666). Fix: restore focus by key after redraw; toggle selection in place.
2. [P0] Opening doesn't move focus in; Esc only works when activeElement===host (988); close doesn't return focus to the button. Fix: focus filter on open, fab on close, Esc handler on the panel.
3. [P1] Screen readers get nothing: no live region, image cells unnamed (img no alt, 729-730), tabs read "Video1", thumbnail play is a click-only div, dialog without heading. Fix: role=status region, aria-labels, tablist, button thumbnails.
4. [P1] Rows can't be told apart: title is the kind (836), URL truncated at its end (576). Fix: lead with file name/title, kind/size/duration as mono meta, middle-truncate URL.
5. [P2] Empty state lies under an active filter ("No images found yet." with filter "zzz"); Copy has no "Copied" feedback.

## Detector
CLI on the userscript: 0 findings, but blind (CSS is in a JS template string, DOM built in JS). Fixture: 1 cream-palette finding on the host page, false positive. Live overlay cannot see a closed shadow root.
Mechanical: #696a68 thumbnail notes 3.1-3.9:1 at 11px (fails AA); muted on raised 4.96:1 (narrow pass); everything else passes. 11px text: badge, URL line, kbd, .dim, .th notes. Targets: 28-32px controls (pass 2.2 AA 24px). Reduced motion covers keyframes, not hover/active transforms. Fonts Inter / JetBrains Mono never loaded.

## Persona Red Flags
Alex: Alt+D steals the browser's "focus address bar" shortcut on Linux/Windows; no arrows, no per-row keys, double-click save has no keyboard path; focus loss.
Sam: issues 1-3; 3.8:1 notes; tiny native checkbox.
Riley: 100+ items rebuild every row every 400ms with a <video> and a size request each; Images tab doesn't live-update; Ghost batch stops at first error; no RAM warning on long HLS.

## Minor
Badge/aria counts disagree with the Images tab; filter persists across reopen silently; "Saved." lacks the file name; footer's double-click hint shown on Video/Audio tabs; 32px buttons small for touch.

## Questions
What is the panel's one primary action when every row has a bone Save? Is Ghost the default save (split button with remembered preference)? Would a command-palette model (type, arrows, Enter, Shift+Enter → Ghost) suit a keyboard-first tool better than a floating dialog?
