# Portugal 2026

A responsive golf holiday scorekeeper for James Hammond, Ben Nowak, Mark Shaw and Owen Shaw. No build step or runtime dependencies.

Run `python app.py`, then open http://localhost:4050. Python 3 is the only runtime requirement; no pip installation or Node.js server is needed. Stop with Ctrl+C. Optional `HOST` and `PORT` environment variables change the listening address and port (defaults: `0.0.0.0`, `4050`).

`app.py` serves the website using Python's standard library. HTML and CSS provide the responsive layouts; browser JavaScript handles interactive scoring and handicap calculations. Keep all root `.py` and `.js` files, `course_defaults.json` and `assets/` alongside `app.py`. Scores, course data and the event log share one SQLite database.

Run server checks with `python -m unittest test_app.py test_live.py`. The optional browser scoring checks use Node.js: `node tests.js`.

For DOM interaction regression checks, run `npm ci` then `node test-controls.js` (development only; Python runtime has no npm requirement). Python adds content hashes to JavaScript and CSS URLs in the served HTML, so browsers and Cloudflare fetch new versions after a deployment rather than keeping old controls cached. Restart `app.py` after changing Python code.


## Admin and existing scores

The small **Log in** button sits just after **The rulebook** on desktop and at the top right on mobile. The requested default login is username `admin`, password `hammonja`. Credentials are checked only by Python, never embedded in public JavaScript. Optional `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables override the defaults. Sessions use random HttpOnly, SameSite cookies, expire after 12 hours, and are invalidated by a server restart. Failed logins are throttled (10 attempts in five minutes per server peer address).

Viewers can navigate, view scores, open course documents and view the gallery. Anyone using the installed mobile app can capture and upload hole photos/videos. Only logged-in admins can edit handicaps, scores, selected tees, pin awards, tee definitions or uploaded course documents, or import a backup. These restrictions are enforced by the server as well as the UI. All devices may use the admin account; each login has its own audit session ID.

On the first deployment, shared scores start empty because the server cannot read other devices' localStorage. Sign in on the browser/URL holding your existing scores and choose **Import this browser’s old scores** in the footer. The confirmation shows the number of entered scores and handicaps; importing replaces shared scores for everyone. Alternatively choose **Import backup** with an existing score JSON. The original browser backup is left intact. An import records its current values as a single explicit event; earlier local edit times and order cannot be recovered.

Concurrent score edits use a version check. A conflicting save reloads shared scores and offers **Download unsaved draft** so the rejected changes are recoverable. Failed/unconfirmed saves preserve a draft too; drafts are never automatically uploaded over someone else's changes. Course edits have separate course version checks. Wait for **Live · saved on server** before leaving the page.

## Complete event history and replay

Admins can choose **Download history JSON** in the footer. This produces one self-contained scoring replay in `portugal-2026-history.json`, including the initial score/course checkpoint, original course reference files, subsequent course document uploads (base64), and every accepted data mutation in order. Successful/failed logins and logout actions are also recorded. Hole photo/video uploads add metadata events; their large original files are stored separately (see below). Navigation, viewing and rejected data requests are not scoring events. Passwords, cookies, upload recovery keys and CSRF tokens are excluded.

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

### AI round reports

Each competition panel on the leaderboard gains a **Read round report** link at the bottom when every score is entered: all four players over 18 holes for rounds 1–3, and both pairs over 18 holes for the scramble. The link opens an approximately 150-word AI report in a scrollable popup, with a Close button, Escape and outside-tap dismissal. The popup continues receiving live updates and closes if the round becomes incomplete. While generation runs, the panel shows a short writing status. A match clinched early still needs its complete scorecard before generating. A nearest-pin award is not required, and unverified course data is explicitly described as provisional.

The server automatically queues a report after completion, waits 10 seconds to group rapid edits, then generates it in a background thread. Relevant score, handicap, par, stroke-index, tee, verification or nearest-pin changes remove the previous report immediately and queue a replacement. Handicaps and stroke indexes do not invalidate the gross scramble. Editing other rounds, uploading reference documents, opening pages and logging in do not regenerate reports. Clearing a required score hides the report until the round is complete again. Results from an outdated in-flight request are discarded. Reports and queued work survive restarts, and completed reports are sent to every viewer through the existing live snapshots.

OpenAI credentials follow Revision: process environment first, this project's `.env` second, then missing `OPENAI_API_KEY`, `OPENAI_PROJECT` and `OPENAI_ORG_ID` values from `../tools/.env`. `OPENAI_ENV_FILE` can select another shared configuration path. Golf defaults to **GPT-6 Sol** (`gpt-6-sol`) and intentionally does not inherit Tools' model. `GOLF_AI_MODEL` in the environment or local `.env` overrides it; a local/environment `OPENAI_MODEL` is also supported when no golf-specific model is set. No key is sent to the browser or committed to Git. The Python standard library handles the HTTPS API call, so no additional package installation is needed. `.env.example` documents overrides. `GOLF_AI_ENABLED=0` disables new generation; existing reports remain readable. On the Pi, `/home/hammonja/golf-2026` automatically finds `/home/hammonja/tools/.env` if the service user can read it.

The AI receives a JSON projection of the same checkpoint and events exported by **Download history JSON**, containing only the selected round, relevant handicap changes, timestamps, imports and corrections. It includes calculated hole-by-hole standings, gross birdie/par labels, net/Stableford scores and the match-clinching hole. Authentication events, session identifiers, unrelated rounds, images and PDFs are excluded. The complete history export remains unchanged and self-contained; generation, failures, retries and the generated text are recorded as additional audit events. The report prompt distinguishes entry chronology from the final corrected hole order and does not permit invented shots or emotional details.

Calls use OpenAI's [Responses API](https://developers.openai.com/api/docs/guides/text) with [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), `store=false`, a 120-second timeout per call and a 512 KB input limit. Each generation uses a draft followed by a factual editing pass against the same source data. Output is validated as 140–160 words in 2–3 short paragraphs, checked for unsupported shot-detail terms and rendered as escaped text. Failed attempts retry after 60 seconds and then 5 minutes, up to three attempts per version; an admin can retry a failed report. A persistent budget reserves two API requests per attempt, including failures and manual retries, up to 24 requests per rolling 24 hours (`GOLF_AI_DAILY_LIMIT`, effective range 2–100). At the limit, queued work waits until space for an attempt becomes available. Reports remain labelled as AI-generated; editing and validation reduce errors but cannot guarantee every sentence is correct. This uses the same paid API account as Tools/Revision.

Run `python -m unittest test_app.py test_live.py test_reports.py` and `npm test` for report lifecycle, history projections, scoring parity, HTTP permissions and browser regressions. Tests use temporary data and fake AI responses; the worker starts only from the application's `main()`, not from test server setup.

### Install on iPhone or Android

The HTTPS site is an installable Progressive Web App, named **Portugal 26** on the home screen. Open **Install app** on the site for instructions, or the browser's native install prompt when available.

- **iPhone / iPad:** open the site in Safari, choose **Share → Add to Home Screen**, leave **Open as Web App** on if shown, then **Add**.
- **Android:** open the site in Chrome, choose **Install app** on the site or **⋮ → Add to Home screen / Install app**, then confirm installation.

Launch the new icon to open a standalone app window without the browser address bar. The phone's status bar may remain. No App Store or Google Play download is needed. The layout accounts for phone notches, landscape cutouts and the home indicator; installation guidance disappears in the installed window. Chrome may require a little time and interaction before offering its native install prompt, so manual instructions remain available.

Scores, login and history use the same server as the website. An internet connection is required; this change does not add offline scoring or cache score/authentication responses. iOS may use a separate login session for the home-screen app, so admins should sign in there. There is deliberately no service worker caching old application code; reopening the app loads the deployed version using the existing asset hashes and revalidation headers.

Deploy all files, including `manifest.webmanifest`, `pwa.js` and the four PNG icons in `assets`, and **restart the Python service** so its asset routes are updated. In PiDash, use **Stop**, wait for **INACTIVE**, then **Start** if the Restart button does not restart the process.

Installation follows [Apple's Home Screen web app support](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) and [Chrome's installability criteria](https://web.dev/articles/install-criteria). Physical iPhone and Android installation should be checked after deployment; desktop browser tests do not reproduce the OS installation UI.

### Hole photos, videos and gallery

In the installed mobile app, each hole has a camera button. It opens **Take photo** and **Record video**, which request the phone's rear camera. No login or player selection is required. Normal browser tabs and desktop windows show the public **Gallery** but no capture controls. The gallery groups captures by **course, then hole**. Opening a capture shows the original photo or a video player and a **Download original** link. Video playback depends on the device's codec support; originals remain downloadable.

Logged-in admins also see **Delete photo** / **Delete video** inside the capture viewer, on both mobile and desktop. Confirmation permanently removes the original and thumbnail from the server and removes the item from everyone's gallery and media manifest. The server requires an admin session, CSRF token and same-origin request. The `media.deleted` history event keeps the capture metadata, deletion time and admin session ID; scores and reports are unchanged. Retries are idempotent, and a deleted upload ID cannot be uploaded again. Media responses use `no-store`; deletion cannot revoke copies already downloaded or cached before this change. If cleanup is interrupted, the item stays hidden and cleanup resumes on server restart.

After capture, the original is committed to this phone's IndexedDB queue. The banner beneath the live-score status shows, for example, **2 pictures · 1 video to upload**, with **Upload now** and **View queue**. Uploading is always manual. Connect to Wi-Fi and tap **Upload now**, then keep the app open. The app blocks a connection reported as cellular, but iPhone does not expose the network type: the user must check Wi-Fi themselves. Reconnecting, reopening the app or taking a picture never starts an upload automatically. Going offline or moving the app to the background pauses the upload; tap again to resume.

The queue survives ordinary closing/reopening of the app. Keep the app and its website data until uploads finish: clearing storage, uninstalling or storage eviction can remove queued captures. **View queue → Save a copy** offers an additional original download. Captures are not guaranteed to be placed in the phone's Camera Roll. If local saving fails, the capture window stays open with **Save a copy** and **Try saving again**. This is not a fully offline app shell: load the app while connected first; an already-loaded page can queue captures without a connection.

Originals are preserved without resizing or transcoding. Supported formats are JPEG, PNG, WebP, HEIC/HEIF, MP4, MOV and WebM, with a 25 MiB photo limit and 200 MiB video limit. Short clips are recommended. Small JPEG photo thumbnails are generated when supported, and the gallery does not preload video originals. Uploads use resumable 2 MiB chunks, so interrupted uploads continue from the server's last committed offset. A private random recovery key protects each anonymous upload. Local originals are removed only after the server confirms a complete, durably saved file. Retries do not duplicate gallery items or audit events.

The server stores original files in `data/media/originals/` by default, alongside the existing database directory, with partial uploads in `data/media/incoming/`. Set process environment variable `GOLF_MEDIA_DIR` to use a different persistent directory. Media metadata and thumbnails live in the existing SQLite database. The default storage allocation is 20 GiB, with 256 MiB disk space reserved for the rest of the app; `GOLF_MEDIA_MAX_BYTES` changes that allocation. Keep both the database **and** media directory across deployments and backups. New directories/tables are created automatically; no production dependencies are added.

For an offline highlights project, download **Gallery → Download media metadata**, the original files, and the admin **Download history JSON**. The manifest lists each original's URL, relative disk path and SHA-256 digest, plus course, round, hole, original filename/type/size and timestamps. `round` is zero-based; `roundNumber` and `hole` are one-based. `capturedAt` is the phone's clock when its camera was opened, not a verified shot time. `historySequenceAtCapture` and `stateVersionAtCapture` are the latest server state seen by that phone, while `historySequenceAtUpload` identifies the `media.uploaded` audit event. Uploading media leaves all scores and AI reports unchanged. Photos and videos are not sent to OpenAI. Copying the originals directory from a server backup is an alternative to individual gallery downloads.

Run `python -m unittest test_media.py test_app.py test_live.py test_reports.py` and `npm test` for upload permissions, interrupted transfer recovery, file validation, audit links, HTTP video ranges, persistent queues and the mobile capture/gallery controls. Physical iPhone/Android camera and codec behaviour still needs testing on those devices.

### Server configuration

Keep the existing `COURSE_DB` path so existing course uploads are preserved. The new score and event tables are added automatically. Run a single Python server process against that database (multiple browser clients are supported). Restart the service after deploying the Python changes. Set `COOKIE_SECURE=1` when serving through HTTPS; leave it unset only for local HTTP development.

The reverse proxy must forward `/api/events` as a streaming response: disable buffering, caching and compression for that route, and use a read timeout greater than 30 seconds (heartbeats arrive every 15 seconds). Do not cache `/api/*`. With Nginx, use `proxy_buffering off`, `proxy_cache off` and `proxy_read_timeout 60s` for `/api/events`. The application also sends `X-Accel-Buffering: no` and `Cache-Control: no-store`. Restrict direct access to the Python port when exposing it through a public HTTPS proxy. Standard-library `http.server` is intended for this small deployment behind a trusted proxy, not as an internet-facing production server.

The database is the durable master history; the JSON is generated on demand from a consistent database snapshot. Keep database backups as well as periodic history exports. Stopping after a successful save or restarting the service does not lose scores/history. A proxy that presents every user as one peer address shares a login-throttle bucket unless it provides distinct trusted peer addresses.

Includes overall standings, four competition trackers, editable 18-hole scorecards, playing handicaps, closest-to-the-pin bonuses and JSON backup/import. Playing handicaps apply directly across all courses. Scramble uses shared gross team scores and is excluded from individual totals and placing points.

Desktop and mobile leaderboards include earnings before the £50 entry fee. Round prizes are £20 per winning player (including each member of a winning pair); overall prizes are £40 for first and £20 for second. Live leaders show provisional winnings. Round winnings become confirmed after 18 commonly scored holes and verified course details. Overall winnings remain provisional until all four rounds are complete, course details are verified, and all four closest-to-the-pin bonuses are awarded. Tied prizes remain unallocated until the tie is resolved in the results; no automatic prize split is assumed. Earnings recalculate from the scores and handicaps, so corrections also update previously confirmed amounts.

Before playing, choose a playing tee on each scorecard and set the four playing handicaps. Until a tee is selected or course data is verified, the initial hole data is provisional (par 4 and stroke indexes 1–18).

Course setup lets you upload a course map and original scorecard (PNG, JPEG, WebP or PDF, up to 10 MB each). Enter and verify each tee's 18 pars, stroke indexes and distances once, in metres or yards. Changing the unit in course setup converts existing distances immediately (1 yard = 0.9144 metres), rounded to whole units. The conversion remains a draft until you choose **Save and play this tee**; saving updates the shared course and selected round on every device. For a new tee, choose the unit before entering distances. Blank distances stay blank. Supported distances are 1–1,000 metres or 1–1,094 yards. Uploaded images/PDFs are reference documents, not automatically OCR-transcribed. Then choose the playing tee from the dropdown; distances appear on desktop and mobile scorecards. Scores and playing handicaps are preserved. If the last par 3 changes, its existing bonus is cleared for reassignment. The selected tee is a snapshot saved with the round; use “Reapply latest saved tee details” to pick up later library edits.

Ombria's official map and scorecard are bundled from https://www.ombria.com/en/golf/golf-course/ (retrieved 2026-09-23), with tees 58 / 53 / 49 / 45, totalling 5,802 / 5,350 / 4,965 / 4,518 metres. Last par 3: hole 17. The map and cropped scorecard remain Ombria's original artwork.

Salgados includes the official 2026 scorecard PDF linked at https://salgadosgolf.com/the-course and the course layout from https://algarvegolf.net/images/courselayouts/salgados.gif. All six tee colours are selectable in metres, using pars and distances from the official PDF. Stroke indexes come from https://stimp.tech/golf/salgados-golf-club-7b773b and need club confirmation after renovation; they do not affect the gross scramble. Its last par 3 is hole 17. The map is labelled as an older reference whose renovation status is unconfirmed. Original documents are preserved unchanged. On startup, missing bundled document references are added to existing course databases without replacing uploaded files or saved tee definitions.

Python stores the shared course library and uploaded documents in `data/courses.sqlite3`, created on first launch. The server needs write access to that directory. Set `COURSE_DB` to a persistent path if your host replaces the application directory during deployment, and retain this file across deployments. Scores, handicaps, tee selections, pin awards, course files and tee definitions are shared by all devices. Scoring and course write endpoints require an admin session and CSRF token; anonymous media upload endpoints use per-upload recovery keys. Version checks reject conflicting edits. Back up this database with SQLite's backup API, or stop the server before copying it. Back up the separate media directory too. Once event history starts, startup no longer silently updates course definitions; changes must go through the audited APIs.

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
