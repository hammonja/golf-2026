# Portugal 2026

A responsive golf holiday scorekeeper for James Hammond, Ben Nowak, Mark Shaw and Owen Shaw. No build step or runtime dependencies.

Run `python app.py`, then open http://localhost:4050. Python 3 is the only runtime requirement; no pip installation or Node.js server is needed. Stop with Ctrl+C. Optional `HOST` and `PORT` environment variables change the listening address and port (defaults: `0.0.0.0`, `4050`).

`app.py` serves the website using Python's standard library. HTML and CSS provide the responsive layouts; browser JavaScript handles interactive scoring, handicap calculations and localStorage. Keep the site files alongside `app.py`.

Run server checks with `python -m unittest test_app.py`. The optional browser scoring checks use Node.js: `node tests.js`.

Includes overall standings, four competition trackers, editable 18-hole scorecards, playing handicaps, closest-to-the-pin bonuses and JSON backup/import. Playing handicaps apply directly across all courses. Scramble uses shared gross team scores and is excluded from individual totals and placing points.

Desktop and mobile leaderboards include earnings before the £50 entry fee. Round prizes are £20 per winning player (including each member of a winning pair); overall prizes are £40 for first and £20 for second. Live leaders show provisional winnings. Round winnings become confirmed after 18 commonly scored holes and verified course details. Overall winnings remain provisional until all four rounds are complete, course details are verified, and all four closest-to-the-pin bonuses are awarded. Tied prizes remain unallocated until the tie is resolved in the results; no automatic prize split is assumed. Earnings recalculate from the scores and handicaps, so corrections also update previously confirmed amounts.

Before playing, enter each course's pars and stroke indexes under Scorecards → Course setup, and set the four playing handicaps. The initial hole data is explicitly provisional (par 4 and stroke indexes 1–18); it is not an official course card.

Tied individual placings share the points for their occupied places. Live placing points compare holes scored by all four players. Team competition totals also compare commonly completed holes. Final prize ties are displayed as tied for the group to resolve.

Data is saved in localStorage in the current browser. Export/import transfers a backup between devices; there is no server database or automatic multi-device synchronization. `app.py` is a development server; use production hosting with HTTPS for a public deployment.

At screen widths of 760px and below, the site automatically uses mobile navigation, compact leaderboard cards and hole-by-hole score entry. Desktop keeps the original tables. Mobile scores use the same storage and calculations, with numeric entry, plus/minus controls, a hole picker, and a full-scorecard toggle. Blank scores remain unplayed; the first plus/minus tap starts at par. Opening a round starts at its first incomplete hole, unless a hole was already selected during this visit.

On a phone on the same Wi-Fi, open `http://<computer-LAN-IP>:4050` while `app.py` is running (subject to your computer's firewall). Away from that network, use the deployed site URL. `localhost` refers to the phone itself, not your development computer. This version has no offline reload support or automatic cross-device sync; keep one phone as the scorekeeper and export backups. Browser storage is tied to the URL, so export a backup before changing addresses.
