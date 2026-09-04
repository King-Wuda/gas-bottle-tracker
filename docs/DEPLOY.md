# Putting the app on the internet

## It is deployed

**https://gas-bottle-tracker.onrender.com** — sign in with `mashabaindustriesllc@gmail.com`
or `jacques.viljoen@gmail.com`, password `password`.

Auto-deploy is on: every push to `main` builds and ships. The service is
`gas-bottle-tracker` (free plan, singapore) and the database is `Gas-Bottle-Tracker`
(free Postgres, singapore, **expires 2026-10-04**).

Three things about the free plan that will be noticed before anything else goes wrong:

- **It sleeps after ~15 idle minutes** and the next request waits 30-60 seconds while
  it wakes. Open the URL a minute before you present, not as you present.
- **The database is deleted after 30 days.** Move it to a paid plan for anything past
  a trial.
- **Singapore is a long way from South Africa** (~300 ms round trip). The database was
  created there and a free account gets one, so the service follows it. Frankfurt is
  roughly half the latency and is a database migration away, not a code change.

The rest of this document is how it was set up, and what to change.

The whole system is one web service and one Postgres database. The Fastify API serves
the Expo web build at `/app` from its own origin, so there is nothing else to host:
one URL, opened on a phone, is the app.

`render.yaml` in the repository root is a Render Blueprint that describes exactly
that. This document is what it does not fit in a comment.

## Deploying to Render

1. **Generate a QR signing keypair, once, and keep it.**

   ```bash
   npm run gen-qr-keys
   ```

   Or copy the pair already in `apps/api/.env`, which is the right move if labels
   printed from your local machine need to keep working. **A label is only valid under
   the key that minted it** — change the key later and every sticker already on a
   cylinder stops verifying, with no way back except reprinting them.

2. **Create the Blueprint.** In Render: **New → Blueprint**, point it at this
   repository, and let it read `render.yaml`. It will propose one web service (`gct`)
   and one database (`gct-db`).

3. **Fill in the four secrets** it asks for:

   | Variable                  | Value                                                     |
   | ------------------------- | --------------------------------------------------------- |
   | `QR_SIGN_PRIVATE_KEY_HEX` | The private half from step 1. Never leaves the server.    |
   | `QR_SIGN_PUBLIC_KEY_HEX`  | The public half. The web build's copy is derived from it. |
   | `RESEND_API_KEY`          | From resend.com — see "Real email" below.                 |
   | `MAIL_FROM`               | e.g. `GEA Cylinder Tracker <no-reply@yourdomain.co.za>`   |

   Everything else — the database URL, the JWT secret, the storage driver — is set by
   the blueprint.

   **All four are required for the service to start.** `MAILER=resend` with no
   `RESEND_API_KEY` fails validation at boot rather than at the first send — on
   purpose, because a server that starts happily and only reveals a missing key when a
   technician's batch fails to reach its project manager has moved the error somewhere
   nobody is watching. On Render that shows up as a deploy that will not come up; the
   reason is the first line of the log.

   If Resend is not ready yet and you need the site up now, set `MAILER=capture` and
   deploy without `RESEND_API_KEY`. Everything works except sending — delivery notes
   are still generated, attached to the queued message and stored, they just go into
   memory instead of out. Switch to `resend` when the key is ready; it is one
   environment variable and a restart.

4. **Deploy.** The build installs, generates the Prisma client and exports the web
   bundle; the start step applies migrations, seeds the reference data, and serves.
   First deploy takes a few minutes, mostly the Expo export.

5. **Open the URL Render gives you.** It redirects to `/app`. Sign in with
   `admin@demo.local` / `password`.

6. **Change the demo passwords, or turn the seed off.** The seeded accounts are
   public knowledge — they are in this repository. Once you have real users, set
   `SKIP_SEED=1` in the Render dashboard so the demo accounts stop being recreated on
   every deploy, and delete them.

## What the free plan costs you

The blueprint is on Render's free tier, so it costs nothing to stand up. Two
consequences are worth knowing before a demo rather than during one:

- **It sleeps.** A free web service spins down after ~15 minutes with no traffic, and
  the next request waits 30–60 seconds while it wakes. Open the URL a minute before
  you present, not as you present.
- **The database expires after 30 days.** Render deletes a free Postgres instance at
  that point. For anything beyond a trial, move the database to a paid plan.

What it does **not** cost you is evidence. A free instance's disk is wiped on every
spin-down, which would ordinarily take the photographs, signatures and delivery notes
with it — so the blueprint sets `STORAGE_DRIVER=db` and those bytes live in Postgres
instead. See `apps/api/src/services/storage.ts`. If you move to a paid instance with a
persistent disk, set `STORAGE_DRIVER=fs` and `STORAGE_DIR` to a path on it.

## The first ID read after a cold start is slow

`tesseract.js` downloads a ~5 MB English model the first time it runs and caches it in
the working directory. On a free instance that disk is ephemeral, so the download
happens again after every spin-down — the first "read the number off the photo" of a
session can take an extra ten seconds or so. Every one after it is under a second.

Nothing waits on it: the number is typed by hand and the return submits regardless.
See `apps/api/src/services/idOcr.ts`.

## Real email

Delivery notes and QR sheets are emailed to the project manager. `resend` is the only
transport that sends them, and it is the default — there is deliberately no
configuration of this server that boots believing it can send mail and cannot. To set
it up:

1. Create an account at [resend.com](https://resend.com) and **verify the domain you
   want to send from**. This is the step that takes the longest, because it needs DNS
   records added and propagated. In the Resend dashboard: **Domains → Add Domain**,
   enter the domain (e.g. `gct.co.za` — use a subdomain like `mail.gct.co.za` if the
   apex already sends mail elsewhere), pick the region closest to you, and Resend
   shows three records to add at your DNS provider:

   | Type         | Purpose                          | Notes                                        |
   | ------------ | -------------------------------- | -------------------------------------------- |
   | `MX`         | receives bounce reports          | on the `send` subdomain Resend names         |
   | `TXT` (SPF)  | authorises Resend to send as you | `v=spf1 include:amazonses.com ~all`          |
   | `TXT` (DKIM) | signs each message               | a long `p=...` public key — paste it exactly |

   Add them verbatim at your registrar, then press **Verify**. It is usually minutes;
   allow up to 48 hours. A DMARC record (`_dmarc`, `v=DMARC1; p=none;`) is optional and
   worth adding once the other three are green.

2. Create an API key and put it in `RESEND_API_KEY`.
3. Set `MAIL_FROM` to an address **at that verified domain**. A mismatch here is the
   usual cause of mail that silently never arrives.

**Until a domain is verified, Resend delivers to exactly one address: the one that
owns the Resend account.** It also refuses any sender but its own shared testing
address, so `MAIL_FROM` must be `onboarding@resend.dev` until then.

That is enough to demonstrate with, as long as the project manager on the batch IS
that address. A batch belonging to anyone else queues, is refused with a 403, and sits
`PENDING` with the reason in `OutboundEmail.lastError`. The app records that faithfully
— but nothing says so on the screen the operator is looking at, so pick the project
manager deliberately or verify a domain first.

## Why the web build has no baked-in API URL

`EXPO_PUBLIC_API_URL` is deliberately unset in the Render build. The bundle asks the
origin it was served from (`apps/mobile/src/config.ts`), and the API serves it, so the
two always agree. One build works on the Render URL, on a custom domain, and on a
Codespace forwarded port, with no rebuild.

The **Android APK is different** and still needs `EXPO_PUBLIC_API_URL` set to the
public URL at build time — an installed app has no serving origin to ask. See
[BUILD_APK.md](BUILD_APK.md); the sign-in screen says so out loud if it was built
without one.

## Custom domain

Render will serve a custom domain on request (Settings → Custom Domains) and issue the
certificate. Nothing in the app needs to change: same-origin means the app follows the
hostname wherever it goes.

## Running the same configuration locally

Worth doing before a deploy, because it catches everything except Render itself:

```bash
export QR_SIGN_PUBLIC_KEY_HEX=$(grep '^QR_SIGN_PUBLIC_KEY_HEX=' apps/api/.env | cut -d= -f2)
./scripts/render-build.sh
STORAGE_DRIVER=db SERVE_WEB_APP=../mobile/dist-web ./scripts/render-start.sh
```

Then open `http://localhost:3000`. This is the exact build and start path Render runs.
