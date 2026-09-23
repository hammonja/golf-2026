# Portugal 2026

A responsive golf holiday scorekeeper for James Hammond, Ben Nowak, Mark Shaw and Owen Shaw. No build step or runtime dependencies.

Run `python app.py`, then open http://localhost:4050. Python 3 is the only runtime requirement; no pip installation or Node.js server is needed. Stop with Ctrl+C. Optional `HOST` and `PORT` environment variables change the listening address and port (defaults: `0.0.0.0`, `4050`).

`app.py` serves the website using Python's standard library. HTML and CSS provide the responsive layouts; browser JavaScript handles interactive scoring, handicap calculations and localStorage. Keep the site files, `course_store.py`, `course_defaults.json` and `assets/` alongside `app.py`.

Run server checks with `python -m unittest test_app.py`. The optional browser scoring checks use Node.js: `node tests.js`.

For DOM interaction regression checks, run `npm ci` then `node test-controls.js` (development only; Python runtime has no npm requirement). Python adds content hashes to JavaScript and CSS URLs in the served HTML, so browsers and Cloudflare fetch new versions after a deployment rather than keeping old controls cached. Restart `app.py` after changing Python code.

Includes overall standings, four competition trackers, editable 18-hole scorecards, playing handicaps, closest-to-the-pin bonuses and JSON backup/import. Playing handicaps apply directly across all courses. Scramble uses shared gross team scores and is excluded from individual totals and placing points.

Desktop and mobile leaderboards include earnings before the £50 entry fee. Round prizes are £20 per winning player (including each member of a winning pair); overall prizes are £40 for first and £20 for second. Live leaders show provisional winnings. Round winnings become confirmed after 18 commonly scored holes and verified course details. Overall winnings remain provisional until all four rounds are complete, course details are verified, and all four closest-to-the-pin bonuses are awarded. Tied prizes remain unallocated until the tie is resolved in the results; no automatic prize split is assumed. Earnings recalculate from the scores and handicaps, so corrections also update previously confirmed amounts.

Before playing, choose a playing tee on each scorecard and set the four playing handicaps. Until a tee is selected or course data is verified, the initial hole data is provisional (par 4 and stroke indexes 1–18).

Course setup lets you upload a course map and original scorecard (PNG, JPEG, WebP or PDF, up to 10 MB each). Enter and verify each tee's 18 pars, stroke indexes and distances once, in metres or yards. Uploaded images/PDFs are reference documents, not automatically OCR-transcribed. Then choose the playing tee from the dropdown; distances appear on desktop and mobile scorecards. Scores and playing handicaps are preserved. If the last par 3 changes, its existing bonus is cleared for reassignment. The selected tee is a snapshot saved with the round; use “Reapply latest saved tee details” to pick up later library edits.

Ombria's official map and scorecard are bundled from https://www.ombria.com/en/golf/golf-course/ (retrieved 2026-09-23), with tees 58 / 53 / 49 / 45, totalling 5,802 / 5,350 / 4,965 / 4,518 metres. Last par 3: hole 17. The map and cropped scorecard remain Ombria's original artwork.

Salgados includes the official 2026 scorecard PDF linked at https://salgadosgolf.com/the-course and the course layout from https://algarvegolf.net/images/courselayouts/salgados.gif. The PDF gives six tee colours in metres and yards, but no stroke indexes, so Salgados tees still require verified setup rather than guessed indexes. Its last par 3 is hole 17. The map is labelled as an older reference whose renovation status is unconfirmed. Original documents are preserved unchanged. On startup, missing bundled document references are added to existing course databases without replacing uploaded files or saved tee definitions.

Python stores the shared course library and uploaded documents in `data/courses.sqlite3`, created on first launch. The server needs write access to that directory. Set `COURSE_DB` to a persistent path if your host replaces the application directory during deployment, and back up this SQLite file separately from exported round scores. Course files and tee definitions are shared by all devices; round scores and tee selections still live in each browser. Course writes use version checking to reject conflicting edits. Course-editing endpoints have no login; put the site behind your host's access controls if edits should be restricted to the group.

Tied individual placings share the points for their occupied places. Live placing points compare holes scored by all four players. Team competition totals also compare commonly completed holes. Final prize ties are displayed as tied for the group to resolve.

Data is saved in localStorage in the current browser. Export/import transfers a backup between devices; there is no server database or automatic multi-device synchronization. `app.py` is a development server; use production hosting with HTTPS for a public deployment.

At screen widths of 760px and below, the site automatically uses mobile navigation, compact leaderboard cards and hole-by-hole score entry. Desktop keeps the original tables. Mobile scores use the same storage and calculations, with numeric entry, plus/minus controls, a hole picker, and a full-scorecard toggle. Blank scores remain unplayed; the first plus/minus tap starts at par. Opening a round starts at its first incomplete hole, unless a hole was already selected during this visit.

On a phone on the same Wi-Fi, open `http://<computer-LAN-IP>:4050` while `app.py` is running (subject to your computer's firewall). Away from that network, use the deployed site URL. `localhost` refers to the phone itself, not your development computer. This version has no offline reload support or automatic cross-device sync; keep one phone as the scorekeeper and export backups. Browser storage is tied to the URL, so export a backup before changing addresses.


Faldo and O'Connor Jnr. include the supplied aerial maps and the club-published scorecards dated 25 October 2019. Five Faldo tee colours and seven O'Connor tee colours are preloaded in metres, with all 18 pars and stroke indexes. Identical men's/women's tee rows are combined because the trip uses entered playing handicaps rather than rating/slope conversions. Yellow totals are 5,858 m (Faldo) and 5,939 m (O'Connor); nearest-the-pin holes are 16 and 17 respectively. Existing installations receive the default tees only where their tee library is empty; custom tee definitions and saved round scores are preserved.

Amendoeira source documents:
- https://amendoeiraclubedegolfe.com/wp-content/uploads/2020/01/Scorecard_093-1_Faldo-Course_20191025.pdf
- https://amendoeiraclubedegolfe.com/wp-content/uploads/2020/01/Scorecard_093-2_OConnor-Jnr-Course_20191025.pdf
- https://lltyahomlgnigxdtidys.supabase.co/storage/v1/object/public/course-maps/amendoeira-faldo.png
- https://lltyahomlgnigxdtidys.supabase.co/storage/v1/object/public/course-maps/amendoeira-oconnor.png
