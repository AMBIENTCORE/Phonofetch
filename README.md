# Phonofetch

Phonofetch is a single-container, mobile-friendly download manager for an **existing** slskd 0.26.1 instance. It searches and queues through the slskd REST API; slskd alone handles Soulseek and writes media files. No music-library or downloads mount is required by Phonofetch. No existing slskd or Nicotine+ container is changed.

## Architecture and safeguards

React/Vite is served by Express from the same container. Express owns slskd credentials, authenticated sessions, input validation and CSRF protection. SQLite under `/data` stores batches, requests, candidate evidence, folder previews/jobs, individual transfers, worker leases and activity. One server-side worker searches, queues and reconciles with slskd even if every browser is closed. Only one Phonofetch replica may use a database.

The interface uses a native dark greyscale theme with compact sans-serif text and a condensed batch-entry form for phones and tablets. You do not need a browser dark-mode extension for Phonofetch. Activity filters are collapsed by default on narrow screens so recent events remain visible. Mobile Safari may zoom in when a small text field receives focus.

Review mode is the default. Each nonblank line is one editable full-text search; multiple lines make a batch automatically named `Batch #N [YYYY-MM-DD]` using the Europe/Lisbon date. Each line can request an individual track or an album/folder, with per-line quality. Album/folder defaults to track-seeded directory discovery; select Album title on the reviewed row when the text is an album name. The **default MP3 320** filter requires an MP3 with API-reported 320 kbps *and* explicit constant-bitrate metadata; an unverified/VBR flag or filename saying "320" is insufficient. FLAC requires a `.flac` extension but cannot establish source provenance. "Any quality" must be selected explicitly. No automatic fallback is made. Track selection queues one file; folders are inspected and each eligible audio file is queued separately. Partial albums remain labeled partial. Automatic album selection is reserved for a uniquely confident album-title folder with at least two eligible files and no excluded audio; track-seeded folder downloads require manual confirmation.

If a queue request's acknowledgement is lost, the item is marked **uncertain**, not automatically resent. Inspect that file in slskd before deciding what to do. SQLite retains the audit trail, including reasons for quality exclusion. Failed searches can be retried from the batch page, optionally with a different explicit quality. Confirmed failed/cancelled files can be manually retried (bounded by `MAX_RETRIES`) after checking slskd for an active/completed copy; each attempt gets a new stable batch UUID. Uncertain transfers cannot be retried blindly.

### Finding an album from a track name

For lines such as `pepper stone love` or `burial archangel`, select **Album / folder** and click **Review list**. Each reviewed row shows its entire editable search string. **Search for → Track inside folder** is the default for album/folder requests; choose **Album title** explicitly if the text names the album. In Review mode, submit the batch and wait for slskd search results. **Inspect folder** then appears under **Candidate folders** on the batch page if a remote directory was found; it does not appear on the New Batch form. Check the peer, directory and eligible/excluded files before confirming. Track-seeded folders always require manual confirmation, even in Automatic mode.

Soulseek receives a **single plain-text search**, not separate artist/title fields: `Ben Klock - Subzero` is submitted as `ben klock subzero`. The dash is optional; you can enter `ben klock subzero` directly. Relevance ranking compares the query words to remote filenames and directory paths. The Activity Log records the exact normalized query, slskd search ID, result count and quality exclusions.

The local preview at `127.0.0.1` is not connected to your NAS's slskd, so it cannot produce candidate folders or an Inspect folder button. Perform this workflow on the deployed NAS application.

### slskd 0.26.1 API compatibility

Verified against [slskd 0.26.1 source at `71dcc7a`](https://github.com/slskd/slskd/tree/71dcc7a60650b5a61d1d2a35609b65f3467d1396/src/slskd), with protocol types from its pinned Soulseek.NET 10.0.2 dependency. The backend sends the raw ReadWrite secret only in the `X-API-Key` header. `GET /api/v0/session` probes authentication (not merely unauthenticated `/health`).

| Operation | Verified API / behavior |
| --- | --- |
| Search | [`POST /api/v0/searches`](https://github.com/slskd/slskd/blob/71dcc7a60650b5a61d1d2a35609b65f3467d1396/src/slskd/Search/API/Controllers/SearchesController.cs) with `{searchText,fileLimit,searchTimeout}`; poll `GET /api/v0/searches/{id}`, then `GET /api/v0/searches/{id}/responses` after the `Completed` state flag. Responses contain usernames and flattened file `{filename,size,bitRate?,bitDepth?,sampleRate?,isVariableBitRate?}`. In slskd 0.26.1, [`SearchRequest`](https://github.com/slskd/slskd/blob/71dcc7a60650b5a61d1d2a35609b65f3467d1396/src/slskd/Search/API/DTO/SearchRequest.cs) calls the field seconds but forwards it unconverted to [`Soulseek.NET SearchOptions`](https://github.com/jpdillingham/Soulseek.NET/blob/94fba7d4056796af067e6d7b2a8628099723cd26/src/Options/SearchOptions.cs), where it is **milliseconds**. Phonofetch sends `40000` for a 40-second search by default, reserving 5 seconds of its 45-second deadline for polling. Before searching, [`GET /api/v0/server`](https://github.com/slskd/slskd/blob/71dcc7a60650b5a61d1d2a35609b65f3467d1396/src/slskd/Core/API/Controllers/ServerController.cs) confirms slskd is connected and logged in to Soulseek; API authentication alone is insufficient. |
| Folder | [`POST /api/v0/users/{username}/directory`](https://github.com/slskd/slskd/blob/71dcc7a60650b5a61d1d2a35609b65f3467d1396/src/slskd/Users/API/Controllers/UsersController.cs) with `{directory}` returns the immediate folder's full remote filenames. Only explicit recursive scope calls `GET /api/v0/users/{username}/browse`, a flat full-share listing; Phonofetch restricts accepted paths to the chosen folder/subtree. |
| Queue | [`POST /api/v0/transfers/downloads/batches`](https://github.com/slskd/slskd/blob/71dcc7a60650b5a61d1d2a35609b65f3467d1396/src/slskd/Transfers/API/Controllers/TransfersController.cs) with one `{filename,size}` per Phonofetch transfer, a stable caller-provided batch UUID and username. The response contains failures and generated transfer IDs. No direct directory-download endpoint is used. |
| Monitor / cancel | `GET /api/v0/transfers/downloads` returns users → directories → transfers with `id,batchId,filename,size,state,bytesTransferred`. `DELETE /api/v0/transfers/downloads/{username}/{id}` cancels by **slskd transfer ID**, not by filename. There is no dedicated server-side retry-by-ID endpoint; slskd itself can retry transfers according to its configured policy. |

Soulseek shares are flat directory listings, not recursive tree objects. The remote `bitRate` and nullable `isVariableBitRate` fields are derived from peer-supplied file attributes, and slskd omits nulls from JSON. `isVariableBitRate: false` explicitly reports constant bitrate; a missing key does **not** imply false. A 320 kbps claim with missing bitrate/VBR data is excluded. Peer-reported metadata cannot independently prove the actual encoded audio, and FLAC provenance cannot be verified remotely. The actual NAS, peer availability and live API responses have **not** been tested in this development environment; the adapter tests use realistic source-based mocks.

## Build and deploy to UGREEN NAS / Portainer

Requirements: Docker Engine with the **existing** `phonofetch_net` external network, existing `slskd` container reachable as `http://slskd:5030` from that network, and a slskd API key configured with `ReadWrite` permissions. Phonofetch never needs port 5030 published on the NAS.

### Files for a source repository

The NAS image build needs `Dockerfile`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/`, and `public/`. Also keep `.dockerignore` so local secrets and generated files are not sent to the Docker build context. Include `compose.yaml`, `.env.example`, `.gitignore`, and this README for deployment and documentation.

Do **not** commit `.env` or other `.env.*` files (except `.env.example`), `.npmrc`, databases, `node_modules/`, `dist/`, logs, image archives, or NAS credentials. The real API key, login password, and session secret are configured **on the NAS** through a private `.env` or Portainer environment. The provided `.gitignore` excludes the common local variants, but check the files you stage before publishing.

1. Copy this source directory to the NAS (e.g. via an SFTP client) and run these commands in that directory over SSH:

   ```sh
   docker network inspect phonofetch_net
   mkdir -p /volume2/docker/phonofetch
   # Node in the production image uses UID/GID 1000. Set ownership/ACLs
   # appropriately if the NAS's existing permissions differ.
   sudo chown 1000:1000 /volume2/docker/phonofetch
   docker build -t phonofetch:local .
   ```

   Do not change the ownership of `/volume2/docker/slskd` or any music/download folder. `docker network inspect` must show the pre-existing network; the Compose file does not create one.

2. Create a strong application password, a unique random session secret of **at least 32 characters**, and use the **raw** slskd ReadWrite API secret (not its `role=ReadWrite;` declaration prefix). Copy `.env.example` to `.env` alongside `compose.yaml` **on the NAS** and replace every placeholder. Keep that file private (`chmod 600 .env`). Do not put passwords in the repository, the web UI, or browser JavaScript. The defaults are:

   | Setting | Value / purpose |
   | --- | --- |
   | `PHONOFETCH_IMAGE` | Optional image reference; defaults to `phonofetch:local`. Set to a published image reference for pull-based updates. |
   | `PORT`, `TZ`, `DATABASE_PATH` | `3000`, `Europe/Lisbon`, `/data/phonofetch.sqlite` |
   | `SLSKD_BASE_URL` | `http://slskd:5030` |
   | `SLSKD_API_KEY` | Raw slskd API secret with `ReadWrite` access |
   | `PHONOFETCH_AUTH_USERNAME`, `PHONOFETCH_AUTH_PASSWORD` | Single-user login; password at least 12 characters |
   | `PHONOFETCH_SESSION_SECRET` | Random secret, at least 32 characters |
   | `TRUST_PROXY` | `false` by default; set to `true` only if an HTTPS reverse proxy you control is the *only* entry point to the app (trusts one proxy hop for Secure cookies/Origin checks) |
   | `SEARCH_CONCURRENCY`, `SEARCH_TIMEOUT_MS`, `SEARCH_RESULT_LIMIT` | Defaults `2`, `45000`, `120`. The application deadline is in milliseconds (minimum 10000); the slskd 0.26.1 search window is 5 seconds shorter. |
   | `MAX_RETRIES`, `AUTO_TRACK_SCORE`, `AUTO_ALBUM_SCORE` | Defaults `3`, `0.93`, `0.98` |
   | `MAX_FOLDER_FILES`, `MAX_FOLDER_BYTES` | Defaults `250`, `10737418240` |

3. Either deploy directly with `docker compose --env-file .env -f compose.yaml up -d` **or** in Portainer:
   - Build `phonofetch:local` on the NAS as above first. Portainer's web stack editor does **not** have this source as its Docker build context; do not expect it to build the image from a pasted Compose file.
   - Go to **Stacks → Add stack**, name it `phonofetch`, paste `compose.yaml`.
   - Enter the four required secrets/username as Portainer stack environment variables (and optional limits), then deploy. Keep Portainer access restricted because stack variables are sensitive.
   - The stack contains only Phonofetch and uses the **external** `phonofetch_net`. It does not redeploy or depend on modifying slskd.

4. Open `http://NAS-IP:7289` from your local network. Sign in using your configured application credentials. Check the container health status and Activity Log for slskd connectivity. The browser cannot directly reach slskd or the SQLite file.

Compose maps NAS port `7289` to container port `3000`; it does not publish slskd or a database port. Do **not** configure router port forwarding. For outside-home access, use Tailscale or a secured HTTPS reverse proxy. HTTPS is strongly recommended beyond a trusted LAN. Sessions use HttpOnly/SameSite=Strict cookies, with Secure cookies on HTTPS requests. If a reverse proxy terminates TLS, restrict direct access to port 7289 and only then set `TRUST_PROXY=true` so Express trusts the proxy's `X-Forwarded-Proto`/client IP; never trust forwarding headers from untrusted clients. Do not share application access publicly over HTTP.

### Updating without copying source to the NAS

The initial local-build instructions above remain valid. For repeat updates, an image registry is easier: publish a Phonofetch image under a versioned tag, set `PHONOFETCH_IMAGE` in the **NAS-only** `.env` (for example `ghcr.io/YOUR-OWNER/phonofetch:v1`), then run on the NAS:

```sh
docker compose --env-file .env -f compose.yaml pull phonofetch
docker compose --env-file .env -f compose.yaml up -d --no-deps phonofetch
```

A private GitHub repository with a GHCR build workflow is one possible image source, but **no GitHub repository or image publication is configured by this project**. If you choose that route, create and publish it yourself, do not add `.env` or passwords to the repository, and configure NAS registry read access for a private package. Copy `compose.yaml` to the NAS once; the NAS can then pull versioned images without receiving source files or rebuilding them. The raw slskd key, application password and session secret remain in the NAS's private `.env` (or Portainer's NAS-hosted stack environment), not in GitHub or the image. Back up `/volume2/docker/phonofetch` before upgrades; only recreate Phonofetch.

Without any external registry, build the image on a machine with Docker, use `docker save -o phonofetch-image.tar phonofetch:local`, transfer **that image archive** to the NAS, run `docker load -i phonofetch-image.tar` there, and recreate only Phonofetch with `docker compose --env-file .env -f compose.yaml up -d --no-deps --force-recreate phonofetch`. This avoids copying source or building on the NAS, but still transfers an image per update.

### Upgrade, backup and removal

Stop Phonofetch or take an SQLite-consistent backup (e.g. SQLite backup API) before copying database files; in WAL mode a live database may include `-wal` and `-shm` files. Simplest safe backup:

```sh
docker compose --env-file .env -f compose.yaml stop phonofetch
cp -a /volume2/docker/phonofetch /volume2/docker/phonofetch-backup
docker compose --env-file .env -f compose.yaml up -d phonofetch
```

For upgrades, back up first, copy the updated source, rebuild with `docker build -t phonofetch:local .`, then run `docker compose --env-file .env -f compose.yaml up -d --no-deps --force-recreate phonofetch`. In Portainer, rebuild the image on the NAS and **recreate only the Phonofetch stack/container**, not slskd. Migration is automatic on startup; the application refuses database versions newer than it understands. To recover, stop Phonofetch, restore its backed-up `/volume2/docker/phonofetch` directory and permissions, and start only Phonofetch. If you remove it, `docker compose down` affects only this stack; it does **not** delete the external network or slskd. Preserve `/data` if you need history.

### Safe manual end-to-end validation (requires access to NAS)

1. Ensure slskd is already online and the new Phonofetch container can resolve/reach `http://slskd:5030`. Sign in to Phonofetch and confirm a successful slskd authentication/connectivity event. Do not test using real private credentials in development fixtures.
2. Choose **New Batch**, enter one known full-text query such as `burial archangel` as **Track**, set **Review** mode and choose FLAC or explicitly Any quality if strict 320 metadata is unavailable. Submit, select exactly one eligible candidate, confirm, and check slskd and the batch page for exactly one queued file and its accurate completion. Close the browser briefly and verify progress continues.
3. Enter a full-text query such as `burial archangel` as **Album / folder** (track-seeded by default), review candidates, inspect a folder and confirm the actual peer/directory, eligible and excluded file list, and size. Use a known small folder you are allowed to download. Confirm; check that only eligible files from that exact directory are queued and that excluded/incomplete albums are labeled partial. If searching an album's name instead, select **Search for → Album title** on the reviewed row.
4. Restart **only** the Phonofetch container. Check that its batch, transfers and Activity Log remain and that reconciling does not queue duplicates. Inspect the Activity Log for time-stamped explanations and any API errors.

Live Soulseek/slskd/NAS transfers cannot be verified by the local automated tests: they mock slskd's HTTP API. Validate these steps on the NAS before trusting unattended downloads.

## Local development

Requires Node 24+ (`node:sqlite`). Run `npm ci`, `npm test`, `npm run typecheck`, `npm run build`. For a local server use `DATABASE_PATH` pointing at a writable development location and set `SLSKD_API_KEY`, `PHONOFETCH_AUTH_USERNAME`, `PHONOFETCH_AUTH_PASSWORD`, and `PHONOFETCH_SESSION_SECRET` from `.env.example` in your environment, then `npm run dev`. Set `SLSKD_BASE_URL` to an address reachable from the development machine if testing a real slskd instance; its Docker-network default is normally not reachable from the host. Vite's optional dev server (`npx vite`) proxies `/api` to port 3000; production serves the built UI from Express. Tests use only temporary SQLite files and mocked slskd calls.

## Troubleshooting

- `Another Phonofetch worker owns this database`: do not run multiple replicas. Wait 45 seconds after a crashed instance before restarting.
- Search appears to return zero results: first check the request status. **Pending** with an `slskd unavailable` banner means no search has been sent; connect Phonofetch to the existing slskd on `phonofetch_net`. **No results** means a search completed: the request message and Activity Log distinguish zero files returned from files rejected by strict quality. Open **Activity Log** (filter Category to `slskd` or `search`) for the exact query and API errors, or check structured container output with `docker logs --tail 200 phonofetch` / Portainer's container **Logs** view. The batch's Recent activity includes only events linked to that batch; global slskd connection failures appear in the full Activity Log.
- slskd accepted the query but Phonofetch shows **Failed** with an `Errored` search state: the slskd search failed asynchronously, not because of the quality filter. Compare the same query in slskd's own web UI and inspect `docker logs --tail 200 slskd` for Soulseek connection/search errors. Phonofetch retries these failures with a bounded backoff; it does not label them as zero search results.
- Search state `Completed, TimedOut` only milliseconds after `startedAt`: slskd 0.26.1 treats `searchTimeout` as milliseconds despite its REST DTO comment saying seconds. Older Phonofetch images sent `40` instead of `40000`. Rebuild/update Phonofetch and retry the search; a search with no peer responses should now run for about 40 seconds, not 40 milliseconds.
- **slskd API reachable but Soulseek disconnected/not logged in**: open slskd's own web UI and inspect `docker logs --tail 200 slskd`. Phonofetch leaves pending searches waiting until slskd reconnects; it does not claim that an offline search found no files.
- No strict MP3 320 results: unverified or VBR bitrate is deliberately excluded. Inspect exclusion reasons; explicitly choose FLAC or Any quality on a manual retry if you want different criteria.
- Folder preview changed/expired: inspect it again before queueing; contents and eligibility must match the confirmation snapshot.
- `uncertain` queue state: inspect slskd's transfer list for the exact peer/path. Phonofetch never blindly retries an ambiguous enqueue. If slskd no longer reports a file, Phonofetch does not infer that it completed.
- No NAS access or API errors: check Portainer container logs, network membership, raw ReadWrite API key, slskd service status, and the persistent Activity Log. Never paste keys or cookies into issue reports.
