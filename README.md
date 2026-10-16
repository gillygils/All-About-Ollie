# All About Ollie

A private, living scrapbook for Ollie. Family and friends can browse a sideways-scrolling timeline, mark events like "First tooth" or "1st birthday", and add photos to any day.

## Two locks

1. **Family PIN.** The whole site is locked behind a PIN that the admin sets. Each device has to enter it once every 30 days. After 5 wrong tries, that address is locked out for 15 minutes.
2. **Personal account.** After the PIN, everyone logs in with their own username and password, or creates an account. Photos and pages are only served to people who are past both locks.

When the admin changes the PIN, every device has to enter the new one.

## Pages

- **Timeline** (home): a sideways timeline of every day that has photos or events. It shows Ollie's age at each point, jumps to any date, and opens a day's photos when you click its stack.
- **Events**: a card for each event with its title and a cover photo. Opening one shows only that event's photos.
- **Settings**: theme (Cream, Blush, Ocean, Sage, Midnight), name and email, and password. The admin also gets the baby's name and birth date, the family PIN, and the member list (reset a password, make someone admin, remove someone).

People can edit or delete what they added. The admin can edit or delete anything.

## Run it

Requires [Node.js](https://nodejs.org) 22.13 or newer.

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
| `data/photos/` | Resized copies people see. Location data (GPS) is removed. |
| `data/thumbs/` | Small previews |
| `data/originals/` | Untouched originals as uploaded. They are never shown on the site. |

## Hosting it online

To let family reach it from anywhere, run it on a host that gives you **HTTPS** and a **persistent disk**, for example Railway, Render, Fly.io, or a small VPS. Settings:

- `PORT`: the port to listen on (default `3000`)
- `DATA_DIR`: where to store `data/`. Point it at the persistent disk.
- `TRUST_PROXY=1`: set this behind the host's proxy so HTTPS cookies and per-IP lockouts work correctly
- `SETUP_CODE`: optional. Fixes the first-run setup code instead of using a random one.

Always use HTTPS in production, so the PIN and passwords aren't sent in plain text.
