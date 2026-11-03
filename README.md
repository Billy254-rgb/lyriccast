# LyricCast

A worship-style operator console that sends lyrics, one line at a time, to vMix as a lower third.
Songs and schedules are saved on your own device and work offline. Sign in on any device to open the same songs.
The phone and the vMix PC only need internet, not the same network.

Starts completely empty: no songs, schedules, accounts or sessions are seeded anywhere.

## The screen

Computer: three columns.
- **Left, Schedule**: a search box on top that searches your whole library (including songs not on the schedule), then the schedule for the chosen day. Add songs, add text items, reorder, add notes.
- **Middle, Lyrics**: the lyrics of the song you clicked. Click any line to put it live.
- **Right, Live**: the vMix monitor, the current and next line, and Previous, Next, Hide, Show and Freeze. Section buttons jump to a verse or chorus.

Phone: four tabs (Schedule, Lyrics, Live, Songs) and a mini live bar on every screen with Previous, Next and Hide, so you never have to leave the lyrics to control the screen. The Live tab keeps the big controls in thumb reach. Settings (Look, Connect) are under the gear icon.

Keys: Space or right arrow next, left arrow previous, H hide, S show, F freeze, up and down arrows change schedule item, / search.

## Songs that never disappear

- Everything you write is saved on the device as you type (including an unsaved draft after a crash), and works with no internet.
- **Connect, Create account** gives you a username and password. Sign in on any other phone or computer and your songs, schedules and look appear there. Changes merge both ways, nothing is overwritten.
- There is no password reset, so keep your password safe and use Export backup now and then.
- On a free host with no permanent storage, add a free Postgres database so the server copy also survives restarts: create a database (for example at neon.tech), copy its connection string, and add it as the environment variable `DATABASE_URL` on Render. Check the provider's current free terms. Without it, the app still re-uploads everything from your device after a host restart.

## Deploy (Render)

1. Sign in at render.com with GitHub. New, Web Service, pick this repository.
2. Build command `npm install`, start command `npm start`. Deploy.
3. Recommended: add `DATABASE_URL` (see above).

Docker: `docker build -t lyriccast . && docker run -p 3000:3000 -e DATABASE_URL=... lyriccast`.
Vercel cannot run this app because it needs a long-running server.

## Use with vMix

1. Open your LyricCast address on your phone. Connect, create an account.
2. On the vMix PC: Add Input, Browser, paste `https://your-address/o/CODE`, width 1920, height 1080. The page is transparent, so place the input on a layer above your video.
3. Output link options: `?bg=green` or `?bg=00ff00` for a chroma key background, `?debug=1` for a status dot.
4. Text feeds for Data Sources or Title inputs: `/api/s/CODE/current.txt` and `/api/s/CODE/current.json`.

Fonts are the vMix PC's system fonts, so nothing loads from the internet.

## Troubleshooting

- Black background in vMix: use a Browser input above your video, or use `?bg=green` with a chroma key.
- Nothing appears: Connect should show an output connected. If not, re-check the code typed in vMix.
- Strict firewalls: the output tries WebSocket, then Server-Sent Events, then polling.
- A new output code makes the old link stop working. Update vMix.
- Open the app once online so it installs itself for offline use.
