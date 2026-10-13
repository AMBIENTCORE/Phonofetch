# Phonofetch

Phonofetch is a self-hosted, phone-friendly search and download manager for an **existing slskd instance**. Each line is a full-text Soulseek search; choose a file or inspect a folder from the results, then queue qualifying files through slskd. Transfers and the Activity Log continue on the server after you close the browser.

![Phonofetch folder search results with sample data](./docs/search-results-demo.png)

*Demo screenshot with synthetic peer and file names.*

## Search and download

- Results are grouped by peer and folder. Search hits have checkboxes immediately; select any file with a valid size across peers or folders and use **Download selected**. Audio, JPG, NFO, M3U and other extras are all selectable. This queues only those exact search hits, not a full album. **Inspect** is optional: it finds additional files the search did not return and provides checkboxes for the verified full folder. The leading folders are inspected automatically; expand **Other folders** or select **Inspect** to browse more. File and folder sizes are shown before downloading.
- Folder inspection shows up to at least 1000 files, including non-audio extras. A single selection is still limited to `MAX_FOLDER_FILES` files and `MAX_FOLDER_BYTES` bytes; choose a subset for larger folders or raise the limits in the NAS-only `.env`. Search-hit checkboxes remain available if inspection fails.
- File rows show type and peer-reported bitrate (for example, **MP3 · 320 kbps**). **? kbps** means the peer did not supply a reliable value; Phonofetch never infers it from the filename or size.
- Select files with checkboxes and **Download selected**; an inspected folder also offers **Download all** for its eligible files. A legacy track search downloads one selected file.
- Results start on **All**. After searching, filter by **FLAC**, **MP3 320** (peer-reported bitrate), or terms such as `-live`, `minbr:320` and `iscbr`. Add `iscbr` if confirmed constant bitrate is required. Unknown-bitrate files remain visible and selectable under All.
- Searches collect responses for about five seconds, then show matches with peer-reported upload speed and free-slot status. Manual downloads are not restricted by format or bitrate; filters only change which files are shown, not what can be selected. Automatic downloads still enforce the chosen audio quality. Use **Search longer** if a fast search misses later peers; it replaces that query's results.
- The Dashboard shows recent downloads and searches. Each search can contain multiple queries (one per line). **Downloads** groups active and finished transfers by peer and folder, with inline progress and expand/collapse controls. **Clear finished list** hides only finished entries; **Clear statistics** resets the totals separately. Neither deletes files or cancels an active transfer.
- **New Search** asks only for text. Queue one search hit or select files from an inspected folder. Automatic track or whole-album downloading is optional under **Automatic download**, with an explicit quality requirement.

## Install

You need Docker, an existing slskd 0.26.1 container on the external Docker network `phonofetch_net`, and a slskd API key with **ReadWrite** access. The supplied [compose.yaml](./compose.yaml) assumes slskd is reachable as `http://slskd:5030`, uses NAS port `7289`, and stores SQLite in `/volume2/docker/phonofetch`; adjust these paths if your setup differs. It does not modify slskd or Nicotine+.

In a directory containing the repository files, run:

```sh
docker network inspect phonofetch_net
mkdir -p /volume2/docker/phonofetch
# The application runs as UID 1000; grant this user write access to the data folder.
sudo chown 1000:1000 /volume2/docker/phonofetch
cp .env.example .env
# Edit .env: set SLSKD_API_KEY (raw secret, not "role=ReadWrite;"),
# PHONOFETCH_AUTH_USERNAME, PHONOFETCH_AUTH_PASSWORD and
# PHONOFETCH_SESSION_SECRET (at least 32 random characters).
chmod 600 .env
docker build -t phonofetch:local .
docker compose --env-file .env -f compose.yaml up -d
```

Open `http://NAS-IP:7289` on your local network. Keep `.env` **only on the NAS**, never in Git. Do not forward this port publicly; use a VPN or properly secured HTTPS proxy for remote access.

## Update

For the existing **CLI-managed** NAS installation at `/volume2/docker/Phonofetch`, install the [updater](./scripts/update-nas.sh) once after reviewing it:

```sh
curl -fL https://raw.githubusercontent.com/AMBIENTCORE/Phonofetch/main/scripts/update-nas.sh -o /volume2/docker/Phonofetch/update.sh
sh /volume2/docker/Phonofetch/update.sh --check
```

After pushing changes to GitHub, update with `sh /volume2/docker/Phonofetch/update.sh`. It builds the new image, tests non-root access, backs up SQLite, recreates **only** Phonofetch, and checks container health. If the updater itself changes, download and review its new version again. Backups and the database stay on the NAS; live Soulseek behavior depends on your slskd/peer connections.

## Private remote access

Protect `phonofetch.ambientcore.dev` with a Cloudflare Access **Self-hosted** application restricted to your account before adding a tunnel route. Run `cloudflared` as a **separate Compose project** on the NAS, connected to `phonofetch_net`. Set the tunnel's published application service to `http://phonofetch:3000`, with no path; do not change the existing `www` DNS record or forward port 7289.

After reviewing [tunnel.compose.yaml](./scripts/tunnel.compose.yaml) and pushing it to GitHub, copy it to the NAS:

```sh
curl -fL https://raw.githubusercontent.com/AMBIENTCORE/Phonofetch/main/scripts/tunnel.compose.yaml \
  -o /volume2/docker/Phonofetch/tunnel.compose.yaml
```

In the same NAS directory, create a NAS-only `tunnel.env` containing `TUNNEL_TOKEN=` followed by the token from the tunnel's **Add a replica** page. Never commit or send the token in chat. Then run on the NAS:

```sh
chmod 600 /volume2/docker/Phonofetch/tunnel.env
docker compose --env-file /volume2/docker/Phonofetch/tunnel.env \
  -f /volume2/docker/Phonofetch/tunnel.compose.yaml -p phonofetch-tunnel up -d
```

Set `TRUST_PROXY=true` in Phonofetch's separate NAS-only `.env` and recreate Phonofetch so HTTPS origin checks and secure cookies work. A successful *new-image* NAS update recreates it; if the updater reports an identical image and skips deployment, recreate only Phonofetch:

```sh
docker compose --env-file /volume2/docker/Phonofetch/.env \
  -f /volume2/docker/Phonofetch/compose.yaml -p phonofetch \
  up -d --no-deps --force-recreate phonofetch
```

Verify the tunnel is Healthy, Cloudflare Access prompts before Phonofetch's own login, and the app works from outside your LAN before linking or redirecting your homepage. Future Phonofetch updates do not recreate the separate tunnel connector.

To use `https://www.ambientcore.dev/phonofetch/` as an entry link after verification, create a Cloudflare **Single Redirect** matching only the `www` hostname and paths `/phonofetch` or `/phonofetch/`, with a 302 target of `https://phonofetch.ambientcore.dev/`. This keeps the homepage intact; the browser's final URL is the subdomain. Add the homepage link once in the separate homepage source. Subsequent Phonofetch image updates need no website deployment.

## iOS home screen and sharing

Open `https://phonofetch.ambientcore.dev/` in Safari, sign in privately, then use **Share → Add to Home Screen**. The app supplies a 180×180 `apple-touch-icon.png` derived from the same artwork as the homepage's Phonofetch preview. Its Open Graph image is hosted publicly at `https://www.ambientcore.dev/phonofetch-og.png`; Cloudflare Access can still prevent anonymous social-media crawlers from reading the private app's metadata.
