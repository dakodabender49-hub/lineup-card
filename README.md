# The Lineup Card

Free daily fantasy baseball start/sit calls for points leagues. Built automatically from live MLB data — no server, no database, just a static page rebuilt several times a day.

**Live site:** served from GitHub Pages out of `public/`.

## How it works

A GitHub Actions workflow runs `node build.js`, which:

1. Pulls today's schedule, probable pitchers, lineups, and player stats from the MLB Stats API
2. Pulls Vegas game totals from The Odds API (optional — only if a key is set)
3. Scores every hitter and probable pitcher with a weighted matchup formula
4. Grades yesterday's calls against actual box scores and renders a track-record scoreboard
5. Writes a single static `public/index.html` and deploys it

## Build schedule

| UTC | ET (summer) | Why |
|-----|-------------|-----|
| 13:00 | 9:00 AM | First pass — probables and overnight stat updates |
| 16:00 | 12:00 PM | Early lineups for day games |
| 20:00 | 4:00 PM | Most lineups are posted by now |
| 22:00 | 6:00 PM | Night game lineups |

Times shift one hour later in ET when daylight saving ends. You can also run it manually: **Actions → Build Lineup Card → Run workflow**.

## Track record (the scoreboard)

- Every live build saves its pre-game calls to `data/calls-YYYY-MM-DD.json` and the workflow commits that file back to the repo. Commits from `github-actions[bot]` touching `data/` are normal — don't delete them.
- Calls are **frozen at first pitch**: once a game starts, later builds that day keep the call that was on record, so the next morning's grades can't be rewritten with hindsight.
- The next day's build reads yesterday's file, pulls actual box scores, and shows average fantasy points by verdict tier (Start / Lean Start / Matchup Play / Sit), plus the best call of the day. Players who didn't play are excluded.
- The scoreboard first appears the day **after** the first calls file is saved.

**Scoring used for grading:**
- Hitters: `TB + R + RBI + BB + HBP + 2×SB`
- Pitchers: `3×IP + K − 2×ER − BB − H`

## Failure guard

If the MLB API is down, or the schedule loads but zero players can be graded, the build **exits with an error on purpose**. A red ❌ run in Actions means the previous good page stays live instead of deploying an empty one. No action needed — the next scheduled run will recover.

## Optional setup

**Vegas totals (recommended):**
1. Free key at [the-odds-api.com](https://the-odds-api.com) (500 credits/month; this site uses ~4/day)
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**
3. Name: `ODDS_API_KEY`, value: your key

Without a key the site builds fine and just skips the Vegas factor.

**Analytics (GoatCounter, free):**
1. Sign up at [goatcounter.com](https://www.goatcounter.com), pick a site code
2. Edit the `GOATCOUNTER` constant near the top of `build.js` (e.g. `const GOATCOUNTER = "mysite";`)

## Files

| File | Purpose |
|------|---------|
| `build.js` | The entire build — fetch, score, grade, render |
| `.github/workflows/build.yml` | Schedule + deploy + commit calls data |
| `public/index.html` | Generated output (don't edit by hand) |
| `data/calls-*.json` | Daily saved calls for next-day grading |

## Debugging

If the page looks wrong or a build fails: **Actions → click the failed run → click the "Build site" step**, copy the error text, and paste it into Claude.
