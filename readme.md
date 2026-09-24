# Portugal 2026

A responsive golf holiday scorekeeper for James Hammond, Ben Nowak, Mark Shaw and Owen Shaw. No build step or runtime dependencies.

Run `python app.py`, then open http://localhost:4050. Python 3 is the only runtime requirement; no pip installation or Node.js server is needed. Stop with Ctrl+C. Optional `HOST` and `PORT` environment variables change the listening address and port (defaults: `0.0.0.0`, `4050`).

`app.py` serves the website using Python's standard library. HTML and CSS provide the responsive layouts; browser JavaScript handles interactive scoring and handicap calculations. Keep all root `.py` and `.js` files, `course_defaults.json` and `assets/` alongside `app.py`. Scores, course data and the event log share one SQLite database.

Run server checks with `python -m unittest test_app.py test_live.py`. The optional browser scoring checks use Node.js: `node tests.js`.

For DOM interaction regression checks, run `npm ci` then `node test-controls.js` (development only; Python runtime has no npm requirement). Python adds content hashes to JavaScript and CSS URLs in the served HTML, so browsers and Cloudflare fetch new versions after a deployment rather than keeping old controls cached. Restart `app.py` after changing Python code.


## Admin and existing scores

The small **Log in** button sits just after **The rulebook** on desktop and at the top right on mobile. The requested default login is username `admin`, password `hammonja`. Credentials are checked only by Python, never embedded in public JavaScript. Optional `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables override the defaults. Sessions use random HttpOnly, SameSite cookies, expire after 12 hours, and are invalidated by a server restart. Failed logins are throttled (10 attempts in five minutes per server peer address).

Viewers can navigate, view scores and open course documents. Only logged-in admins can edit handicaps, scores, selected tees, pin awards, tee definitions or uploaded documents, or import a backup. These restrictions are enforced by the server as well as the UI. All devices may use the admin account; each login has its own audit session ID.

On the first deployment, shared scores start empty because the server cannot read other devices' localStorage. Sign in on the browser/URL holding your existing scores and choose **Import this browser’s old scores** in the footer. The confirmation shows the number of entered scores and handicaps; importing replaces shared scores for everyone. Alternatively choose **Import backup** with an existing score JSON. The original browser backup is left intact. An import records its current values as a single explicit event; earlier local edit times and order cannot be recovered.

Concurrent score edits use a version check. A conflicting save reloads shared scores and offers **Download unsaved draft** so the rejected changes are recoverable. Failed/unconfirmed saves preserve a draft too; drafts are never automatically uploaded over someone else's changes. Course edits have separate course version checks. Wait for **Live · saved on server** before leaving the page.

## Complete event history and replay

Admins can choose **Download history JSON** in the footer. This produces one self-contained `portugal-2026-history.json`, including the initial score/course checkpoint, original course reference files, subsequent uploads (base64), and every accepted data mutation in order. Successful/failed logins and logout actions are also recorded. Navigation, viewing and rejected data requests are not scoring events. Passwords, cookies and CSRF tokens are excluded.

Each event includes a monotonic sequence, UTC timestamp, actor, audit session ID, action type and field paths with before/after values. Scores, handicaps, tees, pars, stroke indexes, pin awards, course changes, uploads and imports are covered. A SQLite transaction commits the mutation and event together. Duplicate save retries cannot create duplicate events. Exported integrity hashes detect accidental corruption or missing/reordered events; this is not a cryptographically signed or externally anchored audit log.

Replay with Node.js (no npm packages needed):

```sh
node replay-history.js portugal-2026-history.json > replay.json
node replay-history.js portugal-2026-history.json --at 42 > after-event-42.json
node replay-history.js portugal-2026-history.json --timeline > round-timeline.json
```

The default output contains the reconstructed scores, courses, documents and calculated standings. `--at` reconstructs an earlier event. `--timeline` emits before/after overall standings and round leaders for each event, along with hole/player details, gross birdie/eagle/par labels, net/Stableford results, corrections and cleared scores. This is suitable input for a later AI round summary; no external AI service is contacted. The replay tool and website use the same `scoring.js`. Retain that version of the replay/scoring files with an archive if the competition rules change later.

Timestamps describe when entries were saved, which can differ from the order holes were actually played. Imports and retrospective corrections are labelled; course verification status accompanies results. The tool checks the complete history before emitting a replay and does not modify the running site's database.

## Hosting the live version

Keep the existing `COURSE_DB` path so existing course uploads are preserved. The new score and event tables are added automatically. Run a single Python server process against that database (multiple browser clients are supported). Restart the service after deploying the Python changes. Set `COOKIE_SECURE=1` when serving through HTTPS; leave it unset only for local HTTP development.

The reverse proxy must forward `/api/events` as a streaming response: disable buffering, caching and compression for that route, and use a read timeout greater than 30 seconds (heartbeats arrive every 15 seconds). Do not cache `/api/*`. With Nginx, use `proxy_buffering off`, `proxy_cache off` and `proxy_read_timeout 60s` for `/api/events`. The application also sends `X-Accel-Buffering: no` and `Cache-Control: no-store`. Restrict direct access to the Python port when exposing it through a public HTTPS proxy. Standard-library `http.server` is intended for this small deployment behind a trusted proxy, not as an internet-facing production server.

The database is the durable master history; the JSON is generated on demand from a consistent database snapshot. Keep database backups as well as periodic history exports. Stopping after a successful save or restarting the service does not lose scores/history. A proxy that presents every user as one peer address shares a login-throttle bucket unless it provides distinct trusted peer addresses.

Includes overall standings, four competition trackers, editable 18-hole scorecards, playing handicaps, closest-to-the-pin bonuses and JSON backup/import. Playing handicaps apply directly across all courses. Scramble uses shared gross team scores and is excluded from individual totals and placing points.

Desktop and mobile leaderboards include earnings before the £50 entry fee. Round prizes are £20 per winning player (including each member of a winning pair); overall prizes are £40 for first and £20 for second. Live leaders show provisional winnings. Round winnings become confirmed after 18 commonly scored holes and verified course details. Overall winnings remain provisional until all four rounds are complete, course details are verified, and all four closest-to-the-pin bonuses are awarded. Tied prizes remain unallocated until the tie is resolved in the results; no automatic prize split is assumed. Earnings recalculate from the scores and handicaps, so corrections also update previously confirmed amounts.

Before playing, choose a playing tee on each scorecard and set the four playing handicaps. Until a tee is selected or course data is verified, the initial hole data is provisional (par 4 and stroke indexes 1–18).

Course setup lets you upload a course map and original scorecard (PNG, JPEG, WebP or PDF, up to 10 MB each). Enter and verify each tee's 18 pars, stroke indexes and distances once, in metres or yards. Changing the unit in course setup converts existing distances immediately (1 yard = 0.9144 metres), rounded to whole units. The conversion remains a draft until you choose **Save and play this tee**; saving updates the shared course and selected round on every device. For a new tee, choose the unit before entering distances. Blank distances stay blank. Supported distances are 1–1,000 metres or 1–1,094 yards. Uploaded images/PDFs are reference documents, not automatically OCR-transcribed. Then choose the playing tee from the dropdown; distances appear on desktop and mobile scorecards. Scores and playing handicaps are preserved. If the last par 3 changes, its existing bonus is cleared for reassignment. The selected tee is a snapshot saved with the round; use “Reapply latest saved tee details” to pick up later library edits.

Ombria's official map and scorecard are bundled from https://www.ombria.com/en/golf/golf-course/ (retrieved 2026-09-23), with tees 58 / 53 / 49 / 45, totalling 5,802 / 5,350 / 4,965 / 4,518 metres. Last par 3: hole 17. The map and cropped scorecard remain Ombria's original artwork.

Salgados includes the official 2026 scorecard PDF linked at https://salgadosgolf.com/the-course and the course layout from https://algarvegolf.net/images/courselayouts/salgados.gif. All six tee colours are selectable in metres, using pars and distances from the official PDF. Stroke indexes come from https://stimp.tech/golf/salgados-golf-club-7b773b and need club confirmation after renovation; they do not affect the gross scramble. Its last par 3 is hole 17. The map is labelled as an older reference whose renovation status is unconfirmed. Original documents are preserved unchanged. On startup, missing bundled document references are added to existing course databases without replacing uploaded files or saved tee definitions.

Python stores the shared course library and uploaded documents in `data/courses.sqlite3`, created on first launch. The server needs write access to that directory. Set `COURSE_DB` to a persistent path if your host replaces the application directory during deployment, and retain this file across deployments. Scores, handicaps, tee selections, pin awards, course files and tee definitions are shared by all devices. All write endpoints require an admin session and CSRF token. Version checks reject conflicting edits. Back up this database with SQLite's backup API, or stop the server before copying it. Once event history starts, startup no longer silently updates course definitions; changes must go through the audited APIs.

Tied individual placings share the points for their occupied places. Live placing points compare holes scored by all four players. Team competition totals also compare commonly completed holes. Final prize ties are displayed as tied for the group to resolve.

The server is authoritative. EventSource pushes full snapshots after changes; every browser recalculates standings, competitions and earnings using the same scoring engine. A 15-second fallback refresh handles buffered proxies and suspended phones. Reconnection fetches the current snapshot. The app disables editing when disconnected; it does not silently save offline edits as if they were shared. Use HTTPS and a reverse proxy for a public deployment.

At screen widths of 760px and below, the site automatically uses mobile navigation, compact leaderboard cards and hole-by-hole score entry. Desktop keeps the original tables. Mobile scores use the same server storage and calculations, with numeric entry, plus/minus controls, a hole picker, and a full-scorecard toggle. Blank scores remain unplayed; the first plus/minus tap starts at par. Opening a round starts at its first incomplete hole, unless a hole was already selected during this visit.

On a phone on the same Wi-Fi, open `http://<computer-LAN-IP>:4050` while `app.py` is running (subject to your computer's firewall). Away from that network, use the deployed site URL. `localhost` refers to the phone itself, not your development computer. Every device uses the same live scores. An internet connection is needed to edit. Existing browser backups are tied to the original URL; import them from that browser after logging in, or export them from the old site and import the JSON.


Faldo and O'Connor Jnr. include the supplied aerial maps and the club-published scorecards dated 25 October 2019. Five Faldo tee colours and seven O'Connor tee colours are preloaded in metres, with all 18 pars and stroke indexes. Identical men's/women's tee rows are combined because the trip uses entered playing handicaps rather than rating/slope conversions. Yellow totals are 5,858 m (Faldo) and 5,939 m (O'Connor); nearest-the-pin holes are 16 and 17 respectively. Existing installations receive the default tees only where their tee library is empty; custom tee definitions and saved round scores are preserved.

Amendoeira source documents:
- https://amendoeiraclubedegolfe.com/wp-content/uploads/2020/01/Scorecard_093-1_Faldo-Course_20191025.pdf
- https://amendoeiraclubedegolfe.com/wp-content/uploads/2020/01/Scorecard_093-2_OConnor-Jnr-Course_20191025.pdf
- https://lltyahomlgnigxdtidys.supabase.co/storage/v1/object/public/course-maps/amendoeira-faldo.png
- https://lltyahomlgnigxdtidys.supabase.co/storage/v1/object/public/course-maps/amendoeira-oconnor.png
