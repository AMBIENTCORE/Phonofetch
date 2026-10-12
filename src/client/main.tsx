import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Activity, AudioMetadata, Batch, BatchDetail, FolderPreview, PreviewFile, Quality, RequestType, SeedKind, SlskdConnectionState, TransferItem } from "../shared/types";
import { normalize, parseLines, type ParsedLine } from "../server/matching";
import { AUTO_FOLDER_PREVIEW_LIMIT, autoFolderPreviews, folderKey } from "./folder-results";
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
  return <><div className="page-title"><div><a className="back" href="#/">← Dashboard</a><h1>{data?.batch.name ?? "Batch"}</h1>
    <p>{data ? `${data.requests.length} requests · ${data.batch.status} · ${data.batch.mode} mode · ${time(data.batch.created_at)}` : "Loading…"}</p></div></div>
    {data?.slskd_status === "unavailable" && <p role="status" className="service-warning">slskd unavailable. These requests cannot search until it reconnects. <a href="#/activity">View Activity Log</a></p>}
    {data && <div className="batch-counts">{Object.entries(data.batch.counts ?? {}).map(([status, count]) =>
      <span key={status}>{status.replace("_", " ")}: <strong>{count}</strong></span>)}</div>}
    <p role="alert">{error}</p>{data?.requests.map(request => <RequestCard key={request.id} request={request} action={action}
      busy={busy} inspecting={inspecting} previewErrors={previewErrors} clearPreviewError={key => setPreviewErrors(current => {
        const next = { ...current }; delete next[key]; return next;
      })} />)}
    {data && <section className="panel"><div className="panel-heading"><h2>Recent activity</h2><a href="#/activity">Full log →</a></div><ActivityList events={data.activity} /></section>}</>;
}

type RequestDetail = BatchDetail["requests"][number];
function RequestCard({ request, action, busy, inspecting, previewErrors, clearPreviewError }: {
  request: RequestDetail; action: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean;
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
  const folderGroupsByPeer = new Map<string, Array<[string, typeof request.candidates]>>();
  for (const entry of grouped) {
    const username = entry[1][0]!.username;
    const folders = folderGroupsByPeer.get(username) ?? [];
    folders.push(entry);
    folderGroupsByPeer.set(username, folders);
  }
  const eligibleCount = request.candidates.filter(candidate => candidate.eligible).length;
  const canInspect = ["review", "no_results"].includes(request.status) && !request.jobs.length;
  const trackGroups = new Map<string, Map<string, typeof request.candidates>>();
  for (const candidate of request.candidates) {
    let directories = trackGroups.get(candidate.username);
    if (!directories) { directories = new Map(); trackGroups.set(candidate.username, directories); }
    const files = directories.get(candidate.directory) ?? [];
    files.push(candidate);
    directories.set(candidate.directory, files);
  }
  const queueTrack = (candidateId: string) => {
    const candidate = request.candidates.find(item => item.id === candidateId);
    if (candidate?.eligible && request.status === "review" && !request.transfers.length && !busy &&
      confirm(`Queue exactly this file?\n${candidate.path}`))
      void action(() => send(`/requests/${request.id}/select`, { candidateId }));
  };
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
    {request.type === "track" && request.candidates.length > 0 && <div><h3>Matching files · {eligibleCount} qualify · {request.candidates.length - eligibleCount} excluded</h3>
      <p className="hint">Only files meeting {qualityLabel(request.quality)} can be queued. Right-click an eligible row or use Queue file.</p>
      <div className="search-results">{[...trackGroups].map(([username, directories]) =>
        <details className="peer-group" open key={username}><summary>{username} · {[...directories.values()].reduce((count, files) => count + files.length, 0)} matches</summary>
          {[...directories].map(([directory, files]) => <details className="directory-group" open key={directory}>
            <summary>{directory || "Shared files"} · {files.length} search hits · {bytes(files.reduce((sum, file) => sum + file.size, 0))} known</summary>
            <div className="search-table-wrap"><table className="search-table"><thead><tr>
              <th>File</th><th>Size</th><th>Quality / eligibility</th><th>Match</th><th>Action</th>
            </tr></thead><tbody>{files.map(candidate => <tr key={candidate.id}
              tabIndex={candidate.eligible && request.status === "review" ? 0 : undefined}
              onContextMenu={event => {
                if (!candidate.eligible || request.status !== "review" || request.transfers.length || busy) return;
                event.preventDefault();
                setTrackMenu({ candidateId: candidate.id, x: event.clientX, y: event.clientY });
              }}
              onKeyDown={event => {
                if (event.shiftKey && event.key === "F10" && candidate.eligible && request.status === "review" && !request.transfers.length && !busy) {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setTrackMenu({ candidateId: candidate.id, x: rect.left + 12, y: rect.bottom });
                }
              }}>
              <td title={candidate.path}><strong>{basename(candidate.path)}</strong></td>
              <td className="file-size">{bytes(candidate.size)}</td>
              <td>{audioDetails(candidate.metadata)}<small className={candidate.eligible ? "ok" : "warn"}>
                {candidate.eligible ? "Eligible" : "Excluded"} · {candidate.reason}</small></td>
              <td>{Math.round(candidate.score * 100)}%<small>{candidate.explanation}</small></td>
              <td>{candidate.eligible && request.status === "review" && !request.transfers.length &&
                <button disabled={busy} onClick={() => queueTrack(candidate.id)}>Queue file</button>}</td>
            </tr>)}</tbody></table></div>
          </details>)}
        </details>)}</div>
      {trackMenu && request.status === "review" && !request.transfers.length && !busy &&
        <ContextMenu x={trackMenu.x} y={trackMenu.y} label="Download file"
        onDownload={() => queueTrack(trackMenu.candidateId)} onClose={() => setTrackMenu(null)} />}
    </div>}
    {request.type === "album_folder" && grouped.size > 0 && <div><h3>Candidate folders · {grouped.size}</h3>
      <p className="hint">The first {AUTO_FOLDER_PREVIEW_LIMIT} folders in this batch are inspected automatically. Other search hits are incomplete until inspected.</p>
      <label className="check"><input type="checkbox" checked={recursive} onChange={event => setRecursive(event.target.checked)} /> Include nested files (never sibling folders)</label>
      {[...folderGroupsByPeer].map(([username, folders]) => <details className="peer-group" open key={username}>
        <summary>{username} · {folders.length} folders</summary>{folders.map(([key, hits]) => {
        const candidate = hits[0]!;
        const preview = request.previews.find(item =>
          folderKey(request.id, item.username, item.directory, item.recursive) === key);
        const hitBytes = hits.reduce((total, file) => total + file.size, 0);
        return <div className="folder-candidate" key={key}><div className="candidate">
          <span><strong>{candidate.directory}</strong><small>Relevance {Math.round(candidate.score * 100)}% · {candidate.explanation}</small></span>
          {canInspect && <button className="secondary" disabled={busy || inspecting.has(key)} onClick={() => void action(async () => {
            await send<FolderPreview>(`/requests/${request.id}/preview`, { candidateId: candidate.id, recursive });
            clearPreviewError(key);
          })}>{inspecting.has(key) ? "Inspecting…" : preview ? "Refresh folder" : "Inspect folder"}</button>}
        </div>
        {preview ? <Preview key={preview.id} preview={preview} busy={busy} canQueue={canInspect}
          confirmPreview={paths => {
            const count = paths?.length ?? preview.eligible_count;
            if (confirm(`Queue ${count} files from ${preview.username}\\${preview.directory}?${preview.excluded_count || count < preview.eligible_count ?
              ` Partial folder: ${preview.excluded_count} quality-excluded and ${preview.eligible_count - count} unselected.` : ""}`))
              void action(() => send(`/requests/${request.id}/queue-folder`, { previewId: preview.id, selectedPaths: paths }));
          }} /> :
          <div className="folder-search-hits">
            <small>Search hits only (not the full folder) · {hits.length} file{hits.length === 1 ? "" : "s"} · {bytes(hitBytes)} known</small>
            {hits.map(file => <div className="folder-hit" key={file.id}><span>{basename(file.path)}</span><span>{bytes(file.size)}</span></div>)}
          </div>}
        {previewErrors[key] && !preview && <small role="alert" className="warn">Inspection failed: {previewErrors[key]}. Select Inspect folder to retry.</small>}
        </div>;
      })}</details>)}
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

function FolderTree({ preview, selected, onSelect, onFileMenu, canQueue }: {
  preview: FolderPreview; selected: Set<string>; onSelect: (path: string) => void;
  onFileMenu: (event: React.MouseEvent | React.KeyboardEvent, file: PreviewFile) => void; canQueue: boolean;
}): React.ReactElement {
  const root: FolderTreeNode = { name: preview.directory, directories: new Map(), files: [] };
  const prefix = `${preview.directory.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  for (const file of preview.files) {
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
      {node.files.map(file => <li className="folder-tree-file" key={file.path} tabIndex={canQueue && file.eligible ? 0 : undefined}
        onContextMenu={event => onFileMenu(event, file)}
        onKeyDown={event => { if (event.key === "F10" && event.shiftKey) onFileMenu(event, file); }}>
        <label className="folder-tree-select"><input type="checkbox" checked={selected.has(file.path)}
          aria-label={`Select ${basename(file.path)}`} disabled={!canQueue || !file.eligible}
          onChange={() => onSelect(file.path)} />
          <span><strong>{basename(file.path)}</strong><small>{audioDetails(file.metadata)} · {file.eligible ? "Eligible" : `Excluded: ${file.reason}`}</small></span>
        </label><span className="folder-file-size">{bytes(file.size)}</span>
      </li>)}
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
    <div className="folder-summary"><span>Inspected · {preview.recursive ? "including nested files" : "immediate files"} ·
      {preview.files.length} audio · {preview.eligible_count} eligible · {preview.excluded_count} excluded</span>
      <strong>Audio total {bytes(preview.audio_bytes)} · Eligible {bytes(preview.eligible_bytes)}</strong></div>
    <div className="folder-tree-columns"><span>File / quality</span><span>Size</span></div>
    <FolderTree preview={preview} selected={selected} onSelect={chooseFile} onFileMenu={openFileMenu} canQueue={canDownload} />
    {preview.excluded_count > 0 && <small className="warn">Partial album if downloaded: excluded files never queue.</small>}
    {expired && <small className="warn">Preview expired. Refresh this folder before downloading.</small>}
    {canQueue && <div className="folder-actions">
      <button className="secondary" disabled={!canDownload} onClick={() => setSelected(new Set(eligible.map(file => file.path)))}>Select all eligible</button>
      <button className="secondary" disabled={!canDownload || !selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
      <button disabled={!canDownload || !selectedFiles.length} onClick={() => confirmPreview(selectedPaths)}>
        Download selected ({selectedFiles.length}, {bytes(selectedBytes)})
      </button>
      <button className="secondary" disabled={!canDownload || !eligible.length} onClick={() => confirmPreview()}>
        Download all eligible ({eligible.length})
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
