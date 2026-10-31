# LyricCast

Send song lyrics, one line at a time, to vMix as a lower third. The controller (phone or computer) and the vMix PC only need internet access. They do not need to share a network.

Starts completely empty: no songs, lyrics, users or sessions are seeded anywhere.

## Run it

Locally (needs Node 18 or newer):

    npm install
    npm start

Open http://localhost:3000. For use across different networks, host it on a public server (below).

## Deploy from your phone (Render)

1. Sign in at render.com with GitHub.
2. New, Web Service, pick this repository.
3. Build command: `npm install`. Start command: `npm start`.
4. Deploy. Render gives you an https link. That link is your LyricCast address.
5. To keep songs across redeploys, add a Disk (for example mounted at `/var/data`) and set the environment variable `DATA_DIR=/var/data`. Without a disk, a free instance loses saved songs when it restarts.

Docker works too: `docker build -t lyriccast . && docker run -p 3000:3000 -v lyric-data:/data lyriccast`.

## Use it

1. Open your LyricCast link on your phone and tap Create session.
2. Songs tab: Add song, paste lyrics. Every line becomes one projected line. A blank line starts a new section. A line like `[Chorus]` labels a section and is not projected.
3. Connect tab: copy the output link, or read out the 6 character code.
4. On the vMix PC: Add Input, Browser, paste `https://your-address/o/CODE`, width 1920, height 1080. The page is transparent, so place the input on a layer above your video.
5. Live tab: tap any line to send it, or use Next line and Previous. Clear takes the lower third off screen. Freeze holds the output while you move around.

Output link options: `?bg=green` or `?bg=00ff00` gives a solid chroma key background. `?debug=1` shows a small status dot.

Text feeds for vMix Data Sources or Title inputs: `/api/s/CODE/current.txt` and `/api/s/CODE/current.json`.

Fonts are system fonts of the vMix PC (Georgia, Arial, Impact and similar), so nothing is loaded from the internet.

## Troubleshooting

- Black background in vMix: make sure the input is a Browser input and the layer sits above other video. Use `?bg=green` and a chroma key if needed.
- Nothing appears: Connect tab should show "1 output live". If it says "No output yet", re-check the code typed in vMix.
- Corporate firewall: the output page tries WebSocket, then Server-Sent Events, then polling, so it keeps working on restrictive networks.
- Changed the output code: the old link stops working. Update the link in vMix.
