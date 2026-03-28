# TrayScheduler

A Windows system tray app that schedules and runs light show API calls on a randomized rotating queue.

---

## Getting the .exe — Two Ways

### Option A: Build via GitHub (Recommended — no local setup needed)

1. **Create a free GitHub account** at https://github.com if you don't have one

2. **Create a new repository** — click the `+` button → "New repository"
   - Name it `tray-scheduler`
   - Set it to Private if you want
   - Click "Create repository"

3. **Upload the project files** — drag and drop all the project files into the repository, or use Git:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/tray-scheduler.git
   git push -u origin main
   ```

4. **The build starts automatically** — GitHub Actions detects the push and begins building. You'll see a yellow dot → green checkmark in the repository.

5. **Download your .exe**:
   - Go to your repository on GitHub
   - Click the **Actions** tab
   - Click the latest "Build Windows EXE" workflow run
   - Scroll down to **Artifacts**
   - Download **TrayScheduler-Windows**
   - Unzip it — you'll find two files:
     - `TrayScheduler Setup 1.0.0.exe` — installer (recommended)
     - `TrayScheduler-Portable.exe` — no install needed, just run it

---

### Option B: Build locally on Windows

Requires: Node.js 18+ (https://nodejs.org)

```bash
npm install
npm run build
# Output in dist/ folder
```

---

## First Run

1. Run the installer or portable `.exe`
2. The app appears in your **system tray** (bottom-right, near the clock)
3. Right-click the tray icon → **Settings / UI**
4. Go to the **Schedule** tab and set:
   - **Start Time** — when light shows begin each day
   - **End Time** — when they stop
   - **Interval** — minutes between each show
5. Go to the **Light Shows** tab to see your configured shows
6. Edit `config.json` (tray → Edit Config) to add your real API URLs and keys

---

## Config File Location

After first run, your config is saved to:
```
%APPDATA%\TrayScheduler\config.json
```
Open it from the tray menu → **Edit Config**

---

## Adding a Custom Icon

Place these files in the `assets/` folder before building:
- `icon.ico` — app icon (256×256px ICO format)
- `tray-icon.png` — tray icon (16×16 or 32×32px PNG)

Free PNG→ICO converter: https://convertio.co/png-ico/

---

## config.json Structure

```json
{
  "schedule": {
    "startTime": "18:00",
    "endTime": "23:00",
    "intervalMinutes": 10
  },
  "lightShows": [
    {
      "id": "ls-1",
      "name": "My Show",
      "enabled": true,
      "request": {
        "method": "POST",
        "url": "https://your-server.com/api/show",
        "headers": {
          "Authorization": "Bearer YOUR_API_KEY"
        },
        "body": { "show": "start" }
      }
    }
  ]
}
```

---

## How the Queue Works

1. At **Start Time** → all enabled light shows are shuffled into a random order
2. The **first show fires immediately**, then every N minutes the next one fires
3. When **all shows have played** → the list re-shuffles and the cycle repeats
4. At **End Time** → everything stops until tomorrow
5. Use **▶ Start Now** in Settings to override and start manually any time

---

## Auto-start on Windows Login

In `src/main.js`, change:
```js
app.setLoginItemSettings({ openAtLogin: false });
// to:
app.setLoginItemSettings({ openAtLogin: true });
```
Then rebuild.
