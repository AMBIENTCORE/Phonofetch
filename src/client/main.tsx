import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Activity, Batch, BatchDetail, Candidate, DownloadItem, DownloadsData, DownloadStats, FolderPreview, PreviewFile, Quality, RemoteFile, RequestType, SeedKind, SlskdConnectionState, TransferItem } from "../shared/types";
import { parentDirectory, parseLines } from "../server/matching";
import { readApiResponse } from "./api-response";
import { audioDetails, fileFormat } from "./audio-details";
import { autoFolderPreviews, folderKey, searchHitSelectionReason, searchHitsOutsidePreview } from "./folder-results";
import { matchesResult, parseResultFilter, type ResultPreset } from "./result-filter";
import { searchDraftQuery } from "./search-navigation";
import { canAppendManualSearch, canInspectFolder, canQueueSearchHits, remoteFileKey } from "../shared/search-selection";
import "./compact.css";

let csrf = "";
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}), ...init.headers }
  });
  return readApiResponse<T>(response);
}
const send = <T,>(path: string, body: object = {}): Promise<T> => api<T>(path, { method: "POST", body: JSON.stringify(body) });
async function createSearch(input: string, automaticType?: "track" | "album_folder", automaticQuality: Quality = "mp3_320"): Promise<string> {
  const type: RequestType = automaticType ?? "search";
  const seedKind: SeedKind = automaticType === "album_folder" ? "album_title" : "track_seed";
  const entries = parseLines(input, type, automaticType ? automaticQuality : "any").map(row => ({ ...row, seedKind }));
  if (input.length > 32768) throw new Error("Search input must be 32 KiB or less.");
  if (!entries.length) throw new Error("Enter at least one query.");
  if (entries.length > 100) throw new Error("A search can contain at most 100 queries.");
  const invalid = entries.findIndex(row => row.error || row.duplicate);
  if (invalid !== -1) throw new Error(`Query ${invalid + 1}: ${entries[invalid]!.error ??
    "Duplicate text. Remove or edit the repeated line."}`);
  const result = await send<{ id: string }>("/batches", {
    originalInput: input, defaultType: type, mode: automaticType ? "automatic" : "review", entries
  });
  return result.id;
}
const time = (value: string): string => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Lisbon", dateStyle: "short", timeStyle: "medium"
}).format(new Date(value));
const bytes = (value: number): string => value < 1024 ? `${value} B` :
  value < 1048576 ? `${(value / 1024).toFixed(1)} KiB` :
    value < 1073741824 ? `${(value / 1048576).toFixed(1)} MiB` : `${(value / 1073741824).toFixed(2)} GiB`;
const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;

function Collapsible({ children, initiallyOpen, className }: {
  children: React.ReactNode; initiallyOpen: boolean; className?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(initiallyOpen);
  return <details className={className} open={open}
    onToggle={event => setOpen(event.currentTarget.open)}>{children}</details>;
}

function useDisclosureGroup(version: string) {
  const root = useRef<HTMLDivElement>(null);
  const [allOpen, setAllOpen] = useState(false);
  const sync = () => {
    const details = Array.from(root.current?.querySelectorAll("details") ?? []);
    setAllOpen(details.length > 0 && details.every(item => item.open));
  };
  useEffect(() => {
    sync();
    const container = root.current;
    if (!container) return;
    const onToggle = () => queueMicrotask(sync);
    container.addEventListener("toggle", onToggle, true);
    return () => container.removeEventListener("toggle", onToggle, true);
  }, [version]);
  const toggle = () => {
    const details = Array.from(root.current?.querySelectorAll("details") ?? []);
    const open = details.some(item => !item.open);
    for (const item of details) item.open = open;
    setAllOpen(open);
  };
  return { root, allOpen, toggle };
}

function useMobileLayout(): boolean {
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 650px)").matches);
  useEffect(() => {
    const query = matchMedia("(max-width: 650px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}

function NavIcon({ name }: { name: "dashboard" | "search" | "downloads" | "activity" }): React.ReactElement {
  return <svg className="tab-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {name === "dashboard" ? <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></> :
      name === "search" ? <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></> :
        name === "downloads" ? <><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" /></> :
          <><path d="M5 4h14v16H5zM9 9h6M9 13h6M9 17h4" /></>}
  </svg>;
}

function App(): React.ReactElement {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [page, setPage] = useState(location.hash || "#/");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    api<{ authenticated: boolean; csrf?: string }>("/session").then(session => {
      csrf = session.csrf ?? "";
      setAuthenticated(session.authenticated);
    }).catch(err => setError(String(err)));
    const hash = () => setPage(location.hash || "#/");
    addEventListener("hashchange", hash);
    return () => removeEventListener("hashchange", hash);
  }, []);
  useEffect(() => {
    if (!page.includes("?request=")) scrollTo({ top: 0, behavior: "instant" });
  }, [page]);
  useEffect(() => {
    if (!authenticated) return;
    const interval = setInterval(() => setReload(n => n + 1),
      page.startsWith("#/search/") || page.startsWith("#/batch/") ? 1000 : 5000);
    return () => clearInterval(interval);
  }, [authenticated, page]);
  async function action(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true); setError("");
    try { await fn(); setReload(n => n + 1); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  if (authenticated === null) return <main className="center"><h1>Phonofetch</h1><p>Connecting…</p><p role="alert">{error}</p></main>;
  if (!authenticated) return <main className="login"><div className="login-card">
      <div className="brand"><img className="brand-symbol" src="/phonofetch-mark.svg" alt="" /> Phonofetch</div>
      <h1>Sign in</h1><p>Access your download queue and activity log.</p>
      <form onSubmit={event => { event.preventDefault(); void action(async () => {
        const session = await send<{ csrf: string }>("/login", { username, password });
        csrf = session.csrf; setPassword(""); setAuthenticated(true);
      }); }}>
        <label>Username<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></label>
        <button disabled={busy}>Sign in</button>
      </form><p role="alert">{error}</p>
    </div></main>;
  const searchPath = page.startsWith("#/search/") ? "#/search/" : page.startsWith("#/batch/") ? "#/batch/" : null;
  const batchId = searchPath ? page.slice(searchPath.length).split("?")[0] : null;
  const searchPage = page === "#/new" || page.startsWith("#/new?");
  return <div className="shell">
    <header><a className="brand" href="#/"><img className="brand-symbol" src="/phonofetch-mark.svg" alt="" /> Phonofetch</a><nav aria-label="Main navigation">
      <a className={page === "#/" ? "current" : ""} href="#/"><NavIcon name="dashboard" /><span>Dashboard</span></a>
      <a className={searchPage || searchPath ? "current" : ""} href="#/new">
        <NavIcon name="search" /><span>Search</span></a>
      <a className={page === "#/downloads" ? "current" : ""} href="#/downloads"><NavIcon name="downloads" /><span>Downloads</span></a>
      <a className={page === "#/activity" ? "current" : ""} href="#/activity">
        <NavIcon name="activity" /><span className="desktop-activity-label">Activity Log</span>
        <span className="mobile-activity-label">Activity</span></a>
    </nav><button className="quiet" onClick={() => void action(async () => { await send("/logout"); csrf = ""; setAuthenticated(false); })}>Sign out</button></header>
    <main><div className="global-error" role="alert">{error}</div>
      {searchPage ? <NewBatch key={page} initialInput={searchDraftQuery(page)} action={action} busy={busy} /> :
        page === "#/downloads" ? <DownloadsPage reload={reload} action={action} busy={busy} /> :
        page === "#/activity" ? <ActivityPage reload={reload} /> :
          batchId ? <BatchPage id={batchId} page={page} reload={reload} action={action} busy={busy} /> :
            <Dashboard reload={reload} action={action} busy={busy} />}
    </main>
  </div>;
}

function DownloadMetrics({ stats }: { stats?: DownloadStats }): React.ReactElement {
  const metrics = [
    { label: "Downloaded since reset", value: stats ? bytes(stats.completed_bytes) : "…" },
    { label: "Completed files", value: stats?.completed_count ?? "…" }
  ];
  return <div className="metrics download-metrics">{metrics.map(metric =>
    <div className="metric" key={metric.label}><strong>{metric.value}</strong><span>{metric.label}</span></div>)}</div>;
}

function DownloadSource({ item }: { item: DownloadItem }): React.ReactElement {
  return <small className="download-source"><a href={`#/search/${item.batch_id}?request=${item.request_id}`}>
    Search #{item.batch_number} · {item.query_text}</a> · {time(item.updated_at)}</small>;
}

function Dashboard({ reload, action, busy }: {
  reload: number; action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean;
}): React.ReactElement {
  const [data, setData] = useState<{ batches: Array<Batch & { total: number }>;
    downloads: DownloadsData; activity: Activity[]; slskd_status: SlskdConnectionState }>();
  const [error, setError] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchError, setSearchError] = useState("");
  useEffect(() => { api<typeof data>("/dashboard").then(setData).catch(err => setError(String(err))); }, [reload]);
  const recentDownloads = [...(data?.downloads.active ?? []), ...(data?.downloads.finished ?? [])].slice(0, 5);
  return <><div className="page-title"><div><h1>Dashboard</h1><p>Downloads and recent searches.</p></div></div>
    {data?.slskd_status === "unavailable" && <p role="status" className="service-warning">slskd unavailable. Searches stay pending until it reconnects. <a href="#/activity">View Activity Log</a></p>}
    <p role="alert">{error}</p>
    <form className="panel dashboard-search" onSubmit={event => {
      event.preventDefault();
      const query = searchText.trim();
      if (!query) { setSearchError("Enter a search term."); return; }
      if (busy) return;
      void action(async () => { location.hash = `#/search/${await createSearch(query)}`; });
    }}>
      <label htmlFor="dashboard-search">New search</label>
      <div className="dashboard-search-row">
        <input id="dashboard-search" type="search" maxLength={256} required
          value={searchText} onChange={event => { setSearchText(event.target.value); setSearchError(""); }}
          placeholder="Artist, album, or track" />
        <button type="submit" disabled={busy}>{busy ? "Searching…" : "Search"}</button>
      </div>
      <small>Starts searching and opens the results page.</small>
      {searchError && <small className="warn" role="alert">{searchError}</small>}
    </form>
    <DownloadMetrics stats={data?.downloads.stats} />
    <section className="panel"><div className="panel-heading"><h2>Downloads</h2><a href="#/downloads">View all →</a></div>
      {!recentDownloads.length ? <p className="empty">No downloads yet.</p> :
        recentDownloads.map(item => <div className="download-brief" key={item.id}>
          <span><strong>{basename(item.path)}</strong><DownloadSource item={item} /></span>
          <small>{item.status} · {bytes(item.transferred)} / {bytes(item.size)}</small>
        </div>)}</section>
    <div className="columns"><section className="panel history-panel"><div className="panel-heading"><h2>Recent searches</h2><a href="#/new">New search →</a></div>
      {!data?.batches.length ? <p className="empty">No searches yet.</p> :
        data.batches.map(batch => <a className="batch-link" key={batch.id} href={`#/search/${batch.id}`}>
          <span className="batch-copy"><strong title={batch.name}>{batch.name}</strong><small>{time(batch.created_at)}</small></span></a>)}</section>
      <section className="panel"><div className="panel-heading"><h2>Recent activity</h2><a href="#/activity">View all →</a></div>
        <ActivityList events={data?.activity ?? []} /></section></div></>;
}

function DownloadsPage({ reload, action, busy }: {
  reload: number; action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean;
}): React.ReactElement {
  const mobile = useMobileLayout();
  const [data, setData] = useState<DownloadsData>();
  const [error, setError] = useState("");
  const [activeLimit, setActiveLimit] = useState(50);
  const [finishedLimit, setFinishedLimit] = useState(50);
  const [mobileView, setMobileView] = useState<"active" | "finished" | null>(null);
  const selectedView = mobileView ?? (data?.active_total === 0 && data.finished_total > 0 ? "finished" : "active");
  const clearFinished = () => {
    if (confirm("Hide completed, failed and cancelled downloads from the list? Files and statistics are kept."))
      void action(async () => { await send("/downloads/clear"); setFinishedLimit(50); });
  };
  const clearStats = () => {
    if (confirm("Reset completed-file and downloaded-byte statistics? Download entries are kept."))
      void action(() => send("/downloads/stats/clear"));
  };
  useEffect(() => {
    api<DownloadsData>(`/downloads?activeLimit=${activeLimit}&finishedLimit=${finishedLimit}`)
      .then(setData).catch(err => setError(String(err)));
  }, [reload, activeLimit, finishedLimit]);
  return <><div className="page-title"><div><h1>Downloads</h1><p>slskd transfers; clearing this view never deletes downloaded files.</p></div></div>
    <p role="alert">{error}</p>
    <DownloadMetrics stats={data?.stats} />
    <div className="download-controls">
      <button className="secondary" disabled={busy || !data?.finished_total} onClick={clearFinished}>Clear finished list</button>
      <button className="secondary" disabled={busy} onClick={clearStats}>Clear statistics</button>
    </div>
    <div className="mobile-download-tabs" role="group" aria-label="Download status">
      <button type="button" className={selectedView === "active" ? "current" : ""} aria-pressed={selectedView === "active"}
        onClick={() => setMobileView("active")}>Active <span>{data?.active_total ?? 0}</span></button>
      <button type="button" className={selectedView === "finished" ? "current" : ""} aria-pressed={selectedView === "finished"}
        onClick={() => setMobileView("finished")}>Finished <span>{data?.finished_total ?? 0}</span></button>
    </div>
    <section className={`panel download-section${selectedView === "active" ? " mobile-selected" : ""}`}>
      <div className="panel-heading"><h2>Ongoing / needs attention</h2>
      <small>{data?.active_total ?? 0} transfers{data?.stats.uncertain_count ? ` · ${data.stats.uncertain_count} uncertain` : ""}</small></div>
      {!data?.active.length ? <p className="empty">No ongoing downloads.</p> :
        <DownloadTree items={data.active} action={action} busy={busy} expandFolders />}
      {data && data.active_total > data.active.length && <button className="secondary" onClick={() => setActiveLimit(limit => limit + 50)}>Load more ongoing</button>}
    </section>
    <section className={`panel download-section${selectedView === "finished" ? " mobile-selected" : ""}`}>
      <div className="panel-heading"><h2>Finished</h2>
      <small>{data?.finished_total ?? 0} in list</small></div>
      {!data?.finished.length ? <p className="empty">No finished downloads in the list.</p> :
        <DownloadTree items={data.finished} action={action} busy={busy} expandFolders={mobile && data.finished.length <= 10} />}
      {data && data.finished_total > data.finished.length && <button className="secondary" onClick={() => setFinishedLimit(limit => limit + 50)}>Load more finished</button>}
    </section>
    <details className="mobile-download-options"><summary>Manage downloads</summary>
      <button className="secondary" disabled={busy || !data?.finished_total} onClick={clearFinished}>Clear finished list</button>
      <button className="secondary" disabled={busy} onClick={clearStats}>Clear statistics</button>
    </details></>;
}

function NewBatch({ action, busy, initialInput }: {
  action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean; initialInput: string;
}): React.ReactElement {
  const [input, setInput] = useState(initialInput);
  const [automaticQuality, setAutomaticQuality] = useState<Quality>("mp3_320");
  const [automatic, setAutomatic] = useState(false);
  const [automaticType, setAutomaticType] = useState<"track" | "album_folder">("track");
  return <><div className="page-title"><div><h1>Search</h1><p>One query per line · up to 100 queries</p></div></div>
    <form className="panel form-panel" onSubmit={event => { event.preventDefault(); void action(async () => {
      location.hash = `#/search/${await createSearch(input, automatic ? automaticType : undefined, automaticQuality)}`;
    }); }}>
      <label>Searches<textarea rows={4} maxLength={32768} value={input} onChange={event => setInput(event.target.value)} /></label>
      <details className="search-advanced"><summary>Automatic download (optional)</summary>
        <label className="check"><input type="checkbox" checked={automatic} onChange={event => setAutomatic(event.target.checked)} />
          Queue high-confidence matches without review</label>
        {automatic && <label>Download<select value={automaticType}
          onChange={event => setAutomaticType(event.target.value as "track" | "album_folder")}>
          <option value="track">One track</option><option value="album_folder">Matched album folder</option>
        </select></label>}
        {automatic && <label>Required quality<select value={automaticQuality}
          onChange={event => setAutomaticQuality(event.target.value as Quality)}>
          <option value="mp3_320">MP3 320 (strict)</option><option value="flac">FLAC</option>
          <option value="any">Any quality (explicit)</option>
        </select></label>}
      </details>
      <button disabled={busy}>Start search</button>
    </form></>;
}

function BatchPage({ id, page, reload, action, busy }: { id: string; page: string; reload: number; action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean }): React.ReactElement {
  const [data, setData] = useState<BatchDetail>();
  const [error, setError] = useState("");
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [inspecting, setInspecting] = useState<Set<string>>(new Set());
  const attempted = useRef(new Set<string>());
  const prefetching = useRef<string | null>(null);
  useEffect(() => { api<BatchDetail>(`/batches/${encodeURIComponent(id)}`).then(setData).catch(err => setError(String(err))); }, [id, reload]);
  useEffect(() => { attempted.current.clear(); setPreviewErrors({}); setInspecting(new Set()); }, [id]);
  const candidateSignature = data?.batch.id === id ? data.requests.map(request =>
    `${request.id}:${request.status}:${request.candidates.map(candidate => candidate.id).join(",")}`).join("|") : "";
  useEffect(() => {
    if (!data || data.batch.id !== id || prefetching.current === id) return;
    const next = autoFolderPreviews(data.requests, attempted.current);
    if (!next.length) return;
    prefetching.current = id;
    let active = true;
    void (async () => {
      for (const { key, requestId, candidateId } of next) {
        if (!active) break;
        attempted.current.add(key);
        setInspecting(current => new Set(current).add(key));
        try {
          const preview = await send<FolderPreview>(`/requests/${requestId}/preview`,
            { candidateId, recursive: false });
          if (active) setData(current => current?.batch.id === id ? { ...current, requests: current.requests.map(request =>
            request.id === requestId ? { ...request, previews: [preview, ...request.previews] } : request) } : current);
        } catch (cause) {
          if (active) setPreviewErrors(current => ({ ...current, [key]: cause instanceof Error ? cause.message : String(cause) }));
        } finally {
          setInspecting(current => {
            const remaining = new Set(current); remaining.delete(key); return remaining;
          });
        }
      }
    })().finally(() => { if (prefetching.current === id) prefetching.current = null; });
    return () => { active = false; };
  }, [id, candidateSignature]);
  useEffect(() => {
    const related = new URLSearchParams(location.hash.split("?")[1] ?? "").get("request");
    if (related && data?.requests.some(item => item.id === related))
      document.getElementById(`request-${related}`)?.scrollIntoView({ block: "start" });
  }, [data, page]);
  return <><div className="page-title"><div><a className="back" href="#/">← Dashboard</a><h1>{data?.batch.name ?? "Search"}</h1>
    <p>{data ? `${data.requests.length} quer${data.requests.length === 1 ? "y" : "ies"} · ${time(data.batch.created_at)}` : "Loading…"}</p></div></div>
    {data?.slskd_status === "unavailable" && <p role="status" className="service-warning">slskd unavailable. These requests cannot search until it reconnects. <a href="#/activity">View Activity Log</a></p>}
    <p role="alert">{error}</p>{data?.requests.map(request => <RequestCard key={request.id} request={request}
      singleQuery={data.requests.length === 1} action={action}
      busy={busy} inspecting={inspecting} previewErrors={previewErrors} clearPreviewError={key => setPreviewErrors(current => {
        const next = { ...current }; delete next[key]; return next;
      })} />)}
    {data && <details className="panel search-activity"><summary>Activity</summary><ActivityList events={data.activity} />
      <a href="#/activity">Full log →</a></details>}</>;
}

type RequestDetail = BatchDetail["requests"][number];
function RequestCard({ request, singleQuery, action, busy, inspecting, previewErrors, clearPreviewError }: {
  request: RequestDetail; singleQuery: boolean; action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean;
  inspecting: ReadonlySet<string>; previewErrors: Record<string, string>; clearPreviewError: (key: string) => void;
}): React.ReactElement {
  const [recursive, setRecursive] = useState(false);
  const [retryQuality, setRetryQuality] = useState<Quality>(request.quality);
  const [preset, setPreset] = useState<ResultPreset>("all");
  const [filterText, setFilterText] = useState("");
  const [selectedHits, setSelectedHits] = useState<Set<string>>(new Set());
  const [selectedPreviews, setSelectedPreviews] = useState<Map<string, Set<string>>>(new Map());
  const queuedSignature = request.transfers.map(transfer => remoteFileKey(transfer)).join("|");
  useEffect(() => {
    const queued = new Set(request.transfers.map(remoteFileKey));
    setSelectedHits(current => {
      const remaining = new Set([...current].filter(id => {
        const hit = request.candidates.find(candidate => candidate.id === id);
        return hit && !queued.has(remoteFileKey(hit));
      }));
      return remaining.size === current.size ? current : remaining;
    });
    setSelectedPreviews(current => {
      const remaining = new Map([...current].map(([id, paths]) => {
        const preview = request.previews.find(item => item.id === id);
        return [id, new Set([...paths].filter(path => !preview ||
          !queued.has(remoteFileKey({ username: preview.username, path }))))] as const;
      }));
      return [...current].every(([id, paths]) => remaining.get(id)?.size === paths.size) ? current : remaining;
    });
  }, [request.id, queuedSignature]);
  const mobile = useMobileLayout();
  const parsedFilter = parseResultFilter(filterText);
  const matches = (file: Pick<RemoteFile, "path" | "size" | "metadata">): boolean =>
    parsedFilter.value !== null && matchesResult(file, preset, parsedFilter.value);
  const oldQualityLimit = request.mode === "automatic" && request.quality !== "any" &&
    ["review", "no_results"].includes(request.status) &&
    !request.transfers.length;
  const grouped = new Map<string, typeof request.candidates>();
  for (const candidate of request.candidates) {
    const key = folderKey(request.id, candidate.username, candidate.directory, recursive);
    const hits = grouped.get(key) ?? [];
    hits.push(candidate);
    grouped.set(key, hits);
  }
  const matchingFolders = new Map<string, Array<[string, Candidate[]]>>();
  const otherFolders = new Map<string, Array<[string, Candidate[]]>>();
  for (const entry of grouped) {
    const [key, hits] = entry;
    const preview = request.previews.find(item =>
      folderKey(request.id, item.username, item.directory, item.recursive) === key);
    if (!hits.some(matches) && !preview?.files.some(matches)) continue;
    const groups = preset === "all" || request.type === "search" ||
      (preview ? preview.files.some(file => matches(file) && file.eligible) : hits.some(hit => matches(hit) && hit.eligible))
      ? matchingFolders : otherFolders;
    const username = hits[0]!.username;
    const folders = groups.get(username) ?? [];
    folders.push(entry);
    groups.set(username, folders);
  }
  const matchingCount = [...matchingFolders.values()].reduce((count, folders) => count + folders.length, 0);
  const otherCount = [...otherFolders.values()].reduce((count, folders) => count + folders.length, 0);
  const visibleCandidates = request.candidates.filter(matches);
  const eligibleCount = visibleCandidates.filter(candidate => candidate.eligible).length;
  const fileDisclosures = useDisclosureGroup(`${request.id}:${request.type}:files:${visibleCandidates.length}:${preset}:${filterText}`);
  const folderDisclosures = useDisclosureGroup(
    `${request.id}:${request.type}:folders:${request.candidates.length}:${request.previews.length}:${recursive}:${preset}:${filterText}`);
  const canInspect = canInspectFolder(request) && (!request.jobs.length || canAppendManualSearch(request));
  const canSelectHits = canQueueSearchHits(request) &&
    (canAppendManualSearch(request) || !request.transfers.length) && !busy;
  const chosenHits = request.candidates.filter(candidate =>
    selectedHits.has(candidate.id) && searchHitSelectionReason(request, candidate) === null);
  const chooseHit = (id: string) => {
    setSelectedHits(current => {
      const next = new Set(request.type === "track" ? [] : current);
      if (!current.has(id)) next.add(id);
      else if (request.type !== "track") next.delete(id);
      return next;
    });
  };
  const choosePreviewFiles = (previewId: string, paths: Set<string>) =>
    setSelectedPreviews(current => new Map(current).set(previewId, paths));
  const downloadHits = () => {
    if (!canSelectHits || !chosenHits.length) return;
    const count = chosenHits.length;
    const total = chosenHits.reduce((sum, candidate) => sum + candidate.size, 0);
    if (confirm(`Download ${count} selected search hit${count === 1 ? "" : "s"} (${bytes(total)})?`))
      void action(() => request.type === "track" ?
        send(`/requests/${request.id}/select`, { candidateId: chosenHits[0]!.id }) :
        send(`/requests/${request.id}/select-hits`, { candidateIds: chosenHits.map(candidate => candidate.id) }));
  };
  return <section className={`panel request${chosenHits.length && canSelectHits ? " has-selection" : ""}`}
    id={`request-${request.id}`}><div className="panel-heading">
    <div>{!singleQuery && <h2>{request.query_text}</h2>}
      <small>{request.type === "track" ? "Track" : request.type === "search" ? "Files & folders" : "Folder"}
        {request.type !== "search" && ` · ${{ mp3_320: "MP3 320", flac: "FLAC", any: "Any quality" }[request.quality]}`}
        {request.status !== "review" && !(oldQualityLimit && request.status === "no_results") &&
        <span className={`status ${request.status}`}>{request.status.replace("_", " ")}</span>}</small></div></div>
    {request.error && !(oldQualityLimit && request.error === "No files met the selected quality requirements") &&
      <p className="warn" role="alert">{request.error}</p>}
    {request.status === "searching" && <p>{request.search_stop_requested_at ? "Preparing results…" :
      `Searching… ${request.search_file_count} files · ${request.search_response_count} responses`}</p>}
    {oldQualityLimit && <p className="service-warning">This older search restricted quality before displaying results.
      <button className="secondary" disabled={busy} onClick={() => void action(() =>
        send(`/requests/${request.id}/show-all`))}>Show all results without searching again</button></p>}
    {request.status === "no_results" && !request.candidates.length && !request.error && <p>No files returned by Soulseek.</p>}
    {request.candidates.length > 0 && <div className="result-filters">
      <div role="group" aria-label="Filter results" className="filter-presets">
        {([["all", "All"], ["flac", "FLAC"], ["mp3_320", "MP3 320"]] as const).map(([value, label]) =>
          <button key={value} className={preset === value ? "current" : "secondary"} aria-pressed={preset === value}
            onClick={() => setPreset(value)}>{label}</button>)}
      </div>
      <label>Filter files<input value={filterText} onChange={event => setFilterText(event.target.value)}
        placeholder="words -word minbr:320 iscbr" /></label>
      {parsedFilter.error && <small className="warn" role="alert">{parsedFilter.error}</small>}
      {preset === "mp3_320" && <small>Peer-reported 320 kbps MP3. Add iscbr to require confirmed CBR.</small>}
    </div>}
    {chosenHits.length > 0 && canSelectHits && <div className="search-hit-actions">
      <span>{chosenHits.length} selected · {bytes(chosenHits.reduce((sum, candidate) => sum + candidate.size, 0))}
        {chosenHits.some(candidate => !matches(candidate)) && " · includes filtered-out files"}</span>
      <button className="secondary" onClick={() => setSelectedHits(new Set())}>Clear</button>
      <button onClick={downloadHits}>Download selected</button>
    </div>}
    {["failed", "no_results", "review", "cancelled"].includes(request.status) && request.transfers.length === 0 &&
      <details className="retry-options"><summary>{request.status === "review" ? "Search options" : "Retry search"}</summary>
      <div className="retry">{request.type !== "search" && <label>Old quality rule<select value={retryQuality} onChange={event => setRetryQuality(event.target.value as Quality)}>
        <option value="mp3_320">MP3 320</option><option value="flac">FLAC</option><option value="any">Any quality</option></select></label>
        }<button className="secondary" disabled={busy} onClick={() => void action(() => send(`/requests/${request.id}/retry`,
          { quality: request.type === "search" ? "any" : retryQuality }))}>Search again (fast)</button>
        <button className="secondary" disabled={busy} onClick={() => {
          if (!request.candidates.length || confirm("A longer search replaces these results. Continue?"))
            void action(() => send(`/requests/${request.id}/retry`,
              { quality: request.type === "search" ? "any" : retryQuality, longer: true }));
        }}>Search longer</button></div></details>}
    {request.type === "track" && request.candidates.length > 0 && <div>
      <div className="result-section-heading"><h3>Files ({visibleCandidates.length})</h3>
        {visibleCandidates.length > 0 && <button className="secondary" type="button" onClick={fileDisclosures.toggle}>
          {fileDisclosures.allOpen ? "Collapse all" : "Expand all"}</button>}</div>
      <div ref={fileDisclosures.root}>
      {eligibleCount > 0 ? <TrackResultsTable candidates={visibleCandidates.filter(candidate => candidate.eligible)}
        canSelect={canSelectHits} selected={selectedHits} onSelect={chooseHit} /> :
        visibleCandidates.length > 0 && <p>No selectable files in this filter.</p>}
      {eligibleCount < visibleCandidates.length && <details className="excluded-results">
        <summary>Unavailable files ({visibleCandidates.length - eligibleCount})</summary>
        <TrackResultsTable candidates={visibleCandidates.filter(candidate => !candidate.eligible)}
          canSelect={false} selected={selectedHits} onSelect={chooseHit} />
      </details>}
      </div></div>}
    {(request.type === "album_folder" || request.type === "search") && request.candidates.length > 0 && <div className="request-folder-results">
      <div className="result-section-heading"><h3>Folders ({matchingCount + otherCount})</h3>
        {matchingCount + otherCount > 0 && <button className="secondary" type="button" onClick={folderDisclosures.toggle}>
          {folderDisclosures.allOpen ? "Collapse all" : "Expand all"}</button>}</div>
      <label className="check"><input type="checkbox" checked={recursive} onChange={event => setRecursive(event.target.checked)} /> Include subfolders</label>
      <div ref={folderDisclosures.root}>
      {matchingCount > 0 ? <FolderCandidateList request={request} peers={matchingFolders} recursive={recursive} mobile={mobile}
        canInspect={canInspect} busy={busy} inspecting={inspecting} previewErrors={previewErrors}
        clearPreviewError={clearPreviewError} action={action} selectedHits={selectedHits} onSelectHit={chooseHit}
        previewSelections={selectedPreviews} onPreviewSelectionChange={choosePreviewFiles}
        matches={matches} filterKey={`${preset}:${filterText}`} /> :
        <p>{parsedFilter.error ? "Fix the filter above to see results." : "No folders match this filter. Select All to see every result."}</p>}
      {otherCount > 0 && <details className="excluded-results">
        <summary>Other folders ({otherCount})</summary>
        <FolderCandidateList request={request} peers={otherFolders} recursive={recursive} mobile={mobile}
          canInspect={canInspect} busy={busy} inspecting={inspecting} previewErrors={previewErrors}
          clearPreviewError={clearPreviewError} action={action} selectedHits={selectedHits} onSelectHit={chooseHit}
          previewSelections={selectedPreviews} onPreviewSelectionChange={choosePreviewFiles}
          matches={matches} filterKey={`${preset}:${filterText}`} />
      </details>}
      </div>
    </div>}
    {request.jobs.map(job => <div key={job.id} className="job"><h3>Folder job · {job.status}</h3>
      <p>{job.username} · {job.directory} · selected {bytes(job.estimated_bytes)}</p>
      <p>{job.transfers.filter(t => t.status === "completed").length} completed / {job.selected_count} selected
        {job.excluded_count + job.unselected_count > 0 && <span className="warn"> · Partial folder: {job.excluded_count} quality-excluded, {job.unselected_count} unselected</span>}</p>
      <progress max={Math.max(1, job.transfers.reduce((sum, t) => sum + t.size, 0))}
        value={job.transfers.reduce((sum, t) => sum + t.transferred, 0)} /></div>)}
  </section>;
}

type FolderListProps = {
  request: RequestDetail; peers: Map<string, Array<[string, Candidate[]]>>; recursive: boolean; mobile: boolean;
  canInspect: boolean; busy: boolean; inspecting: ReadonlySet<string>;
  previewErrors: Record<string, string>; clearPreviewError: (key: string) => void;
  action: (fn: () => Promise<unknown>) => Promise<void>;
  selectedHits: ReadonlySet<string>; onSelectHit: (candidateId: string) => void;
  previewSelections: ReadonlyMap<string, ReadonlySet<string>>;
  onPreviewSelectionChange: (previewId: string, paths: Set<string>) => void;
  matches: (file: Pick<RemoteFile, "path" | "size" | "metadata">) => boolean; filterKey: string;
};

function FolderCandidateList({ peers, mobile, ...body }: FolderListProps): React.ReactElement {
  const sorted = [...peers].sort((a, b) => peerOrder(a[1][0]?.[1][0], b[1][0]?.[1][0]));
  if (mobile) return <div className="mobile-folder-list">{sorted.flatMap(([, folders]) =>
    folders.map(([key, hits]) => {
      const candidate = hits[0]!;
      const preview = body.request.previews.find(item =>
        folderKey(body.request.id, item.username, item.directory, item.recursive) === key);
      const files = preview?.files ?? hits;
      return <details className="mobile-folder-card" key={key} onToggle={event => {
        if (event.currentTarget.open && event.currentTarget === event.target)
          event.currentTarget.scrollIntoView({ block: "start" });
      }}>
        <summary>
          <span className="mobile-folder-back">← All folders</span>
          <strong title={candidate.directory}>{basename(candidate.directory) || "Shared files"}</strong>
          <span className="mobile-folder-peer">{candidate.username} · {peerDetails(candidate)}</span>
          <span className="mobile-folder-meta">{files.length} file{files.length === 1 ? "" : "s"} ·
            {" "}{bytes(files.reduce((sum, file) => sum + file.size, 0))} ·
            {" "}{Math.round(candidate.score * 100)}% match</span>
        </summary>
        <div className="mobile-folder-detail">
          {candidate.directory && <details className="mobile-folder-path"><summary>Full path</summary>
            <small>{candidate.directory}</small></details>}
          <FolderCandidateBody {...body} candidate={candidate} hits={hits} folderId={key} />
        </div>
      </details>;
    }))}</div>;
  return <>{sorted.flatMap(([username, folders]) => folders.map(([key, hits]) => {
    const candidate = hits[0]!;
    return <Collapsible className="peer-group folder-result" initiallyOpen key={key}>
      <summary><span className="folder-result-peer">{username}{folders.length > 1 ? ` (${folders.length})` : ""} ·
        {" "}{peerDetails(candidate)} ·{" "}</span>
        <strong className="folder-result-path">{candidate.directory || "Shared files"}</strong>
        <span className="folder-result-match">{" "}[{Math.round(candidate.score * 100)}%]</span></summary>
      <div className="folder-candidate">
        <FolderCandidateBody {...body} candidate={candidate} hits={hits} folderId={key} />
      </div>
    </Collapsible>;
  }))}</>;
}

function FolderCandidateBody({ request, candidate, hits, folderId, recursive, canInspect, busy, inspecting,
  previewErrors, clearPreviewError, action, selectedHits, onSelectHit, previewSelections,
  onPreviewSelectionChange, matches, filterKey }: Omit<FolderListProps, "peers" | "mobile"> & {
  candidate: Candidate; hits: Candidate[]; folderId: string;
}): React.ReactElement {
  const preview = request.previews.find(item =>
    folderKey(request.id, item.username, item.directory, item.recursive) === folderId);
  const queuedKeys = new Set(request.transfers.map(remoteFileKey));
  const visibleHits = hits.filter(matches);
  const visibleFiles = preview?.files.filter(matches) ?? [];
  const previewExpired = preview && Date.now() - Date.parse(preview.created_at) > 10 * 60 * 1000;
  const shownHits = !preview || !visibleFiles.length || previewExpired || previewErrors[folderId] ?
    visibleHits : searchHitsOutsidePreview(visibleHits, preview, selectedHits);
  const hitBytes = shownHits.reduce((total, file) => total + file.size, 0);
  return <><div className="candidate">
        <span><strong>{candidate.directory || "Shared files"}</strong><small title={candidate.explanation}>Match {Math.round(candidate.score * 100)}%</small></span>
        {canInspect && candidate.directory && <button className="quiet" disabled={busy || inspecting.has(folderId)} onClick={() => void action(async () => {
          await send<FolderPreview>(`/requests/${request.id}/preview`, { candidateId: candidate.id, recursive });
          clearPreviewError(folderId);
        })}>{inspecting.has(folderId) ? "Inspecting…" : preview ? "Refresh" : "Inspect"}</button>}
      </div>
      {preview && visibleFiles.length > 0 && <Preview key={preview.id} preview={preview}
        visibleFiles={visibleFiles} filterActive={filterKey !== "all:"} busy={busy} canQueue={canInspect}
        queuedKeys={queuedKeys}
        selected={previewSelections.get(preview.id) ?? new Set<string>()}
        onSelectionChange={paths => onPreviewSelectionChange(preview.id, paths)}
        confirmPreview={paths => {
          const count = paths?.length ?? visibleFiles.filter(file => file.eligible).length;
          const available = preview.files.filter(file => file.eligible && !queuedKeys.has(remoteFileKey(file))).length;
          if (confirm(`Queue ${count} files from ${preview.username}\\${preview.directory}?${preview.excluded_count || count < available ?
            ` Partial folder: ${preview.excluded_count} unavailable and ${available - count} unselected.` : ""}`))
            void action(() => send(`/requests/${request.id}/queue-folder`, { previewId: preview.id, selectedPaths: paths }));
        }} />}
      {shownHits.length > 0 &&
        <div className="folder-search-hits">
          <small>Search hits{preview ? " (available without inspection)" : " only"} · {shownHits.length} file{shownHits.length === 1 ? "" : "s"} · {bytes(hitBytes)}</small>
          {shownHits.map(file => {
            const selectionReason = searchHitSelectionReason(request, file);
            return <div className="folder-hit" key={file.id}>
              <label className="folder-tree-select folder-hit-name">
                <input type="checkbox" aria-label={`Select ${basename(file.path)} from ${file.username}`}
                  checked={selectionReason === null && selectedHits.has(file.id)} disabled={selectionReason !== null}
                  onChange={() => onSelectHit(file.id)} />
                <span><strong>{basename(file.path)}</strong>
                  {selectionReason && <small className="warn" title={selectionReason}>{selectionReason}</small>}</span>
              </label>
            <span className="folder-file-format" title={audioDetails(file.metadata, file.path)}>
              {fileFormat(file.metadata, file.path)}</span><span className="folder-file-size">{bytes(file.size)}</span></div>;
          })}
        </div>}
      {previewErrors[folderId] && <small role="alert" className="warn">Inspection failed: {previewErrors[folderId]}.
        {shownHits.some(file => searchHitSelectionReason(request, file) === null) &&
          " Search hits above remain selectable."} Select Inspect to retry.</small>}
    </>;
}

function peerOrder(a?: Candidate, b?: Candidate): number {
  return Number(b?.free_slot === true) - Number(a?.free_slot === true) ||
    (b?.upload_speed ?? -1) - (a?.upload_speed ?? -1) || (b?.score ?? 0) - (a?.score ?? 0);
}

function peerDetails(candidate?: Candidate): string {
  if (!candidate) return "Speed unknown";
  const speed = candidate.upload_speed == null ? "Speed unknown" : `${bytes(candidate.upload_speed)}/s`;
  const slot = candidate.free_slot == null ? "Slot unknown" : candidate.free_slot ? "Free" : "Busy";
  return `${speed} · ${slot}${candidate.queue_length ? ` · Q${candidate.queue_length}` : ""}`;
}

function TrackResultsTable({ candidates, canSelect, selected, onSelect }: {
  candidates: Candidate[]; canSelect: boolean; selected: ReadonlySet<string>; onSelect: (candidateId: string) => void;
}): React.ReactElement {
  const peers = new Map<string, Map<string, Candidate[]>>();
  for (const candidate of [...candidates].sort(peerOrder)) {
    let directories = peers.get(candidate.username);
    if (!directories) { directories = new Map(); peers.set(candidate.username, directories); }
    const files = directories.get(candidate.directory) ?? [];
    files.push(candidate);
    directories.set(candidate.directory, files);
  }
  return <div className="search-results">{[...peers].map(([username, directories]) =>
    <Collapsible className="peer-group" initiallyOpen key={username}><summary>{username} · {peerDetails([...directories.values()][0]?.[0])}</summary>
      {[...directories].map(([directory, files]) => <Collapsible className="directory-group" initiallyOpen key={directory}>
        <summary>{directory || "Shared files"} · {files.length} · {bytes(files.reduce((sum, file) => sum + file.size, 0))}</summary>
        <div className="search-table-wrap"><table className="search-table"><thead><tr>
          <th>File</th><th>Size</th><th>Type / bitrate</th><th>Match</th>
        </tr></thead><tbody>{files.map(candidate => <tr key={candidate.id}>
          <td title={candidate.path}><label className="folder-tree-select">
            <input type="checkbox" aria-label={`Select ${basename(candidate.path)} from ${candidate.username}`}
              checked={selected.has(candidate.id)} disabled={!canSelect || !candidate.eligible}
              onChange={() => onSelect(candidate.id)} />
            <span><strong>{basename(candidate.path)}</strong></span>
          </label></td>
          <td className="file-size">{bytes(candidate.size)}</td>
          <td title={audioDetails(candidate.metadata, candidate.path)}>{fileFormat(candidate.metadata, candidate.path)}
            {!candidate.eligible && <small className="warn">{candidate.reason}</small>}</td>
          <td title={candidate.explanation}>{Math.round(candidate.score * 100)}%</td>
        </tr>)}</tbody></table></div>
      </Collapsible>)}
    </Collapsible>)}</div>;
}

function ContextMenu({ x, y, label, onDownload, onClose }: {
  x: number; y: number; label: string; onDownload: () => void; onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [onClose]);
  return <div ref={ref} className="context-menu" role="menu"
    style={{ left: Math.max(8, Math.min(x, window.innerWidth - 190)), top: Math.max(8, Math.min(y, window.innerHeight - 60)) }}>
    <button role="menuitem" onClick={event => { event.stopPropagation(); onDownload(); onClose(); }}>{label}</button>
  </div>;
}

interface FolderTreeNode {
  name: string;
  directories: Map<string, FolderTreeNode>;
  files: PreviewFile[];
}

function FolderTree({ preview, files, selected, onSelect, onFileMenu, canQueue, queuedKeys }: {
  preview: FolderPreview; files: PreviewFile[]; selected: ReadonlySet<string>; onSelect: (path: string) => void;
  onFileMenu: (event: React.MouseEvent | React.KeyboardEvent, file: PreviewFile) => void; canQueue: boolean;
  queuedKeys: ReadonlySet<string>;
}): React.ReactElement {
  const root: FolderTreeNode = { name: preview.directory, directories: new Map(), files: [] };
  const prefix = `${preview.directory.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  for (const file of files) {
    const normalized = file.path.replace(/\\/g, "/");
    const parts = normalized.startsWith(prefix) ? normalized.slice(prefix.length).split("/") : [basename(file.path)];
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.directories.get(part);
      if (!child) {
        child = { name: part, directories: new Map(), files: [] };
        node.directories.set(part, child);
      }
      node = child;
    }
    node.files.push(file);
  }
  function totals(node: FolderTreeNode): { count: number; size: number } {
    return [...node.directories.values()].reduce((result, child) => {
      const nested = totals(child);
      return { count: result.count + nested.count, size: result.size + nested.size };
    }, { count: node.files.length, size: node.files.reduce((sum, file) => sum + file.size, 0) });
  }
  function render(node: FolderTreeNode): React.ReactElement {
    return <ul className="folder-tree">
      {[...node.directories.values()].sort((a, b) => a.name.localeCompare(b.name)).map(child => {
        const total = totals(child);
        return <li key={child.name}><Collapsible initiallyOpen><summary>{child.name}/ <small>{total.count} file{total.count === 1 ? "" : "s"} · {bytes(total.size)}</small></summary>{render(child)}</Collapsible></li>;
      })}
      {node.files.map(file => {
        const details = audioDetails(file.metadata, file.path);
        const queued = queuedKeys.has(remoteFileKey(file));
        return <li className="folder-tree-file" key={file.path}
        tabIndex={canQueue && file.eligible && !queued ? 0 : undefined}
        onContextMenu={event => onFileMenu(event, file)}
        onKeyDown={event => { if (event.key === "F10" && event.shiftKey) onFileMenu(event, file); }}>
        <label className="folder-tree-select"><input type="checkbox" checked={!queued && selected.has(file.path)}
          aria-label={`Select ${basename(file.path)}`} disabled={!canQueue || !file.eligible || queued}
          onChange={() => onSelect(file.path)} />
          <span><strong>{basename(file.path)}</strong>{queued ?
            <small className="muted">Already queued</small> : !file.eligible && <small className="warn">{file.reason}</small>}</span>
        </label><span className="folder-file-format" title={details}>{fileFormat(file.metadata, file.path)}</span>
        <span className="folder-file-size">{bytes(file.size)}</span>
      </li>;
      })}
    </ul>;
  }
  return <div className="folder-tree-scroll">{render(root)}</div>;
}

function Preview({ preview, visibleFiles, filterActive, busy, canQueue, queuedKeys, selected, onSelectionChange, confirmPreview }: {
  preview: FolderPreview; visibleFiles: PreviewFile[]; filterActive: boolean;
  queuedKeys: ReadonlySet<string>;
  selected: ReadonlySet<string>; onSelectionChange: (paths: Set<string>) => void;
  busy: boolean; canQueue: boolean; confirmPreview: (paths?: string[]) => void;
}): React.ReactElement {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const expired = Date.now() - Date.parse(preview.created_at) > 10 * 60 * 1000;
  const canDownload = canQueue && !busy && !expired;
  const eligible = visibleFiles.filter(file => file.eligible);
  const availableVisible = eligible.filter(file => !queuedKeys.has(remoteFileKey(file)));
  const allEligible = preview.files.filter(file => file.eligible && !queuedKeys.has(remoteFileKey(file)));
  const excluded = visibleFiles.filter(file => !file.eligible);
  const selectedFiles = allEligible.filter(file => selected.has(file.path));
  const visiblePaths = new Set(visibleFiles.map(file => file.path));
  const hiddenSelected = selectedFiles.filter(file => !visiblePaths.has(file.path)).length;
  const selectedBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0);
  const chooseFile = (path: string) => {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path); else next.add(path);
    onSelectionChange(next);
  };
  const openFileMenu = (event: React.MouseEvent | React.KeyboardEvent, file: PreviewFile) => {
    if (!file.eligible || !canDownload || queuedKeys.has(remoteFileKey(file))) return;
    event.preventDefault();
    if (!selected.has(file.path)) onSelectionChange(new Set([file.path]));
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: "clientX" in event ? event.clientX : rect.left + 12,
      y: "clientY" in event ? event.clientY : rect.bottom });
  };
  const selectedPaths = selectedFiles.map(file => file.path);
  return <div className="preview folder-preview">
    <div className="folder-summary"><span>{visibleFiles.length}{filterActive && ` of ${preview.files.length}`} file{visibleFiles.length === 1 ? "" : "s"}
      {preview.recursive ? " incl. subfolders" : ""}
      {excluded.length > 0 && ` · ${availableVisible.length} selectable · ${excluded.length} unavailable`}
      {visibleFiles.some(file => queuedKeys.has(remoteFileKey(file))) &&
        ` · ${visibleFiles.filter(file => queuedKeys.has(remoteFileKey(file))).length} already queued`}
      {hiddenSelected > 0 && ` · ${hiddenSelected} selected outside this filter`}</span>
      <strong>{bytes(visibleFiles.reduce((sum, file) => sum + file.size, 0))}
        {filterActive && ` shown · ${bytes(preview.audio_bytes)} folder`}</strong></div>
    {eligible.length ? <>
      <div className="folder-tree-columns"><span>File</span><span>Type / bitrate</span><span>Size</span></div>
      <FolderTree preview={preview} files={eligible} selected={selected} onSelect={chooseFile}
        queuedKeys={queuedKeys}
        onFileMenu={openFileMenu} canQueue={canDownload} />
    </> : <small>No selectable files match this filter. Select All or adjust the filter to see other files.</small>}
    {excluded.length > 0 && <details className="excluded-results">
      <summary>Excluded ({excluded.length}) · {bytes(preview.audio_bytes - preview.eligible_bytes)}</summary>
      <FolderTree preview={preview} files={excluded} selected={selected} onSelect={chooseFile}
        queuedKeys={queuedKeys}
        onFileMenu={openFileMenu} canQueue={false} />
    </details>}
    {expired && <small className="warn">Preview expired. Refresh this folder before downloading.</small>}
    {canQueue && <div className={`folder-actions${selectedFiles.length ? " has-selection" : ""}`}>
      <span className="mobile-selection-summary" aria-live="polite">{selectedFiles.length
        ? `${selectedFiles.length} selected · ${bytes(selectedBytes)}`
        : `${allEligible.length} available · ${bytes(allEligible.reduce((sum, file) => sum + file.size, 0))}`}</span>
      {selected.size > 0 && <button className="secondary" disabled={!canDownload}
        onClick={() => onSelectionChange(new Set())}>Clear selection</button>}
      <button className={selected.size > 0 ? "secondary" : "folder-download-primary"}
        disabled={!canDownload || !allEligible.length}
        onClick={() => confirmPreview(allEligible.map(file => file.path))}>
        Download all ({allEligible.length})
      </button>
      {selected.size > 0 && <button className="folder-download-primary" disabled={!canDownload || !selectedFiles.length}
        onClick={() => confirmPreview(selectedPaths)}>Download selected ({selectedFiles.length}, {bytes(selectedBytes)})</button>}
      {filterActive && allEligible.length > eligible.length &&
        <small className="folder-actions-note">Download all includes files hidden by this filter.</small>}
    </div>}
    {menu && canDownload && <ContextMenu x={menu.x} y={menu.y} label={`Download selected (${selectedFiles.length})`}
      onDownload={() => confirmPreview(selectedPaths)} onClose={() => setMenu(null)} />}
  </div>;
}

function TransferActions({ transfer, action, busy }: { transfer: TransferItem;
  action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean }): React.ReactElement {
  return <>
    {["queued", "active"].includes(transfer.status) && <button className="quiet" disabled={busy} onClick={() => {
      if (confirm(`Cancel ${basename(transfer.path)}?`)) void action(() => send(`/transfers/${transfer.id}/cancel`));
    }}>Cancel</button>}
    {["failed", "cancelled"].includes(transfer.status) && <button className="secondary" disabled={busy} onClick={() => {
      if (confirm(`Retry exactly ${basename(transfer.path)} at the same required quality?`))
        void action(() => send(`/transfers/${transfer.id}/retry`));
    }}>Retry file</button>}</>;
}

function DownloadTree({ items, action, busy, expandFolders }: { items: DownloadItem[];
  action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean; expandFolders: boolean;
}): React.ReactElement {
  const disclosures = useDisclosureGroup(items.map(item => `${item.id}:${item.status}`).join("|"));
  const peers = new Map<string, Map<string, DownloadItem[]>>();
  for (const item of items) {
    let folders = peers.get(item.username);
    if (!folders) { folders = new Map(); peers.set(item.username, folders); }
    const directory = parentDirectory(item.path);
    const files = folders.get(directory) ?? [];
    files.push(item);
    folders.set(directory, files);
  }
  return <><div className="disclosure-toolbar"><button className="secondary" type="button"
    onClick={disclosures.toggle}>{disclosures.allOpen ? "Collapse all" : "Expand all"}</button></div>
    <div className="download-tree" ref={disclosures.root}>{[...peers].map(([username, folders]) => {
    const peerFiles = [...folders.values()].flat();
    return <Collapsible className="download-peer" initiallyOpen key={username}>
      <summary><strong>{username}</strong><small>{peerFiles.length} file{peerFiles.length === 1 ? "" : "s"} · {bytes(peerFiles.reduce((sum, file) => sum + file.size, 0))}</small></summary>
      {[...folders].map(([directory, files]) => <Collapsible className="download-folder" initiallyOpen={expandFolders} key={directory}>
        <summary><strong className="download-directory-desktop" title={directory}>{directory || "Shared files"}</strong>
          <strong className="download-directory-mobile" title={directory}>{basename(directory) || "Shared files"}</strong>
          <small>{files.length} file{files.length === 1 ? "" : "s"} · {bytes(files.reduce((sum, file) => sum + file.size, 0))}</small></summary>
        <small className="download-directory-path">{directory}</small>
        {files.map(item => <DownloadRow key={item.id} item={item} action={action} busy={busy} />)}
      </Collapsible>)}
    </Collapsible>;
  })}</div></>;
}

function DownloadRow({ item, action, busy }: { item: DownloadItem;
  action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean }): React.ReactElement {
  const progress = item.status === "completed" ? 100 : Math.max(0, Math.min(100, item.progress));
  const label = item.status === "active" ? `${Math.round(progress)}%` :
    item.status === "completed" ? "Completed" : item.status.replace("_", " ");
  return <div className="download-row">
    <div className="download-file"><strong title={item.path}>{basename(item.path)}</strong>
      <small title={item.query_text}><a href={`#/search/${item.batch_id}?request=${item.request_id}`}>
        Search #{item.batch_number}</a></small>
      {item.error && <small className="warn">{item.error}</small>}</div>
    <div className={`download-bar ${item.status}`} role="progressbar" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={progress} aria-label={`${basename(item.path)}: ${label}`}>
      <span className="download-bar-fill" style={{ width: `${progress}%` }} />
      <span className="download-bar-label">{label}</span>
    </div>
    <span className="download-size">{bytes(item.transferred)} / {bytes(item.size)}</span>
    <span className="download-actions"><TransferActions transfer={item} action={action} busy={busy} /></span>
  </div>;
}

function ActivityList({ events }: { events: Activity[] }): React.ReactElement {
  if (!events.length) return <p className="empty">No activity yet.</p>;
  return <div className="activity-list">{events.map(event => <div className="event" key={event.id}>
    <span className={`indicator ${event.severity}`} aria-label={event.severity} /><div><strong>{event.message}</strong>
      <small><span className="severity">{event.severity}</span>{" "}{time(event.created_at)} · {
        event.category === "quality" ? "file result" : event.category === "batch" ? "search" : event.category
      } · {event.event_type === "folder_file_excluded" ? "blocked by old quality rule" :
        event.event_type.replaceAll("_", " ")}
        {event.batch_id && <> · <a href={`#/search/${event.batch_id}${event.request_id ? `?request=${event.request_id}` : ""}`}>{event.request_id ? "Query" : "Search"}</a></>}</small></div></div>)}</div>;
}

function ActivityPage({ reload }: { reload: number }): React.ReactElement {
  const [events, setEvents] = useState<Activity[]>([]);
  const [severity, setSeverity] = useState("");
  const [category, setCategory] = useState("");
  const [batchId, setBatchId] = useState("");
  const [requestId, setRequestId] = useState("");
  const [search, setSearch] = useState("");
  const [older, setOlder] = useState(false);
  const [error, setError] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(() => matchMedia("(min-width: 700px)").matches);
  const activeFilters = [severity, category, batchId, requestId, search].filter(Boolean).length;
  useEffect(() => {
    const params = new URLSearchParams({ limit: "40" });
    if (severity) params.set("severity", severity);
    if (category) params.set("category", category);
    if (batchId) params.set("batchId", batchId);
    if (requestId) params.set("requestId", requestId);
    if (search) params.set("search", search);
    api<Activity[]>(`/activity?${params}`).then(items => { setEvents(items); setOlder(items.length === 40); }).catch(err => setError(String(err)));
  }, [reload, severity, category, batchId, requestId, search]);
  async function loadOlder(): Promise<void> {
    const last = events.at(-1);
    if (!last) return;
    try {
      const params = new URLSearchParams({ limit: "40", cursor: String(last.id) });
      if (severity) params.set("severity", severity);
      if (category) params.set("category", category);
      if (batchId) params.set("batchId", batchId);
      if (requestId) params.set("requestId", requestId);
      if (search) params.set("search", search);
      const items = await api<Activity[]>(`/activity?${params}`);
      setEvents(existing => [...existing, ...items]); setOlder(items.length === 40);
    } catch (err) { setError(String(err)); }
  }
  const exportEvents = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "phonofetch-activity.json";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return <><div className="page-title"><div><h1>Activity Log</h1>
    <p>Persistent events · Europe/Lisbon time</p></div>
    <button className="secondary desktop-activity-export" onClick={exportEvents}>Export loaded events</button></div>
    <section className="panel activity-panel"><div className="panel-heading"><div><h2>Events</h2><small>Stored on your NAS</small></div>
      <button className="secondary filter-toggle" aria-controls="activity-filters" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(open => !open)}>
        Filters{activeFilters ? ` (${activeFilters})` : ""} <span aria-hidden="true">{filtersOpen ? "−" : "+"}</span></button></div>
      <details className="mobile-activity-options"><summary>More options</summary>
        <button className="secondary" onClick={exportEvents}>Export loaded events</button>
      </details>
      {filtersOpen && <div className="filters" id="activity-filters"><label>Severity<select value={severity} onChange={event => setSeverity(event.target.value)}>
      <option value="">All</option>{["info", "success", "warning", "error"].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Category<input placeholder="e.g. search" value={category} onChange={event => setCategory(event.target.value)} /></label>
      <label>Search ID<input value={batchId} onChange={event => setBatchId(event.target.value)} /></label>
      <label>Query ID<input value={requestId} onChange={event => setRequestId(event.target.value)} /></label>
      <label>Search messages<input value={search} onChange={event => setSearch(event.target.value)} /></label></div>}
      <p role="alert">{error}</p><ActivityList events={events} />
      {older && <button className="secondary" onClick={() => void loadOlder()}>Load older events</button>}</section></>;
}

createRoot(document.getElementById("root")!).render(<App />);
