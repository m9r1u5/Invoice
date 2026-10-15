# Invoices – offline invoicing app (PWA)

Works 100% offline after the first open. All data stays on your phone (IndexedDB).
Android (Chrome / Samsung Internet) and iPhone (Safari).

## Files (flat layout – upload all of them to the root of the repo)

| File | What it is |
|---|---|
| index.html | App page |
| app.js | All app logic |
| styles.css | Look & feel (light/dark) |
| manifest.json | Makes it installable |
| sw.js | Offline cache + updates |
| pdf-lib.min.js | Creates invoice PDFs (bundled, no CDN) |
| pdf.min.js, pdf.worker.min.js | Reads/previews PDFs, imports old invoices (bundled) |
| icon-192.png, icon-512.png, apple-touch-icon.png | App icons |

## Put it on GitHub Pages from your phone

1. Unzip `invoice-app.zip` on your phone (Files app → tap the zip → Extract).
2. In Chrome, open **github.com** → **+** → **New repository**. Name it e.g. `Invoices`, set **Public**, tick **Add a README**, tap **Create repository**.
3. In the repo tap **Add file → Upload files**, then **choose your files** and select **all files from the extracted folder** (not the folder itself). Tap **Commit changes**.
   - Tip: Chrome's "Desktop site" mode (⋮ menu) makes the GitHub upload page easier to use.
4. Tap **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)** → **Save**.
5. Wait 1–2 minutes, refresh the Pages screen; your link appears: `https://m9r1u5.github.io/Invoices/`
6. Open the link on your phone:
   - **Android:** tap the **Install** button at the top of the app.
   - **iPhone:** open the link in **Safari** → Share → **Add to Home Screen**.

## Android APK (built by GitHub from your phone)

The same repo also builds a real Android app (APK). GitHub does the building — nothing to install.

**One-time setup**

1. Upload `android-project.zip` to the repo root together with the other files (leave it zipped).
2. **Add the signing key secret:** repo **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `KEYSTORE_BASE64`
   - Secret: open `KEYSTORE_BASE64.txt` (sent separately), select all, copy, paste → **Add secret**.
   - Never upload `KEYSTORE_BASE64.txt` to the repo. Keep a copy somewhere safe (e.g. Google Drive) — every future
     update must be signed with this same key or Android will refuse to install it over the old version.
3. **Add the build workflow:** repo **Actions** tab → **set up a workflow yourself** → delete what's in the editor,
   paste the whole contents of `build-apk.yml` → **Commit changes**.
   (Same result: Add file → Create new file → name `.github/workflows/build-apk.yml`.)

**Build and install**

1. The build starts automatically after the commit (Actions tab → *Build Android APK*). It takes about 3–5 minutes.
   A green tick means done. To run it again by hand: Actions → Build Android APK → **Run workflow**.
2. On your phone open **github.com/m9r1u5/<repo>/releases/latest** → tap **Invoices-v1.0.1.apk** to download.
3. Open the downloaded file → allow "Install unknown apps" for Chrome/My Files if asked → **Install**.
   If Play Protect warns about an unknown developer, tap **More details → Install anyway**.

**What's different in the APK**

- Download PDF / backups save to your **Downloads** folder; Share opens Android's share sheet (WhatsApp, email…);
  Print uses Android printing (incl. *Save as PDF*); logo can come from gallery or camera.
- **Update** checks the repo's latest GitHub Release and offers to download the new APK. Installing it over the old one keeps all data.
- This repo is **private**, so release downloads and the Update button need you to be signed in to GitHub in your browser
  (Update opens the releases page). Others can't download the APK from here unless you add them as collaborators or make the repo public.
- The APK keeps its own data, separate from the browser version. To move data across: Settings → Export backup in one, Restore backup in the other.

## Publishing an update later

1. Change `APP_VERSION` in **app.js** and `VERSION` in **sw.js** to the same new number (e.g. `1.0.1`).
2. Upload the changed files to GitHub (they replace the old ones).
3. GitHub automatically builds a new APK release for that version.
4. On the phone tap **Update** in the app (needs internet) — the web app reloads; the Android app offers the new APK. Your data is not affected.

## First-time setup in the app

Settings → company details, logo, banking details, VAT (on/off, 15%), currency (R), payment terms,
prefix (e.g. `INV-`) and **Last invoice number used** (e.g. 1047 → next invoice is INV-1048).

## Good to know

- **Backup often** (Settings → Export backup) and keep the file off the phone – clearing browser data or uninstalling deletes the invoices.
- Drafts keep their number reserved but don't advance "Last invoice number used"; finalising does.
- Payment reference: type `{number}` in "Payment reference instructions" to insert the invoice number.
- Print uses the phone's print dialog. If printing from the installed iPhone app does nothing, use **Share → Print**.

Bundled libraries: pdf-lib (MIT), pdf.js (Apache-2.0, Mozilla).
