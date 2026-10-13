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

## Publishing an update later

1. Change `APP_VERSION` in **app.js** and `VERSION` in **sw.js** to the same new number (e.g. `1.0.1`).
2. Upload the changed files to GitHub (they replace the old ones).
3. On the phone tap **Update** in the app (needs internet). Your data is not affected.

## First-time setup in the app

Settings → company details, logo, banking details, VAT (on/off, 15%), currency (R), payment terms,
prefix (e.g. `INV-`) and **Last invoice number used** (e.g. 1047 → next invoice is INV-1048).

## Good to know

- **Backup often** (Settings → Export backup) and keep the file off the phone – clearing browser data or uninstalling deletes the invoices.
- Drafts keep their number reserved but don't advance "Last invoice number used"; finalising does.
- Payment reference: type `{number}` in "Payment reference instructions" to insert the invoice number.
- Print uses the phone's print dialog. If printing from the installed iPhone app does nothing, use **Share → Print**.

Bundled libraries: pdf-lib (MIT), pdf.js (Apache-2.0, Mozilla).
