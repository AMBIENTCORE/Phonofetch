import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Activity, AudioMetadata, Batch, BatchDetail, FolderPreview, Quality, RequestType, SeedKind, SlskdConnectionState, TransferItem } from "../shared/types";
import { normalize, parseLines, type ParsedLine } from "../server/matching";
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
const qualityLabel = (value: Quality): string => ({ mp3_320: "MP3 320 kbps (strict)", flac: "FLAC", any: "Any quality" })[value];
const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;
const audioDetails = (metadata: AudioMetadata): string => [
  metadata.bitrate === null ? "bitrate unknown" : `${metadata.bitrate} kbps`,
  metadata.sampleRate === null ? null : `${metadata.sampleRate} Hz`,
  metadata.bitDepth === null ? null : `${metadata.bitDepth}-bit`,
  metadata.vbr === null ? "VBR unknown" : metadata.vbr ? "VBR" : "CBR reported"
].filter(Boolean).join(" · ");

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
    const interval = setInterval(() => setReload(n => n + 1), 5000);
    return () => clearInterval(interval);
  }, [authenticated]);
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
  const batchId = page.startsWith("#/batch/") ? page.slice("#/batch/".length).split("?")[0] : null;
  return <div className="shell">
    <header><a className="brand" href="#/"><img className="brand-symbol" src="/phonofetch-mark.svg" alt="" /> Phonofetch</a><nav aria-label="Main navigation">
      <a className={page === "#/" ? "current" : ""} href="#/">Dashboard</a>
      <a className={page === "#/new" ? "current" : ""} href="#/new">New Batch</a>
      <a className={page === "#/activity" ? "current" : ""} href="#/activity">Activity Log</a>
    </nav><button className="quiet" onClick={() => void action(async () => { await send("/logout"); csrf = ""; setAuthenticated(false); })}>Sign out</button></header>
    <main><div className="global-error" role="alert">{error}</div>
      {page === "#/new" ? <NewBatch action={action} busy={busy} /> :
        page === "#/activity" ? <ActivityPage reload={reload} /> :
          batchId ? <BatchPage id={batchId} page={page} reload={reload} action={action} busy={busy} /> :
            <Dashboard reload={reload} />}
    </main>
  </div>;
}

function Dashboard({ reload }: { reload: number }): React.ReactElement {
  const [data, setData] = useState<{ batches: Array<Batch & { total: number; completed: number; active: number; unresolved: number }>;
    activity: Activity[]; counts: Record<string, number>; slskd_status: SlskdConnectionState }>();
  const [error, setError] = useState("");
  useEffect(() => { api<typeof data>("/dashboard").then(setData).catch(err => setError(String(err))); }, [reload]);
  const metrics = [
    { label: "Processing", value: data?.counts.active },
    { label: "Pending", value: data?.counts.pending },
    { label: "Completed", value: data?.counts.completed },
    { label: "Partial", value: data?.counts.partial },
    { label: "Review", value: data?.counts.review },
    { label: "Failed / uncertain", value: data?.counts.failed }
  ];
  return <><div className="page-title"><div><h1>Dashboard</h1><p>Batches, transfers, and recent activity.</p></div>
    <a className="button" href="#/new">+ New Batch</a></div>
    {data?.slskd_status === "unavailable" && <p role="status" className="service-warning">slskd unavailable. Searches stay pending until it reconnects. <a href="#/activity">View Activity Log</a></p>}
    <p role="alert">{error}</p>
    <div className="metrics">{metrics.map(metric =>
      <div className="metric" key={metric.label}><strong>{metric.value ?? (data ? 0 : "…")}</strong><span>{metric.label}</span></div>)}</div>
    <div className="columns"><section className="panel history-panel"><div className="panel-heading"><h2>Batch history</h2><a href="#/new">Create batch →</a></div>
      {!data?.batches.length ? <p className="empty">No batches yet. Create one to start a search.</p> :
        data.batches.map(batch => <a className="batch-link" key={batch.id} href={`#/batch/${batch.id}`}>
          <span className="batch-copy"><strong>{batch.name}</strong><small>{time(batch.created_at)} · {batch.mode} mode</small>
            <span className="batch-progress"><span style={{ width: `${batch.total ? Math.min(100, 100 * batch.completed / batch.total) : 0}%` }} /></span></span>
          <span className="batch-tally"><strong>{batch.completed}/{batch.total}</strong><small>{batch.active} active · {batch.unresolved} unresolved</small></span></a>)}</section>
      <section className="panel"><div className="panel-heading"><h2>Recent activity</h2><a href="#/activity">View all →</a></div>
        <ActivityList events={data?.activity ?? []} /></section></div></>;
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
  return <><div className="page-title"><div><h1>New Batch</h1><p>One text search per line · up to 100 requests</p></div></div>
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
    {entries && <section className="panel review-panel"><div className="panel-heading"><h2>Review requests <span className="count-pill">{entries.length}</span></h2><span>Edit or remove invalid lines</span></div>
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
        location.hash = `#/batch/${result.id}`;
      })}>Submit {entries.length} request{entries.length === 1 ? "" : "s"}</button>
      <p className="hint">Strict quality never falls back automatically. Album folders require inspecting each file before queueing.</p></section>}</>;
}

function BatchPage({ id, page, reload, action, busy }: { id: string; page: string; reload: number; action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean }): React.ReactElement {
  const [data, setData] = useState<BatchDetail>();
  const [error, setError] = useState("");
  useEffect(() => { api<BatchDetail>(`/batches/${encodeURIComponent(id)}`).then(setData).catch(err => setError(String(err))); }, [id, reload]);
  useEffect(() => {
    const related = new URLSearchParams(location.hash.split("?")[1] ?? "").get("request");
    if (related && data?.requests.some(item => item.id === related))
      document.getElementById(`request-${related}`)?.scrollIntoView({ block: "start" });
  }, [data, page]);
  return <><div className="page-title"><div><a className="back" href="#/">← Dashboard</a><h1>{data?.batch.name ?? "Batch"}</h1>
    <p>{data ? `${data.requests.length} requests · ${data.batch.status} · ${data.batch.mode} mode · ${time(data.batch.created_at)}` : "Loading…"}</p></div></div>
    {data?.slskd_status === "unavailable" && <p role="status" className="service-warning">slskd unavailable. These requests cannot search until it reconnects. <a href="#/activity">View Activity Log</a></p>}
    {data && <div className="batch-counts">{Object.entries(data.batch.counts ?? {}).map(([status, count]) =>
      <span key={status}>{status.replace("_", " ")}: <strong>{count}</strong></span>)}</div>}
    <p role="alert">{error}</p>{data?.requests.map(request => <RequestCard key={request.id} request={request} action={action} busy={busy} />)}
    {data && <section className="panel"><div className="panel-heading"><h2>Recent activity</h2><a href="#/activity">Full log →</a></div><ActivityList events={data.activity} /></section>}</>;
}

type RequestDetail = BatchDetail["requests"][number];
function RequestCard({ request, action, busy }: { request: RequestDetail; action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean }): React.ReactElement {
  const [recursive, setRecursive] = useState(false);
  const [retryQuality, setRetryQuality] = useState<Quality>(request.quality);
  const [selectedPreview, setSelectedPreview] = useState<string | null>(null);
  const preview = request.previews.find(item => item.id === selectedPreview) ?? request.previews[0];
  const folderCandidates = Array.from(new Map(request.candidates.map(candidate => [`${candidate.username}\0${candidate.directory}`, candidate])).values());
  return <section className="panel request" id={`request-${request.id}`}><div className="panel-heading">
    <div><span className="tag">{request.type === "track" ? "TRACK" : "ALBUM / FOLDER"}</span> <span className={`status ${request.status}`}>{request.status.replace("_", " ")}</span>
      <h2>{request.query_text}</h2>
      <p>{qualityLabel(request.quality)} · {request.mode} · {request.type === "album_folder" ? request.seed_kind.replace("_", " ") : "single file"}</p>
      <small>{request.candidates.length} candidates · {request.transfers.length} transfers · updated {time(request.updated_at)} · ID {request.id.slice(0, 8)}</small></div></div>
    {request.error && <p className="warn" role="alert">{request.error}</p>}
    {request.status === "searching" && <p>Searching Soulseek… this continues when the browser closes.</p>}
    {request.status === "no_results" && !request.error && <p>No qualifying files returned by Soulseek.</p>}
    {["failed", "no_results", "review", "cancelled"].includes(request.status) && request.transfers.length === 0 &&
      <div className="retry"><label>Retry with quality <select value={retryQuality} onChange={event => setRetryQuality(event.target.value as Quality)}>
        <option value="mp3_320">MP3 320</option><option value="flac">FLAC</option><option value="any">Any quality</option></select></label>
        <button className="secondary" disabled={busy} onClick={() => void action(() => send(`/requests/${request.id}/retry`, { quality: retryQuality }))}>Search again</button></div>}
    {request.type === "track" && request.candidates.length > 0 && <div><h3>Matching files</h3><div className="candidate-list">
      {request.candidates.map(candidate => <div className="candidate" key={candidate.id}>
        <span><strong>{basename(candidate.path)}</strong><small>{candidate.username} · {candidate.path}</small><small>{bytes(candidate.size)} · {audioDetails(candidate.metadata)} · relevance {Math.round(candidate.score * 100)}% · {candidate.explanation}</small>
          <small className={candidate.eligible ? "ok" : "warn"}>{candidate.reason}</small></span>
        {candidate.eligible && request.transfers.length === 0 && <button disabled={busy} onClick={() => { if (confirm(`Queue exactly this file?\n${candidate.path}`)) void action(() => send(`/requests/${request.id}/select`, { candidateId: candidate.id })); }}>Queue file</button>}</div>)}</div></div>}
    {request.type === "album_folder" && folderCandidates.length > 0 && <div><h3>Candidate folders</h3>
      {folderCandidates.map(candidate => <div className="candidate" key={candidate.id}>
        <span><strong>{candidate.directory}</strong><small>{candidate.username} · seed: {basename(candidate.path)} · relevance {Math.round(candidate.score * 100)}%</small><small>{candidate.explanation}</small></span>
        <button className="secondary" disabled={busy} onClick={() => void action(async () => {
          const result = await send<FolderPreview>(`/requests/${request.id}/preview`, { candidateId: candidate.id, recursive });
          setSelectedPreview(result.id);
        })}>Inspect folder</button></div>)}
      <label className="check"><input type="checkbox" checked={recursive} onChange={event => setRecursive(event.target.checked)} /> Include nested files (never sibling folders)</label>
    </div>}
    {request.type === "album_folder" && preview && !request.jobs.length && <Preview preview={preview} busy={busy}
      action={action} confirmPreview={() => { if (confirm(`Queue ${preview.eligible_count} eligible files from ${preview.username}\\${preview.directory}?${preview.excluded_count ? ` ${preview.excluded_count} excluded: partial album.` : ""}`))
        void action(() => send(`/requests/${request.id}/queue-folder`, { previewId: preview.id })); }} />}
    {request.jobs.map(job => <div key={job.id} className="job"><h3>Folder job · {job.status}</h3>
      <p>{job.username} · {job.directory}</p><p>{job.transfers.filter(t => t.status === "completed").length} completed / {job.eligible_count} eligible
        {job.excluded_count > 0 && <span className="warn"> · Partial album: {job.excluded_count} excluded</span>}</p>
      <progress max={Math.max(1, job.transfers.reduce((sum, t) => sum + t.size, 0))}
        value={job.transfers.reduce((sum, t) => sum + t.transferred, 0)} /></div>)}
    {request.transfers.length > 0 && <div><h3>Transfers</h3>{request.transfers.map(transfer =>
      <Transfer key={transfer.id} transfer={transfer} action={action} busy={busy} />)}</div>}
  </section>;
}

function Preview({ preview, action, busy, confirmPreview }: { preview: FolderPreview; action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean; confirmPreview: () => void }): React.ReactElement {
  return <div className="preview"><h3>Folder preview</h3><p><strong>Peer:</strong> {preview.username} · <strong>Directory:</strong> {preview.directory}</p>
    <p>{preview.files.length} discovered · <span className="ok">{preview.eligible_count} eligible</span> ·
      <span className="warn"> {preview.excluded_count} excluded</span> · {bytes(preview.eligible_bytes)} estimated</p>
    {preview.excluded_count > 0 && <p className="warn">This will be a partial album. Excluded files will not be queued.</p>}
    <div className="file-list">{preview.files.map(file => <div key={file.path} className="file-row"><span>{basename(file.path)}<small>{bytes(file.size)} · {audioDetails(file.metadata)}</small></span>
      <span className={file.eligible ? "ok" : "warn"}>{file.reason}</span></div>)}</div>
    <button disabled={busy || preview.eligible_count === 0} onClick={confirmPreview}>Confirm {preview.eligible_count} eligible files</button>
    <span className="hint"> Preview expires after 10 minutes; contents are verified again before queueing.</span></div>;
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
      <small><span className="severity">{event.severity}</span>{" "}{time(event.created_at)} · {event.category} · {event.event_type}
        {event.batch_id && <> · <a href={`#/batch/${event.batch_id}${event.request_id ? `?request=${event.request_id}` : ""}`}>{event.request_id ? "Request" : "Batch"}</a></>}</small></div></div>)}</div>;
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
      <label>Batch ID<input value={batchId} onChange={event => setBatchId(event.target.value)} /></label>
      <label>Request ID<input value={requestId} onChange={event => setRequestId(event.target.value)} /></label>
      <label>Search messages<input value={search} onChange={event => setSearch(event.target.value)} /></label></div>}
      <p role="alert">{error}</p><ActivityList events={events} />
      {older && <button className="secondary" onClick={() => void loadOlder()}>Load older events</button>}</section></>;
}

createRoot(document.getElementById("root")!).render(<App />);
