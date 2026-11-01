# LyricCast

A worship-style operator console that sends lyrics, one line at a time, to vMix as a lower third.
Songs and schedules are saved on your own device and work offline. The phone and the vMix PC only need internet, not the same network.

Starts completely empty: no songs, schedules, users or sessions are seeded anywhere.

## How it works (like EasyWorship)

- **Schedule**: your service order. Add songs and text items (announcements, scripture you type, prayers), reorder them, add notes.
- **Preview**: tap an item to stage it here. Pick the starting line, then Go Live (or double tap a line).
- **Live**: what vMix is showing. Tap any line, or use Next, Previous, Clear and Freeze. At the end of an item, the next schedule item is staged in Preview.
- **Songs**: write or paste lyrics. Put `[Verse 1]`, `[Chorus]` and similar labels on their own line. Set the order of sections (for example Verse, Chorus, Verse, Chorus, Bridge, Chorus) without retyping.
- **Design**: font, size, colours, bar, position, animation and saved presets, with a live preview.

Gestures on the Live monitor: swipe left or right for next and previous line, swipe up or down for the next or previous schedule item.
Keys: Space or right arrow next, left arrow previous, Enter go live, up and down arrows change item, B or Esc clear, F freeze, / search songs.

## Offline and never losing songs

- Everything you write is saved on the device (IndexedDB) as you type, including an unsaved draft that is restored after a reload or crash.
- Open the app once while online so it installs itself. After that the library, editor and schedules work with no internet. Sending lines to vMix needs a connection.
- When online, a merged backup is kept on the server and shared between your devices. If a free host wipes its data, the app re-registers your output code and uploads everything again from your device, so the vMix link keeps working.
- Use Connect, Export backup now and then for a file copy.

## Deploy (Render)

1. Sign in at render.com with GitHub. New, Web Service, pick this repository.
2. Build command `npm install`, start command `npm start`. Deploy.
3. Optional: add a paid instance and a Disk, then set `DATA_DIR` to the disk path so the server copy survives restarts too.

Docker: `docker build -t lyriccast . && docker run -p 3000:3000 -v lyric-data:/data lyriccast`.
Vercel cannot run this app because it needs a long-running server.

## Use with vMix

1. Open your LyricCast address on your phone. Connect tab, Create session.
2. On the vMix PC: Add Input, Browser, paste `https://your-address/o/CODE`, width 1920, height 1080. The page is transparent, so place the input on a layer above your video.
3. Output link options: `?bg=green` or `?bg=00ff00` for a chroma key background, `?debug=1` for a status dot.
4. Text feeds for Data Sources or Title inputs: `/api/s/CODE/current.txt` and `/api/s/CODE/current.json`.

Fonts are the vMix PC's system fonts, so nothing loads from the internet.

## Troubleshooting

- Black background in vMix: use a Browser input above your video, or use `?bg=green` with a chroma key.
- Nothing appears: Connect should show an output connected. If not, re-check the code typed in vMix.
- Strict firewalls: the output tries WebSocket, then Server-Sent Events, then polling.
- A new output code makes the old link stop working. Update vMix.
