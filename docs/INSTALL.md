# Installing Whatnot Studio

Whatnot Studio is a Windows app for sellers. It sits next to Whatnot in Chrome and runs OBS for you, so you do not have to set up scenes yourself.

This is not a Go Live button. You still go live in Whatnot's own Show Tools page. This app only owns the picture and the sound.

## What you need first

1. A 64-bit Windows PC.
2. **OBS Studio 31** (31.1.2 is known to work). Do **not** use OBS 32 — Whatnot warns that 32.x shows can fail to start.
3. Install OBS from https://obsproject.com into the usual place:
   `C:\Program Files\obs-studio`
   You do not need to open OBS, make scenes, or turn anything on. Whatnot Studio starts OBS and talks to it on this computer at `127.0.0.1` port `4455`.
4. Google Chrome, signed in to your Whatnot seller account. Whatnot's Show Tools page is not reliable in other browsers.

## Install Whatnot Studio

1. Double-click the Whatnot Studio installer (the `.exe`).
2. If Windows SmartScreen says it is unrecognized, that is because this build is not code-signed yet. Click **More info**, then **Run anyway**.
3. Install for this user. You will not be asked for an admin password. You can change the folder if you want.
4. Finish. A Start Menu entry named **Whatnot Studio** appears.

## First time you open it

Open **Whatnot Studio** from the Start Menu. You should see the Setup screen: a show name, camera, microphone, optional capture card, **Open Whatnot Show Tools**, and **Copy OBS password**.

Fill those in, paste the password into Whatnot's Show Tools page, then continue. The app does not start a show by itself.

## Uninstall

Windows Settings → Apps → Installed apps → Whatnot Studio → Uninstall.

Close Whatnot Studio first if it is still open.
