# All About Ollie

A private, living scrapbook for Ollie. Photos and videos are pinned as polaroids on a cork board timeline that you zoom through like Apple Photos. Family and friends can mark events like "First tooth" or "1st birthday" and add memories to any day.

## Two locks

1. **Family PIN.** The whole site is locked behind a PIN that the admin sets. Each device has to enter it once every 30 days. After 5 wrong tries, that address is locked out for 15 minutes.
2. **Personal account.** After the PIN, everyone logs in with their own username and password, or creates an account. Photos and pages are only served to people who are past both locks.

When the admin changes the PIN, every device has to enter the new one.

## Pages

- **Timeline** (home): a cork board with polaroid stacks strung along a piece of twine. Zoom between **Years, Months, Weeks and Days**:
  - On a phone, pinch.
  - On a computer, pinch the trackpad, use ctrl + scroll, or click − / + or a level name.
  - The stack you zoom on stays put while the levels cross-fade, and it settles on the nearest level when you let go.
  - Tap a month or week to dive into it. Tap a day to see all its photos, grouped by event.
  - Swipe, scroll or drag to move along the timeline. Each stack shows Ollie's age, and you can jump to any date.
  - If a stack holds a video, the video goes on top.
  - On the Days view, photos that aren't part of an event are pinned loose, scattered above and below the twine around their day and overlapping their neighbours like a real board. Tap one to open it. Event photos stay on a tidy stack in the middle.
- **Events**: a pinned polaroid for each event with its title and a cover photo. Opening one shows only that event's photos and videos.
- **Settings**: theme, name and email, and password. Each theme (Cream, Blush, Ocean, Sage, Midnight) tints the cork and frame, and Midnight uses dark polaroids. The admin also gets the baby's name and birth date, the family PIN, and the member list (reset a password, make someone admin, remove someone).

People can edit or delete what they added. The admin can edit or delete anything they can see, including in bulk from **Settings → Manage photos**: a scrolling grid of every photo and video where you tap (or shift-click) to select and delete many at once without opening them.

## Comments and hearts

Like Instagram, every photo and video has a **♡ 💬** row right under it, both on the polaroids and in the viewer. Tap ♡ to like a photo (or double-tap the photo in the viewer). Tap 💬 to open its comments: on a computer they appear beside the photo, and on a phone they come up from the bottom. Under the photo you also see "Liked by Grandma Sue and 2 others", the caption, and "View all 5 comments".

- You can delete your own comments, and the admin can delete any comment.
- Comments and hearts on a private photo are only visible to the people who can see that photo.

## Live updates

Anyone with the site open sees changes without reloading: new photos and videos, comments, hearts, events, and videos finishing conversion. New uploads also show a notice like "📸 Mom added 3 new memories".

- **No interruptions:** the page waits to update while someone is swiping, zooming, or has a photo or dialog open. Comments and hearts on the photo they're viewing update straight away, and anything half-typed is kept.
- **How it works:** each open page holds one connection to `/api/live`. It only receives short "something changed" notices, then re-fetches through the normal permission-checked pages.
- **Privacy:** notices about a private photo only go to the people who can see it.

## Private photos

When adding photos, choose **Only people I choose** and tick who may see them. To change it later, open the photo and tap the 🔒 / 👨‍👩‍👧 button.

- Private photos are visible only to the person who added them and the people they picked. **Admins don't get automatic access.**
- For everyone else, private photos don't appear anywhere: not on the timeline, in events, in photo counts, or as an event's cover. The image links themselves return "not found".

## Videos

Videos upload like photos, up to 2 GB each. The server then:

- grabs a frame to use as the thumbnail;
- converts the video in the background to H.264 MP4 (at most 1080p), so phone videos, including iPhone HEVC `.mov`, play in every browser;
- strips location data from the converted copy.

Until conversion finishes, the video shows as "Converting…". It's usually a minute or two.

This needs **ffmpeg** on the server. On Debian or Ubuntu, including a Proxmox LXC:

```bash
apt install ffmpeg
```

If ffmpeg isn't installed, the site still works, but video uploads are refused with a message. If ffmpeg isn't on the `PATH`, set `FFMPEG_PATH` and `FFPROBE_PATH`.

## Run it

Requires [Node.js](https://nodejs.org) 22.13 or newer, and ffmpeg for videos.

```bash
npm install
npm start
```

Open http://localhost:3000. On the very first run, the terminal prints a **setup code**. Enter it on the setup screen to create the admin account, set Ollie's name and birth date, and choose the family PIN. The code stops a stranger from claiming the admin account if they reach the site before you do.

## Where things are stored

Everything lives in `data/`, which is git-ignored. **Back this folder up.**

| Path | What |
|---|---|
| `data/scrapbook.db` | Accounts, events, and photo info (SQLite) |
| `data/photos/` | Resized copies people see (and video poster frames). Location data (GPS) is removed. |
| `data/thumbs/` | Small previews |
| `data/videos/` | Converted MP4s people watch |
| `data/originals/` | Untouched originals as uploaded. They are never shown on the site. |

## Hosting it online

To let family reach it from anywhere, run it on a host that gives you **HTTPS** and a **persistent disk**, for example Railway, Render, Fly.io, or a small VPS. Settings:

- `PORT`: the port to listen on (default `3000`)
- `DATA_DIR`: where to store `data/`. Point it at the persistent disk.
- `TRUST_PROXY=1`: set this behind the host's proxy so HTTPS cookies and per-IP lockouts work correctly
- `SETUP_CODE`: optional. Fixes the first-run setup code instead of using a random one.

Always use HTTPS in production, so the PIN and passwords aren't sent in plain text.
