import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Activity, Batch, BatchDetail, Candidate, DownloadItem, DownloadsData, DownloadStats, FolderPreview, PreviewFile, Quality, RequestType, SeedKind, SlskdConnectionState, TransferItem } from "../shared/types";
import { normalize, parseLines, type ParsedLine } from "../server/matching";
import { audioDetails, fileFormat } from "./audio-details";
import { autoFolderPreviews, folderKey } from "./folder-results";
import "./compact.css";

let csrf = "";
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}), ...init.headers }
  });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(typeof data === "object" && data !== null && "error" in data ? String(data.error) : `HTTP ${response.status}`);
  return data as T;
}
const send = <T,>(path: string, body: object = {}): Promise<T> => api<T>(path, { method: "POST", body: JSON.stringify(body) });
const time = (value: string): string => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Lisbon", dateStyle: "short", timeStyle: "medium"
}).format(new Date(value));
const bytes = (value: number): string => value < 1024 ? `${value} B` :
  value < 1048576 ? `${(value / 1024).toFixed(1)} KiB` :
    value < 1073741824 ? `${(value / 1048576).toFixed(1)} MiB` : `${(value / 1073741824).toFixed(2)} GiB`;
const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;
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
  return <div className="shell">
    <header><a className="brand" href="#/"><img className="brand-symbol" src="/phonofetch-mark.svg" alt="" /> Phonofetch</a><nav aria-label="Main navigation">
      <a className={page === "#/" ? "current" : ""} href="#/">Dashboard</a>
      <a className={page === "#/downloads" ? "current" : ""} href="#/downloads">Downloads</a>
      <a className={page === "#/new" ? "current" : ""} href="#/new">New Search</a>
      <a className={page === "#/activity" ? "current" : ""} href="#/activity">Activity Log</a>
    </nav><button className="quiet" onClick={() => void action(async () => { await send("/logout"); csrf = ""; setAuthenticated(false); })}>Sign out</button></header>
    <main><div className="global-error" role="alert">{error}</div>
      {page === "#/new" ? <NewBatch action={action} busy={busy} /> :
        page === "#/downloads" ? <DownloadsPage reload={reload} action={action} busy={busy} /> :
        page === "#/activity" ? <ActivityPage reload={reload} /> :
          batchId ? <BatchPage id={batchId} page={page} reload={reload} action={action} busy={busy} /> :
            <Dashboard reload={reload} />}
    </main>
  </div>;
}

function DownloadMetrics({ stats }: { stats?: DownloadStats }): React.ReactElement {
  const metrics = [
    { label: "Downloaded since reset", value: stats ? bytes(stats.completed_bytes) : "…" },
    { label: "Completed files", value: stats?.completed_count ?? "…" },
    { label: "Active transfers", value: stats?.active_count ?? "…" },
    { label: "Active transferred", value: stats ? bytes(stats.active_transferred_bytes) : "…" }
  ];
  return <div className="metrics download-metrics">{metrics.map(metric =>
    <div className="metric" key={metric.label}><strong>{metric.value}</strong><span>{metric.label}</span></div>)}</div>;
}

function DownloadSource({ item }: { item: DownloadItem }): React.ReactElement {
  return <small className="download-source"><a href={`#/search/${item.batch_id}?request=${item.request_id}`}>
    Search #{item.batch_number} · {item.query_text}</a> · {time(item.updated_at)}</small>;
}

function Dashboard({ reload }: { reload: number }): React.ReactElement {
  const [data, setData] = useState<{ batches: Array<Batch & { total: number }>;
    downloads: DownloadsData; activity: Activity[]; slskd_status: SlskdConnectionState }>();
  const [error, setError] = useState("");
  useEffect(() => { api<typeof data>("/dashboard").then(setData).catch(err => setError(String(err))); }, [reload]);
  const recentDownloads = [...(data?.downloads.active ?? []), ...(data?.downloads.finished ?? [])].slice(0, 5);
  return <><div className="page-title"><div><h1>Dashboard</h1><p>Downloads and recent searches.</p></div>
    <a className="button" href="#/new">+ New Search</a></div>
    {data?.slskd_status === "unavailable" && <p role="status" className="service-warning">slskd unavailable. Searches stay pending until it reconnects. <a href="#/activity">View Activity Log</a></p>}
    <p role="alert">{error}</p>
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
  const [data, setData] = useState<DownloadsData>();
  const [error, setError] = useState("");
  const [activeLimit, setActiveLimit] = useState(50);
  const [finishedLimit, setFinishedLimit] = useState(50);
  useEffect(() => {
    api<DownloadsData>(`/downloads?activeLimit=${activeLimit}&finishedLimit=${finishedLimit}`)
      .then(setData).catch(err => setError(String(err)));
  }, [reload, activeLimit, finishedLimit]);
  return <><div className="page-title"><div><h1>Downloads</h1><p>slskd transfers; clearing this view never deletes downloaded files.</p></div></div>
    <p role="alert">{error}</p>
    <DownloadMetrics stats={data?.stats} />
    <div className="download-controls">
      <button className="secondary" disabled={busy || !data?.finished_total} onClick={() => {
        if (confirm("Hide completed, failed and cancelled downloads from the list? Files and statistics are kept."))
          void action(async () => { await send("/downloads/clear"); setFinishedLimit(50); });
      }}>Clear finished list</button>
      <button className="secondary" disabled={busy} onClick={() => {
        if (confirm("Reset completed-file and downloaded-byte statistics? Download entries are kept."))
          void action(() => send("/downloads/stats/clear"));
      }}>Clear statistics</button>
    </div>
    <section className="panel"><div className="panel-heading"><h2>Ongoing / needs attention</h2>
      <small>{data?.active_total ?? 0} transfers{data?.stats.uncertain_count ? ` · ${data.stats.uncertain_count} uncertain` : ""}</small></div>
      {!data?.active.length ? <p className="empty">No ongoing downloads.</p> :
        data.active.map(item => <div className="download-item" key={item.id}>
          <DownloadSource item={item} /><Transfer transfer={item} action={action} busy={busy} />
        </div>)}
      {data && data.active_total > data.active.length && <button className="secondary" onClick={() => setActiveLimit(limit => limit + 50)}>Load more ongoing</button>}
    </section>
    <section className="panel"><div className="panel-heading"><h2>Finished</h2>
      <small>{data?.finished_total ?? 0} in list</small></div>
      {!data?.finished.length ? <p className="empty">No finished downloads in the list.</p> :
        data.finished.map(item => <div className="download-item" key={item.id}>
          <DownloadSource item={item} /><Transfer transfer={item} action={action} busy={busy} />
        </div>)}
      {data && data.finished_total > data.finished.length && <button className="secondary" onClick={() => setFinishedLimit(limit => limit + 50)}>Load more finished</button>}
    </section></>;
}

function NewBatch({ action, busy }: { action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean }): React.ReactElement {
  const [input, setInput] = useState("");
  const [defaultType, setDefaultType] = useState<RequestType>("track");
  const [quality, setQuality] = useState<Quality>("mp3_320");
  const [mode, setMode] = useState<"review" | "automatic">("review");
  const [entries, setEntries] = useState<ParsedLine[] | null>(null);
  const [fileError, setFileError] = useState("");
  const update = (index: number, patch: Partial<ParsedLine>) => setEntries(rows => rows?.map((row, i) => i === index ?
    { ...row, ...patch, error: undefined, duplicate: false } : row) ?? null);
  return <><div className="page-title"><div><h1>New Search</h1><p>One query per line · up to 100 queries</p></div></div>
    <div className="panel form-panel">
      <label>Searches<textarea rows={4} maxLength={32768} value={input} placeholder={"ben klock subzero\nburial archangel"} onChange={event => { setInput(event.target.value); setEntries(null); }} /></label>
      <label className="upload">Text file (.txt)<input type="file" accept=".txt,text/plain" onChange={event => { const file = event.target.files?.[0]; if (!file) return;
        if (file.size > 32768 || !file.name.toLowerCase().endsWith(".txt")) { setFileError("Use a .txt file up to 32 KiB."); return; }
        void file.text().then(text => { setInput(current => [current, text].filter(Boolean).join("\n")); setEntries(null); setFileError(""); }).catch(() => setFileError("Could not read the file."));
      }} /></label><p role="alert">{fileError}</p>
      <div className="form-grid"><label>Default request type<select value={defaultType} onChange={event => setDefaultType(event.target.value as RequestType)}>
        <option value="track">Individual track</option><option value="album_folder">Album / folder</option></select></label>
        <label>Required quality<select value={quality} onChange={event => setQuality(event.target.value as Quality)}>
          <option value="mp3_320">MP3 320 (strict)</option><option value="flac">FLAC</option><option value="any">Any quality (explicit)</option></select></label>
        <label>Processing<select value={mode} onChange={event => setMode(event.target.value as "review" | "automatic")}>
          <option value="review">Review before queueing</option><option value="automatic">Automatically queue high-confidence matches</option></select></label></div>
      <button onClick={() => setEntries(parseLines(input, defaultType, quality))}>Review list</button>
    </div>
    {entries && <section className="panel review-panel"><div className="panel-heading"><h2>Review queries <span className="count-pill">{entries.length}</span></h2><span>Edit or remove invalid lines</span></div>
      {!entries.length && <p className="empty">Add at least one search line.</p>}
      {entries.map((row, index) => <div className="entry" key={index}><div className="entry-label"><span className="entry-number">{String(index + 1).padStart(2, "0")}</span> {row.original}</div>
        <div className="entry-fields"><label className="query-field">Search text<input value={row.queryText} maxLength={256} onChange={event => update(index, { queryText: event.target.value })} /></label>
          <label>Type<select value={row.type} onChange={event => update(index, { type: event.target.value as RequestType, seedKind: "track_seed" })}>
            <option value="track">Track</option><option value="album_folder">Album / folder</option></select></label>
          {row.type === "album_folder" && <label>Search for<select value={row.seedKind} onChange={event => update(index, { seedKind: event.target.value as SeedKind })}>
            <option value="track_seed">Track inside folder</option><option value="album_title">Album title</option></select></label>}
          <label>Quality<select value={row.quality} onChange={event => update(index, { quality: event.target.value as Quality })}>
            <option value="mp3_320">MP3 320</option><option value="flac">FLAC</option><option value="any">Any quality</option></select></label>
          <button className="quiet" onClick={() => setEntries(rows => rows?.filter((_, i) => i !== index) ?? null)}>Remove</button></div>
        {row.error && <span className="warn">{row.error}</span>}{row.duplicate && <span className="warn">Duplicate input — remove or edit before submitting.</span>}
      </div>)}
      <button disabled={busy || !entries.length || entries.some(row => !normalize(row.queryText) || row.error || row.duplicate)} onClick={() => void action(async () => {
        const result = await send<{ id: string }>("/batches", { originalInput: input, defaultType, mode, entries });
        location.hash = `#/search/${result.id}`;
      })}>Start search</button>
      <p className="hint">Strict quality never falls back automatically. Album folders require inspecting each file before queueing.</p></section>}</>;
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
  const [trackMenu, setTrackMenu] = useState<{ candidateId: string; x: number; y: number } | null>(null);
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
    const groups = preview ? preview.eligible_count > 0 ? matchingFolders : otherFolders :
      hits.some(hit => hit.eligible) ? matchingFolders : otherFolders;
    const username = hits[0]!.username;
    const folders = groups.get(username) ?? [];
    folders.push(entry);
    groups.set(username, folders);
  }
  const matchingCount = [...matchingFolders.values()].reduce((count, folders) => count + folders.length, 0);
  const eligibleCount = request.candidates.filter(candidate => candidate.eligible).length;
  const canInspect = ["review", "no_results"].includes(request.status) && !request.jobs.length;
  const queueTrack = (candidateId: string) => {
    const candidate = request.candidates.find(item => item.id === candidateId);
    if (candidate?.eligible && request.status === "review" && !request.transfers.length && !busy &&
      confirm(`Queue exactly this file?\n${candidate.path}`))
      void action(() => send(`/requests/${request.id}/select`, { candidateId }));
  };
  return <section className="panel request" id={`request-${request.id}`}><div className="panel-heading">
    <div>{!singleQuery && <h2>{request.query_text}</h2>}
      <small>{request.type === "track" ? "Track" : "Folder"} · {{
        mp3_320: "MP3 320", flac: "FLAC", any: "Any quality"
      }[request.quality]} {request.status !== "review" &&
        <span className={`status ${request.status}`}>{request.status.replace("_", " ")}</span>}</small></div></div>
    {request.error && <p className="warn" role="alert">{request.error}</p>}
    {request.status === "searching" && <p>{request.search_stop_requested_at ? "Preparing results…" :
      `Searching… ${request.search_file_count} files · ${request.search_response_count} responses`}</p>}
    {request.status === "no_results" && !request.error && <p>No qualifying files returned by Soulseek.</p>}
    {["failed", "no_results", "review", "cancelled"].includes(request.status) && request.transfers.length === 0 &&
      <details className="retry-options"><summary>{request.status === "review" ? "Search options" : "Retry search"}</summary>
      <div className="retry"><label>Quality <select value={retryQuality} onChange={event => setRetryQuality(event.target.value as Quality)}>
        <option value="mp3_320">MP3 320</option><option value="flac">FLAC</option><option value="any">Any quality</option></select></label>
        <button className="secondary" disabled={busy} onClick={() => void action(() => send(`/requests/${request.id}/retry`, { quality: retryQuality }))}>Search again (fast)</button>
        <button className="secondary" disabled={busy} onClick={() => {
          if (!request.candidates.length || confirm("A longer search replaces these results. Continue?"))
            void action(() => send(`/requests/${request.id}/retry`, { quality: retryQuality, longer: true }));
        }}>Search longer</button></div></details>}
    {request.type === "track" && request.candidates.length > 0 && <div><h3>Files ({eligibleCount})</h3>
      {eligibleCount > 0 ? <TrackResultsTable candidates={request.candidates.filter(candidate => candidate.eligible)}
        canQueue={request.status === "review" && !request.transfers.length && !busy} queueTrack={queueTrack}
        openMenu={(candidateId, x, y) => setTrackMenu({ candidateId, x, y })} /> :
        <p>No files met the selected quality. Expand excluded results for details.</p>}
      {eligibleCount < request.candidates.length && <details className="excluded-results">
        <summary>Show excluded files ({request.candidates.length - eligibleCount})</summary>
        <TrackResultsTable candidates={request.candidates.filter(candidate => !candidate.eligible)}
          canQueue={false} queueTrack={queueTrack} />
      </details>}
      {trackMenu && request.status === "review" && !request.transfers.length && !busy &&
        <ContextMenu x={trackMenu.x} y={trackMenu.y} label="Download file"
        onDownload={() => queueTrack(trackMenu.candidateId)} onClose={() => setTrackMenu(null)} />}
    </div>}
    {request.type === "album_folder" && grouped.size > 0 && <div><h3>Folders ({grouped.size})</h3>
      <label className="check"><input type="checkbox" checked={recursive} onChange={event => setRecursive(event.target.checked)} /> Include subfolders</label>
      {matchingCount > 0 ? <FolderCandidateList request={request} peers={matchingFolders} recursive={recursive}
        canInspect={canInspect} busy={busy} inspecting={inspecting} previewErrors={previewErrors}
        clearPreviewError={clearPreviewError} action={action} /> :
        <p>No qualifying folder is visible yet. Other folders can be inspected below.</p>}
      {grouped.size > matchingCount && <details className="excluded-results">
        <summary>Other folders ({grouped.size - matchingCount})</summary>
        <FolderCandidateList request={request} peers={otherFolders} recursive={recursive}
          canInspect={canInspect} busy={busy} inspecting={inspecting} previewErrors={previewErrors}
          clearPreviewError={clearPreviewError} action={action} />
      </details>}
    </div>}
    {request.jobs.map(job => <div key={job.id} className="job"><h3>Folder job · {job.status}</h3>
      <p>{job.username} · {job.directory} · selected {bytes(job.estimated_bytes)}</p>
      <p>{job.transfers.filter(t => t.status === "completed").length} completed / {job.selected_count} selected
        {job.excluded_count + job.unselected_count > 0 && <span className="warn"> · Partial folder: {job.excluded_count} quality-excluded, {job.unselected_count} unselected</span>}</p>
      <progress max={Math.max(1, job.transfers.reduce((sum, t) => sum + t.size, 0))}
        value={job.transfers.reduce((sum, t) => sum + t.transferred, 0)} /></div>)}
    {request.transfers.length > 0 && <div><h3>Transfers</h3>{request.transfers.map(transfer =>
      <Transfer key={transfer.id} transfer={transfer} action={action} busy={busy} />)}</div>}
  </section>;
}

function FolderCandidateList({ request, peers, recursive, canInspect, busy, inspecting, previewErrors, clearPreviewError, action }: {
  request: RequestDetail; peers: Map<string, Array<[string, Candidate[]]>>; recursive: boolean;
  canInspect: boolean; busy: boolean; inspecting: ReadonlySet<string>;
  previewErrors: Record<string, string>; clearPreviewError: (key: string) => void;
  action: (fn: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  return <>{[...peers].sort((a, b) => peerOrder(a[1][0]?.[1][0], b[1][0]?.[1][0])).map(([username, folders]) => <details className="peer-group" open key={username}>
    <summary>{username}{folders.length > 1 ? ` (${folders.length})` : ""} · {peerDetails(folders[0]?.[1][0])}</summary>{folders.map(([key, hits]) => {
      const candidate = hits[0]!;
      const preview = request.previews.find(item =>
        folderKey(request.id, item.username, item.directory, item.recursive) === key);
      const hitBytes = hits.reduce((total, file) => total + file.size, 0);
      return <div className="folder-candidate" key={key}><div className="candidate">
        <span><strong>{candidate.directory}</strong><small title={candidate.explanation}>Match {Math.round(candidate.score * 100)}%</small></span>
        {canInspect && <button className="quiet" disabled={busy || inspecting.has(key)} onClick={() => void action(async () => {
          await send<FolderPreview>(`/requests/${request.id}/preview`, { candidateId: candidate.id, recursive });
          clearPreviewError(key);
        })}>{inspecting.has(key) ? "Inspecting…" : preview ? "Refresh" : "Inspect"}</button>}
      </div>
      {preview ? <Preview key={preview.id} preview={preview} busy={busy} canQueue={canInspect}
        confirmPreview={paths => {
          const count = paths?.length ?? preview.eligible_count;
          if (confirm(`Queue ${count} files from ${preview.username}\\${preview.directory}?${preview.excluded_count || count < preview.eligible_count ?
            ` Partial folder: ${preview.excluded_count} quality-excluded and ${preview.eligible_count - count} unselected.` : ""}`))
            void action(() => send(`/requests/${request.id}/queue-folder`, { previewId: preview.id, selectedPaths: paths }));
        }} /> :
        <div className="folder-search-hits">
          <small>Search hits only · {hits.length} file{hits.length === 1 ? "" : "s"} · {bytes(hitBytes)}</small>
          {hits.map(file => <div className="folder-hit" key={file.id}><span>{basename(file.path)}</span>
            <span className="folder-file-format" title={audioDetails(file.metadata, file.path)}>
              {fileFormat(file.metadata, file.path)}</span><span className="folder-file-size">{bytes(file.size)}</span></div>)}
        </div>}
      {previewErrors[key] && !preview && <small role="alert" className="warn">Inspection failed: {previewErrors[key]}. Select Inspect to retry.</small>}
      </div>;
    })}</details>)}</>;
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

function TrackResultsTable({ candidates, canQueue, queueTrack, openMenu }: {
  candidates: Candidate[]; canQueue: boolean; queueTrack: (candidateId: string) => void;
  openMenu?: (candidateId: string, x: number, y: number) => void;
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
    <details className="peer-group" open key={username}><summary>{username} · {peerDetails([...directories.values()][0]?.[0])}</summary>
      {[...directories].map(([directory, files]) => <details className="directory-group" open key={directory}>
        <summary>{directory || "Shared files"} · {files.length} · {bytes(files.reduce((sum, file) => sum + file.size, 0))}</summary>
        <div className="search-table-wrap"><table className="search-table"><thead><tr>
          <th>File</th><th>Size</th><th>Type / bitrate</th><th>Match</th><th>Action</th>
        </tr></thead><tbody>{files.map(candidate => <tr key={candidate.id} tabIndex={canQueue ? 0 : undefined}
          onContextMenu={event => {
            if (!canQueue || !openMenu) return;
            event.preventDefault();
            openMenu(candidate.id, event.clientX, event.clientY);
          }}
          onKeyDown={event => {
            if (!canQueue || !openMenu || !event.shiftKey || event.key !== "F10") return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(candidate.id, rect.left + 12, rect.bottom);
          }}>
          <td title={candidate.path}><strong>{basename(candidate.path)}</strong></td>
          <td className="file-size">{bytes(candidate.size)}</td>
          <td title={audioDetails(candidate.metadata, candidate.path)}>{fileFormat(candidate.metadata, candidate.path)}
            {!candidate.eligible && <small className="warn">{candidate.reason}</small>}</td>
          <td title={candidate.explanation}>{Math.round(candidate.score * 100)}%</td>
          <td>{canQueue && <button onClick={() => queueTrack(candidate.id)}>Queue file</button>}</td>
        </tr>)}</tbody></table></div>
      </details>)}
    </details>)}</div>;
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

function FolderTree({ preview, files, selected, onSelect, onFileMenu, canQueue }: {
  preview: FolderPreview; files: PreviewFile[]; selected: Set<string>; onSelect: (path: string) => void;
  onFileMenu: (event: React.MouseEvent | React.KeyboardEvent, file: PreviewFile) => void; canQueue: boolean;
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
        return <li key={child.name}><details open><summary>{child.name}/ <small>{total.count} file{total.count === 1 ? "" : "s"} · {bytes(total.size)}</small></summary>{render(child)}</details></li>;
      })}
      {node.files.map(file => {
        const details = audioDetails(file.metadata, file.path);
        return <li className="folder-tree-file" key={file.path} tabIndex={canQueue && file.eligible ? 0 : undefined}
        onContextMenu={event => onFileMenu(event, file)}
        onKeyDown={event => { if (event.key === "F10" && event.shiftKey) onFileMenu(event, file); }}>
        <label className="folder-tree-select"><input type="checkbox" checked={selected.has(file.path)}
          aria-label={`Select ${basename(file.path)}`} disabled={!canQueue || !file.eligible}
          onChange={() => onSelect(file.path)} />
          <span><strong>{basename(file.path)}</strong>{!file.eligible && <small className="warn">{file.reason}</small>}</span>
        </label><span className="folder-file-format" title={details}>{fileFormat(file.metadata, file.path)}</span>
        <span className="folder-file-size">{bytes(file.size)}</span>
      </li>;
      })}
    </ul>;
  }
  return <div className="folder-tree-scroll">{render(root)}</div>;
}

function Preview({ preview, busy, canQueue, confirmPreview }: {
  preview: FolderPreview; busy: boolean; canQueue: boolean; confirmPreview: (paths?: string[]) => void;
}): React.ReactElement {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const expired = Date.now() - Date.parse(preview.created_at) > 10 * 60 * 1000;
  const canDownload = canQueue && !busy && !expired;
  const eligible = preview.files.filter(file => file.eligible);
  const excluded = preview.files.filter(file => !file.eligible);
  const selectedFiles = eligible.filter(file => selected.has(file.path));
  const selectedBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0);
  const chooseFile = (path: string) => setSelected(current => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const openFileMenu = (event: React.MouseEvent | React.KeyboardEvent, file: PreviewFile) => {
    if (!file.eligible || !canDownload) return;
    event.preventDefault();
    if (!selected.has(file.path)) setSelected(new Set([file.path]));
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: "clientX" in event ? event.clientX : rect.left + 12,
      y: "clientY" in event ? event.clientY : rect.bottom });
  };
  const selectedPaths = selectedFiles.map(file => file.path);
  return <div className="preview folder-preview">
    <div className="folder-summary"><span>{preview.files.length} files{preview.recursive ? " incl. subfolders" : ""}
      {preview.excluded_count > 0 && ` · ${preview.eligible_count} eligible · ${preview.excluded_count} excluded`}</span>
      <strong>{bytes(preview.audio_bytes)}{preview.excluded_count > 0 && ` · eligible ${bytes(preview.eligible_bytes)}`}</strong></div>
    {eligible.length ? <>
      <div className="folder-tree-columns"><span>File</span><span>Type / bitrate</span><span>Size</span></div>
      <FolderTree preview={preview} files={eligible} selected={selected} onSelect={chooseFile}
        onFileMenu={openFileMenu} canQueue={canDownload} />
    </> : <small>No files in this folder meet the selected quality.</small>}
    {excluded.length > 0 && <details className="excluded-results">
      <summary>Excluded ({excluded.length}) · {bytes(preview.audio_bytes - preview.eligible_bytes)}</summary>
      <FolderTree preview={preview} files={excluded} selected={selected} onSelect={chooseFile}
        onFileMenu={openFileMenu} canQueue={false} />
    </details>}
    {expired && <small className="warn">Preview expired. Refresh this folder before downloading.</small>}
    {canQueue && <div className="folder-actions">
      {selected.size > 0 && <button className="secondary" disabled={!canDownload}
        onClick={() => setSelected(new Set())}>Clear selection</button>}
      <button disabled={!canDownload || (selected.size > 0 ? !selectedFiles.length : !eligible.length)}
        onClick={() => confirmPreview(selected.size ? selectedPaths : undefined)}>
        {selected.size ? `Download selected (${selectedFiles.length}, ${bytes(selectedBytes)})` : `Download all (${eligible.length})`}
      </button>
    </div>}
    {menu && canDownload && <ContextMenu x={menu.x} y={menu.y} label={`Download selected (${selectedFiles.length})`}
      onDownload={() => confirmPreview(selectedPaths)} onClose={() => setMenu(null)} />}
  </div>;
}

function Transfer({ transfer, action, busy }: { transfer: TransferItem; action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean }): React.ReactElement {
  return <div className="transfer"><span><strong>{basename(transfer.path)}</strong><small>{transfer.username} · {bytes(transfer.transferred)} / {bytes(transfer.size)} · {transfer.status}</small>
    {transfer.error && <small className="warn">{transfer.error}</small>}</span><progress max={100} value={transfer.progress} />
    {["queued", "active"].includes(transfer.status) && <button className="quiet" disabled={busy} onClick={() => {
      if (confirm(`Cancel ${basename(transfer.path)}?`)) void action(() => send(`/transfers/${transfer.id}/cancel`));
    }}>Cancel</button>}
    {["failed", "cancelled"].includes(transfer.status) && <button className="secondary" disabled={busy} onClick={() => {
      if (confirm(`Retry exactly ${basename(transfer.path)} at the same required quality?`))
        void action(() => send(`/transfers/${transfer.id}/retry`));
    }}>Retry file</button>}</div>;
}

function ActivityList({ events }: { events: Activity[] }): React.ReactElement {
  if (!events.length) return <p className="empty">No activity yet.</p>;
  return <div className="activity-list">{events.map(event => <div className="event" key={event.id}>
    <span className={`indicator ${event.severity}`} aria-label={event.severity} /><div><strong>{event.message}</strong>
      <small><span className="severity">{event.severity}</span>{" "}{time(event.created_at)} · {event.category === "batch" ? "search" : event.category} · {event.event_type}
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
  return <><div className="page-title"><div><h1>Activity Log</h1>
    <p>Persistent events · Europe/Lisbon time</p></div>
    <button className="secondary" onClick={() => { const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
      const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "phonofetch-activity.json"; link.click(); URL.revokeObjectURL(link.href); }}>Export loaded events</button></div>
    <section className="panel activity-panel"><div className="panel-heading"><div><h2>Events</h2><small>Stored on your NAS</small></div>
      <button className="secondary filter-toggle" aria-controls="activity-filters" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(open => !open)}>
        Filters{activeFilters ? ` (${activeFilters})` : ""} <span aria-hidden="true">{filtersOpen ? "−" : "+"}</span></button></div>
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
