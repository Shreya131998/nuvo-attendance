# Cleaning Attendance (QR + Vercel + Google Sheets + Cloudinary)

Staff scan **one QR code**, pick the toilet they cleaned and their name, and take a live photo.
- **Google Sheets** stores the records: name, toilet, date, time, photo link.
- **Cloudinary** stores the photos.
- **Vercel** hosts the worker form and a PIN-protected admin dashboard.

| URL | What it is |
|---|---|
| `https://your-app.vercel.app/` | Worker form (this is what the QR code opens) |
| `https://your-app.vercel.app/admin` | Admin dashboard |

## Project layout

```
public/index.html    worker form
public/admin.html    admin dashboard
api/config.js        GET  toilets + staff list for the form
api/submit.js        POST name + toilet + photo → Cloudinary + Sheet
api/login.js         POST admin PIN → session cookie
api/logout.js        POST clears session
api/dashboard.js     GET  dashboard data for a date (admin only)
lib/                 Google Sheets, Cloudinary, auth, time helpers
apps-script-version/ the earlier Google Apps Script version (not used by Vercel)
```

There are no npm dependencies. The code only uses features built into Node 20.

## Setup

### 1. Google Sheet + service account (about 10 minutes)
1. Create a Google Sheet. Copy its **ID**, the long part of the URL between `/d/` and `/edit`.
2. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project (or pick an existing one).
3. Open **APIs & Services → Library**, search for **Google Sheets API**, and click **Enable**.
4. Open **IAM & Admin → Service Accounts → Create service account**. Name it e.g. `attendance-bot`. You can skip the roles step.
5. Open the service account, go to **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
   Keep it safe and **never commit it**.
6. In your Google Sheet, click **Share**, paste the service account email (`...@...iam.gserviceaccount.com`), and give it **Editor** access.

You don't need to create any tabs. On the first request, the app creates **Attendance**, **Staff** and **Locations** with sample rows.

### 2. Cloudinary
1. Sign up at [cloudinary.com](https://cloudinary.com). The free plan is plenty for this.
2. Go to **Dashboard → API Keys** and copy the **Cloud name**, **API Key** and **API Secret**.

The app saves photos to `cleaning-attendance/YYYY-MM-DD/` in your Cloudinary Media Library.

### 3. Deploy to Vercel
1. Push this folder to a GitHub repo, then on [vercel.com](https://vercel.com) choose **Add New → Project** and import the repo.
   Or, from this folder, run `npx vercel`.
2. In **Project → Settings → Environment Variables**, add every variable from [.env.example](.env.example):

   | Variable | Value |
   |---|---|
   | `ADMIN_PIN` | Your dashboard PIN. Use 6 or more digits. |
   | `SESSION_SECRET` | A long random string (`openssl rand -hex 32`) |
   | `SHEET_ID` | From step 1.1 |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` from the JSON key |
   | `GOOGLE_PRIVATE_KEY` | `private_key` from the JSON key. Paste it as-is, including `-----BEGIN…` and the `\n`s. |
   | `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | From step 2 |

3. **Redeploy** (Deployments → ⋯ → Redeploy). Vercel only picks up new variables on a new deploy.
4. Open `https://your-app.vercel.app/admin`, enter the PIN, go to the **QR Code** tab, and click **Print**.
   The same QR code works for every toilet.

### Running locally (optional)
To try it with no accounts or keys, run demo mode. It uses a fake in-memory Sheet and Cloudinary, and the data is lost when the server stops:
```bash
npm run demo
```
Then open http://localhost:3000 (the form) and http://localhost:3000/admin (the dashboard, PIN `1234`).

To run against your real Sheet and Cloudinary, copy `.env.example` to `.env.local`, fill it in, then run:
```bash
npm run dev
```

## Day-to-day
- **Workers:** in the dashboard sidebar, open **Workers** to add or remove people.
  - Changes are saved to the **Staff** tab in Google Sheets and appear in the form straight away.
  - You can also edit the Staff tab directly. Set Active to `No` to hide someone without deleting them.
- **Toilets:** in the sidebar, open **Locations** to add or remove toilets.
  - Changes are saved to the **Locations** tab, and the app creates an ID automatically.
  - No QR reprint is needed. If only one toilet is active, the form picks it automatically.
- Removing a worker or toilet doesn't touch past attendance rows.

## Hindi
- **The worker form opens in Hindi.** The **English** button at the top switches it, and each phone remembers its choice.
- **Location names in Hindi:**
  - When you type a location's English name on the **Locations** page, the Hindi name fills in automatically. You can edit it before clicking Add.
  - Hindi you type yourself is never overwritten.
  - For existing locations, click **✎ Hindi** to add or fix the Hindi name.
  - Hindi names are saved in the **Hindi Name** column (D) of the Locations tab. Older sheets get the column header added automatically.
  - If a location has no Hindi name, the form shows its English name instead.
- **How the translation works:** it uses Google Sheets' own `GOOGLETRANSLATE` function, so it's free and needs no extra API key.
  The app adds a hidden tab called **_Translate** for this. Don't delete it, but if you do, it's recreated automatically.
  If Google doesn't return a translation, type the Hindi yourself.
- **Worker names in Hindi** work the same way:
  - On the **Workers** page, the Hindi spelling fills in as you type (e.g. "Ramesh Kumar" → "रमेश कुमार").
  - Click **✎ Hindi** to add or fix one for an existing worker.
  - Hindi names are saved in the **Hindi Name** column (C) of the Staff tab.
  - When the form is in Hindi, workers see their name in Hindi. Attendance is still recorded under the English name, so the dashboard and Sheet stay consistent.
- **Dashboard** (`/admin`):
  - *Overview*: shows each toilet as cleaned (green) or pending (red), each staff member as done or not done, and the last 7 days.
  - *Entries & Photos*: every submission with its photo (tap to enlarge), plus a CSV export.
  - Pick any past date with the date picker. When you're viewing today, the page refreshes every minute.

## Notes
- **The date and time come from the server**, not the phone, so staff can't fake when the work was done.
- **Camera only:** the form uses a live in-page camera. If the browser blocks that, it opens the phone's camera app instead,
  and rejects any photo older than 2 minutes, so a gallery photo can't be reused.
- Photos are resized to about 1280px on the phone before upload, typically 150–300 KB each.
- If someone submits the same toilet twice within 30 minutes, the submission is still saved, but they see a warning.
- **Photo privacy:** Cloudinary links are public but contain a random part, so they can't be guessed. Only the dashboard shows them.
- **Login security:** the dashboard login lasts 12 hours. Changing `ADMIN_PIN` and redeploying logs out everyone.
