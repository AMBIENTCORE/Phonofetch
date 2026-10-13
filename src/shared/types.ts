export type RequestType = "track" | "album_folder";
export type Quality = "mp3_320" | "flac" | "any";
export type Mode = "review" | "automatic";
export type SeedKind = "track_seed" | "album_title";
export type RequestStatus = "pending" | "searching" | "review" | "no_results" | "queueing" | "active" | "completed" | "partial" | "failed" | "cancelled" | "uncertain";
export type TransferStatus = "ready" | "queueing" | "queued" | "active" | "completed" | "failed" | "cancelled" | "uncertain";
export type Severity = "info" | "success" | "warning" | "error";
export type SlskdConnectionState = "connected" | "unavailable" | null;

export interface Batch {
  id: string;
  number: number;
  name: string;
  original_input: string;
  default_type: RequestType;
  mode: Mode;
  created_at: string;
  updated_at: string;
  status?: string;
  counts?: Record<string, number>;
}

export interface MusicRequest {
  id: string;
  batch_id: string;
  position: number;
  query_text: string;
  type: RequestType;
  seed_kind: SeedKind;
  artist: string;
  title: string;
  original_input: string;
  norm_artist: string;
  norm_title: string;
  quality: Quality;
  mode: Mode;
  status: RequestStatus;
  search_id: string | null;
  search_started_at: string | null;
  search_window_ms: number;
  search_stop_requested_at: string | null;
  search_file_count: number;
  search_response_count: number;
  selected_candidate_id: string | null;
  selected_directory: string | null;
  score: number | null;
  explanation: string | null;
  error: string | null;
  retries: number;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AudioMetadata {
  bitrate: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  vbr: boolean | null;
}

export interface RemoteFile {
  username: string;
  path: string;
  directory: string;
  size: number;
  metadata: AudioMetadata;
  upload_speed?: number | null;
  queue_length?: number | null;
  free_slot?: boolean | null;
}

export interface Candidate extends RemoteFile {
  id: string;
  request_id: string;
  eligible: boolean;
  reason: string;
  score: number;
  explanation: string;
  selected: boolean;
}

export interface PreviewFile extends RemoteFile {
  eligible: boolean;
  reason: string;
}

export interface FolderPreview {
  id: string;
  request_id: string;
  username: string;
  directory: string;
  recursive: boolean;
  files: PreviewFile[];
  created_at: string;
  eligible_count: number;
  excluded_count: number;
  audio_bytes: number;
  eligible_bytes: number;
}

export interface FolderJob {
  id: string;
  request_id: string;
  preview_id: string;
  username: string;
  directory: string;
  recursive: number;
  discovered_count: number;
  eligible_count: number;
  excluded_count: number;
  selected_count: number;
  unselected_count: number;
  estimated_bytes: number;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransferItem {
  id: string;
  queue_id: string | null;
  slskd_id: string | null;
  request_id: string;
  folder_job_id: string | null;
  username: string;
  path: string;
  size: number;
  status: TransferStatus;
  transferred: number;
  progress: number;
  error: string | null;
  retries: number;
  created_at: string;
  updated_at: string;
}

export interface DownloadItem extends TransferItem {
  batch_id: string;
  batch_number: number;
  query_text: string;
}

export interface DownloadStats {
  completed_count: number;
  completed_bytes: number;
  active_count: number;
  active_transferred_bytes: number;
  uncertain_count: number;
}

export interface DownloadsData {
  active: DownloadItem[];
  finished: DownloadItem[];
  active_total: number;
  finished_total: number;
  stats: DownloadStats;
}

export interface Activity {
  id: number;
  created_at: string;
  severity: Severity;
  category: string;
  event_type: string;
  message: string;
  batch_id: string | null;
  request_id: string | null;
  folder_job_id: string | null;
  transfer_id: string | null;
  metadata: string;
}

export interface BatchDetail {
  batch: Batch;
  slskd_status: SlskdConnectionState;
  requests: Array<MusicRequest & { candidates: Candidate[]; previews: FolderPreview[]; jobs: Array<FolderJob & { transfers: TransferItem[] }> ; transfers: TransferItem[] }>;
  activity: Activity[];
}
