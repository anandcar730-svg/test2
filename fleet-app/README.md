# Fleet Driver Monitor

A driver login website for keeping track of every vehicle, every day. Drivers can use it on their phones (it can be installed as an app), and the fleet owner or supervisor watches everything from one dashboard.

## What it does

| Feature | Driver | Admin |
|---|---|---|
| **Login** with username and password | ✔ | ✔ (creates driver logins) |
| **Daily kilometers**: start the day with the odometer reading and a photo, end the day with the reading and a photo. Distance is calculated for you | ✔ | sees all drivers |
| **CNG fueling**: date, odometer, kg, ₹/kg, total, station, and a photo of the bill | ✔ | sees all, plus km/kg mileage |
| **Oil change and service**: oil change, general service, tyre, brake, battery, CNG kit; cost, garage, next-due km, and a bill photo | ✔ | sees all |
| **Oil change alerts**: shows a warning when a change is due within 500 km or is overdue | ✔ | ✔ |
| **Accident report**: date and time, odometer, GPS location, severity, injuries, other party, FIR no., and **up to 8 photos** (at least one is required) | ✔ | updates status (Reported → In review → Insurance claimed → Closed) and adds notes |
| **Dashboard**: km today and this month, CNG kg and ₹, fuel cost per km, service spend, accidents, 14-day km chart, who is on the road now | own data | whole fleet |
| **Filters and CSV export** (opens in Excel) by driver, vehicle, and date range | own data | ✔ |
| Manage **vehicles** (reg. no., model, fuel, oil-change interval, assigned driver) and **drivers** (add, reset password, disable) | | ✔ |

Built-in checks keep the data reliable:
- A starting km can't be lower than the vehicle's last reading.
- An ending km can't be lower than the starting km.
- A vehicle can only have one open trip at a time.
- Drivers can only see their own records.
- Photos can only be opened by someone who is logged in.

## Run it

You need **Node.js 22.13 or newer**. There is nothing else to install: no `npm install`, no database server.

```bash
cd fleet-app
npm start
# open http://localhost:3000
```

On the first start it creates an admin account: **username `admin` / password `admin123`**. Log in, then **change the password** on the Profile page. You can also set your own password before the first start: `ADMIN_PASSWORD=... npm start`.

Getting started:
1. Log in as admin, go to **Drivers**, and create a login for each driver.
2. Go to **Vehicles** and add each vehicle with its current odometer reading and oil-change interval, then assign a driver.
3. Drivers log in on their phones and use **Daily km / CNG / Service / Accidents**.

Settings (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where the database (`fleet.db`) and the photos (`uploads/`) are stored. **Back this folder up.** |
| `TZ` | `Asia/Kolkata` | Time zone used for "today" and the monthly totals |
| `ADMIN_PASSWORD` | `admin123` | Password for the first admin account (used only on the first start) |

Test: `npm test` runs an end-to-end check of every feature against a temporary database.

## Put it online

This is a server app because all drivers need to share one database. **It cannot run on GitHub Pages**, which only serves static files. Host it anywhere that runs Node or Docker and gives you a persistent disk:

- **Docker** (any VPS, Railway, Render, Fly.io):
  `docker build -t fleet . && docker run -d -p 3000:3000 -v fleet-data:/data fleet`
- **A plain VPS**: copy the folder, then run `npm start` with a process manager (pm2 or systemd).

Put it behind **HTTPS** (most hosts do this for you). The phone camera and GPS only work on HTTPS or on localhost.

**Oracle Cloud (free VM):** step-by-step guide plus a one-command setup script in [`deploy/ORACLE-CLOUD.md`](deploy/ORACLE-CLOUD.md).

## How it's built

- `server.js`: the Node HTTP server. It uses the built-in SQLite (`node:sqlite`) and scrypt password hashing, with HttpOnly session cookies.
- `public/`: a single-page front end in vanilla JS, mobile first, with dark mode support. Photos are resized in the browser to about 1600 px before upload, so they upload quickly on mobile data.
- `test/smoke.test.js`: an end-to-end API test.
