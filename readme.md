# Portugal 2026

A responsive golf holiday scorekeeper for James Hammond, Ben Nowak, Mark Shaw and Owen Shaw. No build step or runtime dependencies.

Run `npm start`, then open http://localhost:3000. Run scoring checks with `npm test`.

Includes overall standings, four competition trackers, editable 18-hole scorecards, playing handicaps, closest-to-the-pin bonuses and JSON backup/import. Playing handicaps apply directly across all courses. Scramble uses shared gross team scores and is excluded from individual totals and placing points.

Before playing, enter each course's pars and stroke indexes under Scorecards → Course setup, and set the four playing handicaps. The initial hole data is explicitly provisional (par 4 and stroke indexes 1–18); it is not an official course card.

Tied individual placings share the points for their occupied places. Live placing points compare holes scored by all four players. Team competition totals also compare commonly completed holes. Final prize ties are displayed as tied for the group to resolve.

Data is saved in localStorage in the current browser. Export/import transfers a backup between devices; there is no server database or automatic multi-device synchronization. Serve the static files over HTTPS for a public deployment; `server.js` is a local development server.

At screen widths of 760px and below, the site automatically uses mobile navigation, compact leaderboard cards and hole-by-hole score entry. Desktop keeps the original tables. Mobile scores use the same storage and calculations, with numeric entry, plus/minus controls, a hole picker, and a full-scorecard toggle. Blank scores remain unplayed; the first plus/minus tap starts at par. Opening a round starts at its first incomplete hole, unless a hole was already selected during this visit.

On a phone, use the deployed site URL. `localhost` refers to the phone itself, not your development computer. This version has no offline reload support or automatic cross-device sync; keep one phone as the scorekeeper and export backups.
