# Fleet Driver Monitor

A driver login website for keeping track of every vehicle, every day. Drivers can use it on their phones (it can be installed as an app), and the fleet owner or supervisor watches everything from one dashboard.

## What it does

| Feature | Driver | Admin |
|---|---|---|
| **Login** with username and password | ✔ | ✔ (creates driver logins) |
| **Daily kilometers**: start the day with the odometer reading and a photo, end the day with the reading and a photo. Distance is calculated for you | ✔ | sees all drivers |
| **Fuel & charging** for **CNG (kg), Petrol (L), Diesel (L) and EV (kWh)**: date, odometer, quantity, rate, total, station or charger, and a bill photo. **EVs can be logged with just the odometer reading** (home/office charging). kWh, cost and battery % are optional, and km driven is worked out from the readings | ✔ | sees all, plus mileage per vehicle (km/kg, km/L, km/kWh) |
| **Oil change and service**: oil change, general service, tyre, brake, battery, CNG kit; cost, garage, next-due km, and a bill photo | ✔ | sees all |
| **Oil change alerts**: shows a warning when a change is due within 500 km or is overdue (not shown for EVs) | ✔ | ✔ |
| **Accident report**: date and time, odometer, GPS location, severity, injuries, other party, FIR no., and **up to 8 photos** (at least one is required) | ✔ | updates status (Reported → In review → Insurance claimed → Closed) and adds notes |
| **Dashboard**: km today and this month, fuel used per type and ₹, fuel cost per km, service spend, accidents, 14-day km chart, who is on the road now | own data | whole fleet |
| **Filters and CSV export** (opens in Excel) by driver, vehicle, and date range | own data | ✔ |
| Manage **vehicles** (reg. no., model, fuel, oil-change interval, assigned driver) and **drivers** (add, reset password, disable) | | ✔ |

Built-in checks keep the data reliable:
- A starting km can't be lower than the vehicle's last reading.
- An ending km can't be lower than the starting km.
- A vehicle can only have one open trip at a time.
- Drivers can only see their own records.
- Photos can only be opened by someone who is logged in.

## Loyverse POS (automatic fuel entries)
If your pump or shop uses **Loyverse POS**, fuel sales are added automatically.

1. **Connect:** in Loyverse Back Office go to **Settings → Access tokens → Add**. Then in this app go to **Loyverse**, paste the token and click **Connect**.
2. **Identify the vehicle on each receipt.** Either:
   - click **Add / update vehicles in Loyverse**, which creates one Loyverse *customer* per vehicle number. The cashier then selects that customer at the pump. Or:
   - type the vehicle number (or its last 4 digits) in the receipt comment.
3. **Automatic import:** every 5 minutes, each Petrol / Diesel / CNG line becomes a fuel record (litres or kg, rate, amount, date).
   - Sales with no recognisable vehicle wait under **Loyverse → Sales without a vehicle**, where you assign them by hand.
   - Refunds and cancelled receipts are removed again.
4. **Odometer:** Loyverse has no odometer reading, so drivers tap **➕ Add km** on the record afterwards. This is needed for accurate mileage.

Fuel items are recognised by name: *Petrol / Power / Speed / XP95* → Petrol, *Diesel / HSD* → Diesel, *CNG* → CNG.
Optional settings: `LOYVERSE_SYNC_MINUTES` (default 5) and `LOYVERSE_API` (for testing).

## Vehicle documents (insurance, pollution, fitness)
The **Documents** page (admin) shows every vehicle's expiry dates for **insurance, pollution (PUC), fitness, road tax and permit**, colour-coded:
- **green:** valid
- **orange:** expires within 30 days
- **red:** expired

Expired and expiring documents also appear as alerts on the dashboard (drivers see their own vehicle's) and on each vehicle's page.

**Online update by vehicle number.** These details live in VAHAN (Parivahan), which has **no free public API**. Use a licensed **RC-verification API** provider. Each lookup is a paid call.

| Provider in the app | Price | Set-up |
|---|---|---|
| **RTO Sarthi** (default) | from **₹1.5 per successful search**, prepaid, no monthly fee | Contact them (WhatsApp +91 62646 82508, rtosarthi@gmail.com) for a Vahan API key. Copy the **API URL**, **key header** and **request body** from the integration guide they send into the settings. The response format (`INSURANCE_UPTO`, `PUCC_UPTO`, `FIT_UPTO`, `TAX_UPTO`, `usage`…) is already understood. |
| Surepass | contact sales | Paste the API token. Everything else is preset. |
| Other provider (custom) | – | Enter the URL, header and JSON body for any provider. The usual field names are found automatically. |

Go to **Documents → Online lookup settings**, choose the provider, fill in the details and save.

**Smart sync** is the default and about 90% cheaper. Every morning (06:00 by default) it only looks up the vehicles that need it:
- a document has **expired or expires within 30 days** (so the renewal shows up the next day)
- the vehicle has **never been checked**
- the vehicle **hasn't been checked for 30 days**

Failed lookups (for example, a wrong vehicle number) are retried weekly. The Documents page shows tomorrow's lookup count, the estimated cost, the reason for each vehicle, and the **prepaid searches left** if the provider reports them. Use **Smart sync now** at any time, or **Sync all** to force every vehicle. You can also choose *Every vehicle, every day*.

Lifetime road tax (`LTT`) is shown as **Lifetime**.

**Without an API key**, click **✏️ Edit** and type the dates by hand. Typed dates are kept until an online update brings a value for that field.

## Vehicle details by hand
**Vehicles → ✏️ Edit details** opens one page for everything about a vehicle. It also opens right after you add a vehicle, and from the vehicle page and the Documents page. All fields are optional:
- **Basic:** model, fuel, oil-change interval, driver, active. The starting odometer can be corrected until the first record is entered.
- **Registration (RC):** owner, make/model, class, registration date and RTO, chassis and engine numbers, month/year of manufacture, colour, seating, financer, RC status.
- **Insurance** (company, policy no., valid till), **PUC** (number, valid till), **Fitness**, **Road tax** (or *Lifetime*), **Permit**.
- **Scanned papers:** a photo or PDF for the RC, insurance, PUC, fitness, tax and permit. Files are only visible to logged-in users.
- **Notes.**

If an online lookup is connected, it fills in the same fields. Values you typed are kept wherever the lookup has nothing, and scanned papers are never changed by it.

## Battery, parts, wheels, daily checks and complaints
These are on each **vehicle page**:
- **🔋 Battery & parts with warranty / expiry** (admin):
  - a battery with brand, **serial number**, installed date and odometer, warranty (6 months to 6 years) or an exact date, cost, shop and **photo**. A new battery automatically marks the previous one as *replaced*.
  - **tyres** and **any other part with an expiry date**, such as a fire extinguisher, wiper blades, FASTag, GPS tracker or first-aid kit.
  - alerts on the dashboard when something expires within 30 days or has expired.
- **🛞 Wheels & tyres** (drivers and admin): alignment, balancing, rotation, air pressure, puncture, damage and replacement, with date, which wheel(s), odometer, cost, garage, notes and a photo.
- **✅ Daily oil & coolant check** (drivers): *OK / Topped up / Low* for engine oil (not asked for EVs) and coolant, once per vehicle per day.
  - It's on the **Daily km** page.
  - Drivers get a reminder on their dashboard.
  - The admin sees "checked today: 3/5", and any **Low** level appears as an alert.
- **📣 Complaints** (everyone; also its own menu page): report a mechanical problem, damage found, **damage or misuse by another driver** (choose who used the vehicle before you, or type a name), electrical/AC, tyres, cleanliness or a missing item.
  - Each complaint has a priority and photos. Photos are required for damage.
  - The admin sets the status: *Open → In progress → Resolved / Rejected*, with notes.
  - Drivers see their own complaints and the ones about them.

## Location tracking during trips
**When it runs:** only between **Start trip** and **End trip**. There is no tracking outside a trip.
- **Start trip:** the phone asks for location permission, and the start position is saved. While driving, a point is saved about every 30 s, or sooner after moving 50 m.
- **Points are sent in batches.** If there is no signal they wait on the phone and are sent later.
- **The driver always sees** a green **"Location sharing on"** bar with the GPS age, accuracy and points sent.
- **End trip:** the end position is saved and sharing stops.

**Maps:**
- **📍 Live map** (admin): vehicles on a trip right now, with driver (tap to call), last update, speed and *no signal* warnings. It refreshes every 30 s and has a Google Maps link.
- **🗺 Route** for each trip (in the Daily km history): the path, start and end, GPS vs odometer distance, time, and average and top speed. Drivers see their own trips; the admin sees all.

**Data quality:** inaccurate fixes (> 100 m) and GPS jumps are ignored in distances. Location points are deleted after **180 days** (`LOCATION_KEEP_DAYS`).

**Limits of a website:** browsers only share location **while the app is open on screen**. The app keeps the screen awake during a trip, so use a phone holder. Tracking with the screen off or another app in front would need a native Android app.

**Maps library:** Leaflet 1.9.4 (BSD licence) is bundled in `public/vendor/leaflet`. Map pictures come from OpenStreetMap.

## Notifications for expiry and warranty dates
Reminders cover **insurance, PUC, fitness, road tax, permit, battery / tyre / part warranties** and **oil change due**:
- **When:** 30, 15, 7, 3 and 1 days before, on the day, then **weekly while expired**. The admin can change these days and the time (08:00 by default).
- **Who:** the admin gets reminders for all vehicles; a driver gets reminders for their assigned vehicle.
- **Where:**
  - the **🔔 bell** in the top bar (with an unread count) and the Notifications page
  - **push notifications on phones and computers**, even when the site is closed, using the browser's built-in Web Push. No SMS or WhatsApp service and no extra cost.
- **Turning it on:**
  - **Android / computer:** open **🔔 → Turn on notifications** and allow them.
  - **iPhone (iOS 16.4+):** first **Share → Add to Home Screen**, open the app from the home screen, then turn notifications on.
- **Details:**
  - A renewed document (new date) starts its own reminders.
  - Missed days (server down) are caught up the next morning.
  - The push keys are created automatically and stored in the database.
  - Push needs HTTPS, which the Oracle/Cloudflare set-up provides.

## Vehicles section (everyone)
**🚐 Vehicles** in the menu shows every vehicle as a card: photo, number, model, colour, seats, driver and odometer, plus status chips. The chips cover:
- papers expired or due
- oil change due
- battery warranty
- today's oil and coolant check
- open complaints

Search by number, model, driver or colour, or filter **Needs attention** / **Mine**. The admin also gets **➕ Add vehicle** and **⚙️ Manage fleet** (assign drivers, fuel, oil interval, active).

Opening a vehicle shows its profile: a header with the photo, driver (tap to call), status chips and quick buttons (**Edit details**, **Daily check**, **Add fuel**, **Raise complaint**), and these tabs:
- **Overview:** odometer, mileage, this month's km, fuel and service, oil-change status, **Key facts** (insurance, PUC, fitness, tax, battery S/N and warranty, chassis/engine no.), all-time totals and the latest changes.
- **Details & papers:** RC details, documents with their copies, and the **full change history**.
- **Upkeep:** battery and parts, wheels and tyres, daily checks, service records.
- **Fuel & km:** fuel/charging and daily km.
- **Complaints & accidents.**

**Who can change what:**
- **Drivers and admin:** vehicle photo, RC details, insurance, PUC, fitness, tax, permit, scanned papers and notes; adding or editing a battery, tyre or other part; wheel work, daily checks and complaints.
- **Admin only:** model, fuel, assigned driver, oil-change interval, starting odometer, active/inactive, and deleting records.

Every change is written to the vehicle's **change history** with the person's name and time, for example *"Ravi Kumar · Insurance valid till: — → 2027-07-18; Vehicle photo added"*.

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

Test: `npm test` runs an end-to-end check of every feature against a temporary database, including the Loyverse import against a fake Loyverse API.

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
