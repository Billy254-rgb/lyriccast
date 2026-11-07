# LyricCast

A worship-style operator console that sends lyrics, one line at a time, to vMix as a lower third.
Songs and schedules are saved on your own device and work offline. Sign in on any device to open the same songs.

Starts completely empty: no songs, schedules, accounts or sessions are seeded anywhere.

## Three ways to use it

1. **In a browser**: open your server address. Works on any phone or computer.
2. **As an installed app**: a Windows app and an Android app that carry their own copy of the screen. Songs and schedules open and work with no internet. The internet is only needed while you project to vMix, to reach your server.
3. **iPhone**: open your server address in Safari, tap Share, then Add to Home Screen. iPhone apps cannot be built here without an Apple developer account.

The server (this project, hosted on Render or similar) is what carries lines to the vMix PC, so it stays online. Free PHP hosts such as InfinityFree cannot be used with the installed apps, because their security check blocks requests from apps.

## Build the Windows and Android apps (no PC needed)

1. Put every file from this project in the main folder of your GitHub repository. Add the build file with the path `.github/workflows/build-apps.yml`: in GitHub choose Add file, Create new file, type that full path as the name (the slashes create the folders), paste the contents of `build-apps.yml`, and commit.
2. Open the repository's **Actions** tab, choose **Build apps**, tap **Run workflow**, and wait for it to finish (about 10 minutes).
3. Open the finished run. Under **Artifacts**, download **LyricCast-Windows** (an installer and a portable version) and **LyricCast-Android** (`LyricCast.apk`). On a phone, GitHub may ask you to open the page in desktop mode to see the downloads.

Installing:
- **Windows**: run the installer. Windows may say the app is from an unknown publisher because it is not code signed. Choose More info, then Run anyway.
- **Android**: open `LyricCast.apk` and allow installing from your browser or file app when asked. It is signed with a debug key, so it cannot go on the Play Store as is.

First launch of an installed app asks for your server address, for example `https://lyriccast.onrender.com`. It is saved, and you can change it later under Connect.

## The screen

Computer: three columns. Left, a search box over the schedule for the chosen day. Middle, the lyrics of the song you clicked, where any line goes live when clicked. Right, the vMix monitor with Previous, Next, Hide, Show and Freeze.

Phone: four tabs (Schedule, Lyrics, Live, Songs) and a mini live bar on every screen with Previous, Next and Hide.

Keys: Space or right arrow next, left arrow previous, H hide, S show, F freeze, up and down arrows change schedule item, / search.

## Songs that never disappear

- Everything you write is saved on the device as you type, including an unsaved draft after a crash, and works with no internet.
- Connect, Create account gives you a username and password. Sign in on any other device (browser or app) and your songs, schedules and look appear. Changes merge both ways.
- There is no password reset. Use Export backup now and then.
- On a free host with no permanent storage, add a free Postgres database so the server copy survives restarts: set its connection string as the environment variable `DATABASE_URL`. If the server ever loses its data, tap Connect, Re-save my account on a device that still has your songs.

## Deploy the server (Render)

1. Sign in at render.com with GitHub. New, Web Service, pick this repository.
2. Build command `npm install`, start command `npm start`. Deploy.
3. Recommended: add `DATABASE_URL`.

Docker: `docker build -t lyriccast . && docker run -p 3000:3000 -e DATABASE_URL=... lyriccast`.

## Use with vMix

1. Connect shows your output link, for example `https://your-server/o/ABC123`.
2. On the vMix PC: Add Input, Browser, paste the link, width 1920, height 1080. The page is transparent, so place the input on a layer above your video.
3. Options: `?bg=green` or `?bg=00ff00` for a chroma key background, `?debug=1` for a status dot.
4. Text feeds for Data Sources or Title inputs: `/api/s/CODE/current.txt` and `/api/s/CODE/current.json`.

Fonts are the vMix PC's system fonts, so nothing loads from the internet.

## Troubleshooting

- Installed app cannot connect: the server address must start with https:// and be reachable. A free Render server needs up to a minute to wake after sleeping.
- A build job fails: open the failed job in the Actions tab and read the last red lines.
- Black background in vMix: use a Browser input above your video, or use `?bg=green` with a chroma key.
- A new output code makes the old link stop working. Update vMix.
