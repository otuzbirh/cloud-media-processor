"use client";

import {
  Activity,
  Archive,
  ArrowDownToLine,
  Check,
  ChevronRight,
  Clock3,
  CloudUpload,
  Cpu,
  Download,
  ExternalLink,
  FileArchive,
  FileImage,
  Gauge,
  History,
  ImageIcon,
  Layers3,
  LoaderCircle,
  MemoryStick,
  Play,
  RefreshCw,
  RotateCcw,
  ServerCog,
  SlidersHorizontal,
  Square,
  Sparkles,
  Trash2,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import { ChangeEvent, DragEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { startBatchPolling } from "@/lib/batch-polling.mjs";

type View = "processing" | "history" | "experiment";
type JobStatus = "waiting" | "active" | "completed" | "failed";
type BatchStatus = "waiting" | "processing" | "completed" | "failed";

type ApiJob = {
  id: string;
  fileName: string;
  status: JobStatus;
  progress: number;
  originalBytes: number;
  outputBytes?: number;
  thumbnailBytes?: number;
  totalOutputBytes?: number;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  downloadUrl?: string;
  thumbnailUrl?: string;
  error?: string;
};

type BatchStats = {
  terminal: boolean;
  completed: number;
  failed: number;
  inputBytes: number;
  outputBytes: number;
  savingsPercent: number;
  durationMs: number;
  averageProcessingMs: number;
};

type ApiBatch = {
  batchId: string;
  name: string;
  createdAt: number;
  profile: string;
  status: BatchStatus;
  fileCount: number;
  stats: BatchStats;
  jobs: ApiJob[];
  downloadUrl?: string;
};

type BatchSummary = Omit<ApiBatch, "jobs">;

type Metrics = {
  timestamp: number;
  deploymentPolicy: "STATIC" | "CPU_HPA" | "QUEUE_KEDA";
  queueLength: number;
  activeJobs: number;
  activeWorkers: number;
  averageWorkerCpuPercent: number;
  averageWorkerMemoryBytes: number;
  totalWorkerMemoryBytes: number;
  workerCpuRequestMillicores: number;
  workerMemoryRequestMiB: number;
  allocatedCpuCores: number;
  allocatedMemoryMiB: number;
  completedJobs: number;
  failedJobs: number;
  throughputLast60Seconds: number;
  averageProcessingMs: number;
  medianProcessingMs: number;
  p95ProcessingMs: number;
  averageQueueWaitMs: number;
  processedBytes: number;
};

type SessionSummary = {
  durationMs: number;
  sampleCount: number;
  workerMinutes: number;
  cpuRequestCoreMinutes: number;
  memoryRequestMiBMinutes: number;
  estimatedAllocatedCapacityCost: number | null;
  averageQueueLength: number;
  maximumQueueLength: number;
  minimumWorkers: number;
  averageWorkers: number;
  maximumWorkers: number;
  averageThroughput: number;
  averageProcessingMs: number;
  medianProcessingMs: number;
  p95ProcessingMs: number;
  averageQueueWaitMs: number;
  maximumQueueWaitMs: number;
  averageTurnaroundMs: number;
  medianTurnaroundMs: number;
  p95TurnaroundMs: number;
  averageWorkerCpuPercent: number;
  maximumWorkerCpuPercent: number;
  averageWorkerMemoryMiB: number;
  maximumWorkerMemoryMiB: number;
  averageCapacityUtilizationPercent: number;
  idleCapacityPercent: number;
  submittedJobs: number;
  completedJobs: number;
  failedJobs: number;
  incompleteJobs: number;
  failureRate: number;
  inputBytes: number;
  outputBytes: number;
  processedBytes: number;
  jobsPerWorkerMinute: number;
  processedMiBPerWorkerMinute: number;
  scalingActions: number;
  scalingOscillations: number;
  scaleUpReactionMs: number | null;
};

type ExperimentSession = {
  id: string;
  name: string;
  workloadProfile: string;
  deploymentPolicy: "STATIC" | "CPU_HPA" | "QUEUE_KEDA";
  status: "active" | "completed";
  startedAt: number;
  endedAt: number | null;
  samples?: Metrics[];
  summary?: SessionSummary;
};

type LocalFile = { id: string; file: File; preview: string };
type ProcessingOptions = {
  format: "webp" | "jpeg" | "png";
  quality: number;
  width: number;
  keepAspectRatio: boolean;
  thumbnailEnabled: boolean;
  thumbnailWidth: number;
  stripMetadata: boolean;
  watermarkEnabled: boolean;
  watermarkText: string;
  watermarkPosition: string;
  watermarkOpacity: number;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const PROFILE_LABELS: Record<string, string> = { webshop: "Web shop", blog: "Blog", social: "Društvene mreže", custom: "Prilagođene postavke", benchmark: "Benchmark" };
const POLICY_LABELS: Record<Metrics["deploymentPolicy"], string> = { STATIC: "S0 Statička", CPU_HPA: "S1 CPU HPA", QUEUE_KEDA: "S2 Red / KEDA" };
const PROFILE_OPTIONS: Record<string, ProcessingOptions> = {
  webshop: { format: "webp", quality: 82, width: 1600, keepAspectRatio: true, thumbnailEnabled: true, thumbnailWidth: 320, stripMetadata: true, watermarkEnabled: false, watermarkText: "", watermarkPosition: "southeast", watermarkOpacity: 0.35 },
  blog: { format: "webp", quality: 78, width: 1400, keepAspectRatio: true, thumbnailEnabled: true, thumbnailWidth: 400, stripMetadata: true, watermarkEnabled: false, watermarkText: "", watermarkPosition: "southeast", watermarkOpacity: 0.35 },
  social: { format: "jpeg", quality: 86, width: 1080, keepAspectRatio: true, thumbnailEnabled: true, thumbnailWidth: 360, stripMetadata: true, watermarkEnabled: false, watermarkText: "", watermarkPosition: "southeast", watermarkOpacity: 0.35 },
  custom: { format: "webp", quality: 78, width: 1600, keepAspectRatio: true, thumbnailEnabled: false, thumbnailWidth: 320, stripMetadata: true, watermarkEnabled: false, watermarkText: "", watermarkPosition: "southeast", watermarkOpacity: 0.35 },
};

const statusCopy: Record<JobStatus, string> = { waiting: "Na čekanju", active: "Obrada", completed: "Završeno", failed: "Neuspješno" };
const batchStatusCopy: Record<BatchStatus, string> = { waiting: "Na čekanju", processing: "U obradi", completed: "Završeno", failed: "Završeno s greškama" };

function formatBytes(value = 0) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(milliseconds?: number) {
  if (milliseconds === undefined || milliseconds < 0) return "-";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(2)} s`;
  return `${Math.floor(milliseconds / 60_000)} min ${Math.round((milliseconds % 60_000) / 1000)} s`;
}

function formatDate(timestamp: number) {
  const date = new Date(timestamp);
  const months = ["januar", "februar", "mart", "april", "maj", "juni", "juli", "august", "septembar", "oktobar", "novembar", "decembar"];
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${date.getDate()}. ${months[date.getMonth()]} ${date.getFullYear()}. u ${time}`;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Zahtjev nije uspio.");
  return data as T;
}

export default function Home() {
  const [view, setView] = useState<View>("processing");
  const [files, setFiles] = useState<LocalFile[]>([]);
  const previews = useRef(new Set<string>());
  const [currentBatch, setCurrentBatch] = useState<ApiBatch | null>(null);
  const [batchName, setBatchName] = useState("");
  const [selectedProfile, setSelectedProfile] = useState("webshop");
  const [profileModified, setProfileModified] = useState(false);
  const [options, setOptions] = useState<ProcessingOptions>(PROFILE_OPTIONS.webshop);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<BatchSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [sessions, setSessions] = useState<ExperimentSession[]>([]);
  const [activeSession, setActiveSession] = useState<ExperimentSession | null>(null);
  const [sessionName, setSessionName] = useState("");
  const [workloadProfile, setWorkloadProfile] = useState("low");

  const revokeFiles = useCallback((items: LocalFile[]) => {
    items.forEach((item) => {
      URL.revokeObjectURL(item.preview);
      previews.current.delete(item.preview);
    });
  }, []);

  useEffect(() => () => {
    previews.current.forEach((preview) => URL.revokeObjectURL(preview));
    previews.current.clear();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_URL}/health`, { signal: controller.signal })
      .then((response) => setApiOnline(response.ok))
      .catch((error) => { if (error.name !== "AbortError") setApiOnline(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!currentBatch?.batchId || view !== "processing") return;
    const controller = new AbortController();
    const stop = startBatchPolling({
      fetchBatch: () => jsonRequest<ApiBatch>(`${API_URL}/batches/${currentBatch.batchId}`, { signal: controller.signal }),
      onUpdate: (batch: ApiBatch) => setCurrentBatch(batch),
      onError: (error: unknown) => setMessage(error instanceof Error ? error.message : "Greška pri provjeri statusa."),
    });
    return () => {
      stop();
      controller.abort();
    };
  }, [currentBatch?.batchId, view]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await jsonRequest<{ batches: BatchSummary[] }>(`${API_URL}/batches`);
      setHistory(data.batches);
      setApiOnline(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Historija nije dostupna.");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const data = await jsonRequest<{ sessions: ExperimentSession[] }>(`${API_URL}/experiment/sessions`);
      setSessions(data.sessions);
      const running = data.sessions.find((session) => session.status === "active");
      if (running) {
        const loaded = await jsonRequest<ExperimentSession>(`${API_URL}/experiment/sessions/${running.id}`);
        setActiveSession((current) => current ?? loaded);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sesije nisu dostupne.");
    }
  }, []);

  useEffect(() => {
    if (view !== "history") return;
    const timer = window.setTimeout(() => void loadHistory(), 0);
    return () => window.clearTimeout(timer);
  }, [view, loadHistory]);

  useEffect(() => {
    if (view !== "experiment") return;
    let active = true;
    const refresh = async () => {
      try {
        const nextMetrics = await jsonRequest<Metrics>(`${API_URL}/experiment/metrics`);
        if (!active) return;
        setMetrics(nextMetrics);
        setApiOnline(true);
        if (activeSession?.status === "active") {
          const session = await jsonRequest<ExperimentSession>(`${API_URL}/experiment/sessions/${activeSession.id}`);
          if (active) setActiveSession(session);
        }
      } catch (error) {
        if (active) setMessage(error instanceof Error ? error.message : "Metrike nisu dostupne.");
      }
    };
    void refresh();
    const sessionsTimer = window.setTimeout(() => void loadSessions(), 0);
    const timer = window.setInterval(refresh, 5000);
    return () => {
      active = false;
      window.clearTimeout(sessionsTimer);
      window.clearInterval(timer);
    };
  }, [view, activeSession?.id, activeSession?.status, loadSessions]);

  const addFiles = useCallback((incoming: File[]) => {
    const accepted: LocalFile[] = [];
    const rejected: string[] = [];
    const remaining = Math.max(0, 30 - files.length);
    incoming.forEach((file) => {
      if (!ACCEPTED_TYPES.includes(file.type)) rejected.push(`${file.name}: nepodržan format`);
      else if (file.size > MAX_FILE_SIZE) rejected.push(`${file.name}: datoteka je veća od 15 MB`);
      else if (accepted.length >= remaining) rejected.push(`${file.name}: limit je 30 datoteka`);
      else {
        const preview = URL.createObjectURL(file);
        previews.current.add(preview);
        accepted.push({ id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`, file, preview });
      }
    });
    setFiles((current) => [...current, ...accepted]);
    setMessage(rejected.length ? rejected.slice(0, 3).join(" · ") : null);
  }, [files.length]);

  const resetWorkspace = useCallback(() => {
    revokeFiles(files);
    setFiles([]);
    setCurrentBatch(null);
    setBatchName("");
    setMessage(null);
  }, [files, revokeFiles]);

  const updateOption = <K extends keyof ProcessingOptions>(key: K, value: ProcessingOptions[K]) => {
    setOptions((current) => ({ ...current, [key]: value }));
    setProfileModified(true);
  };

  const chooseProfile = (profile: string) => {
    setSelectedProfile(profile);
    setOptions({ ...PROFILE_OPTIONS[profile] });
    setProfileModified(false);
  };

  const startProcessing = async () => {
    if (!files.length) return;
    if (options.watermarkEnabled && !options.watermarkText.trim()) {
      setMessage("Unesite tekst watermarka ili isključite watermark.");
      return;
    }
    setIsSubmitting(true);
    setMessage(null);
    const formData = new FormData();
    files.forEach(({ file }) => formData.append("images", file));
    formData.append("name", batchName);
    formData.append("profile", selectedProfile);
    Object.entries(options).forEach(([key, value]) => formData.append(key, String(value)));
    try {
      const batch = await jsonRequest<ApiBatch>(`${API_URL}/batches`, { method: "POST", body: formData });
      setCurrentBatch(batch);
      setApiOnline(true);
    } catch (error) {
      setApiOnline(false);
      setMessage(error instanceof Error ? error.message : "API trenutno nije dostupan.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const openBatch = async (batchId: string) => {
    try {
      const batch = await jsonRequest<ApiBatch>(`${API_URL}/batches/${batchId}`);
      revokeFiles(files);
      setFiles([]);
      setCurrentBatch(batch);
      setView("processing");
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Batch nije moguće otvoriti.");
    }
  };

  const startSession = async () => {
    try {
      const session = await jsonRequest<ExperimentSession>(`${API_URL}/experiment/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: sessionName, workloadProfile }),
      });
      setActiveSession(session);
      setSessionName("");
      await loadSessions();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sesiju nije moguće pokrenuti.");
    }
  };

  const stopSession = async () => {
    if (!activeSession) return;
    try {
      const session = await jsonRequest<ExperimentSession>(`${API_URL}/experiment/sessions/${activeSession.id}/stop`, { method: "POST" });
      setActiveSession(session);
      await loadSessions();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sesiju nije moguće završiti.");
    }
  };

  return (
    <main className="app-shell">
      <header className="app-sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><Layers3 size={20} /></div>
          <div className="brand-copy"><strong>Cloud Media</strong><span>Processor</span></div>
        </div>
        <nav aria-label="Glavna navigacija" className="app-nav">
          <NavButton active={view === "processing"} icon={<SlidersHorizontal size={18} />} label="Obrada" onClick={() => setView("processing")} />
          <NavButton active={view === "history"} icon={<History size={18} />} label="Historija" onClick={() => setView("history")} />
          <NavButton active={view === "experiment"} icon={<Activity size={18} />} label="Eksperiment" onClick={() => setView("experiment")} />
        </nav>
        <div className="sidebar-meta">
          <div className="system-state">
            <span className={`state-light ${apiOnline === null ? "is-checking" : apiOnline ? "is-online" : "is-offline"}`} />
            <div><strong>{apiOnline === null ? "Provjera sistema" : apiOnline ? "Sistem dostupan" : "API nije dostupan"}</strong><span>{apiOnline ? "API i red su povezani" : "Provjerite servis na portu 4000"}</span></div>
          </div>
          <p className="sidebar-note">Batch obrada i mjerenje cloud skaliranja u jednom radnom prostoru.</p>
        </div>
      </header>

      <div className="app-stage">
        {message && <div className="system-alert" role="alert"><span>{message}</span><button aria-label="Zatvori poruku" onClick={() => setMessage(null)} type="button"><X size={17} /></button></div>}

        <div className="app-view" key={view}>
          {view === "processing" && <ProcessingView
            batch={currentBatch}
            batchName={batchName}
            files={files}
            isDragging={isDragging}
            isSubmitting={isSubmitting}
            options={options}
            profileModified={profileModified}
            selectedProfile={selectedProfile}
            addFiles={addFiles}
            chooseProfile={chooseProfile}
            onBatchName={setBatchName}
            onDragging={setIsDragging}
            onReset={resetWorkspace}
            onStart={startProcessing}
            removeFile={(id) => setFiles((current) => { const removed = current.filter((item) => item.id === id); revokeFiles(removed); return current.filter((item) => item.id !== id); })}
            updateOption={updateOption}
          />}
          {view === "history" && <HistoryView batches={history} loading={historyLoading} onOpen={openBatch} onRefresh={loadHistory} />}
          {view === "experiment" && <ExperimentView
            activeSession={activeSession}
            metrics={metrics}
            sessionName={sessionName}
            sessions={sessions}
            workloadProfile={workloadProfile}
            onLoadSession={async (id) => setActiveSession(await jsonRequest<ExperimentSession>(`${API_URL}/experiment/sessions/${id}`))}
            onSessionName={setSessionName}
            onStart={startSession}
            onStop={stopSession}
            onWorkloadProfile={setWorkloadProfile}
          />}
        </div>
      </div>
    </main>
  );
}

function ProcessingView({ batch, batchName, files, isDragging, isSubmitting, options, profileModified, selectedProfile, addFiles, chooseProfile, onBatchName, onDragging, onReset, onStart, removeFile, updateOption }: {
  batch: ApiBatch | null; batchName: string; files: LocalFile[]; isDragging: boolean; isSubmitting: boolean; options: ProcessingOptions; profileModified: boolean; selectedProfile: string;
  addFiles: (files: File[]) => void; chooseProfile: (profile: string) => void; onBatchName: (name: string) => void; onDragging: (value: boolean) => void; onReset: () => void; onStart: () => void; removeFile: (id: string) => void;
  updateOption: <K extends keyof ProcessingOptions>(key: K, value: ProcessingOptions[K]) => void;
}) {
  const handleInput = (event: ChangeEvent<HTMLInputElement>) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); onDragging(false); addFiles(Array.from(event.dataTransfer.files)); };
  const rows = batch?.jobs ?? [];

  const pipelineStep = batch ? (batch.status === "completed" || batch.status === "failed" ? 4 : 3) : files.length ? 2 : 1;

  return <div className="page-frame processing-page">
    <div className="command-hero">
      <header className="page-heading">
        <div><h1>Pripremite novi batch</h1><p>Dodajte fotografije, odaberite izlazne postavke i pokrenite obradu.</p></div>
        <div className="hero-side">
          <div className="hero-readout"><span className="hero-pulse" /><div><small>{batch ? batchStatusCopy[batch.status] : files.length ? "Spremno za obradu" : "Pipeline je spreman"}</small><strong>{batch ? `${batch.stats.completed}/${batch.fileCount}` : `${files.length}/30`} datoteka</strong><p>{options.format.toUpperCase()} · {options.width} px · kvalitet {options.quality}%</p></div></div>
          {(files.length > 0 || batch) && <button className="button hero-action" onClick={onReset} type="button"><RotateCcw size={16} />Novi batch</button>}
        </div>
      </header>

      <ol className="pipeline-rail" aria-label="Faze obrade">
        {["Učitavanje", "Postavke", "Obrada", "Preuzimanje"].map((label, index) => <li className={pipelineStep > index + 1 ? "is-complete" : pipelineStep === index + 1 ? "is-current" : ""} key={label}><span>{pipelineStep > index + 1 ? <Check size={14} /> : index + 1}</span><strong>{label}</strong></li>)}
      </ol>
    </div>

    <div className="workspace-grid">
      <section className="workspace-main">
      {!batch && <div className={`upload-zone ${isDragging ? "is-dragging" : ""}`} onDragEnter={() => onDragging(true)} onDragLeave={() => onDragging(false)} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
        <input accept="image/jpeg,image/png,image/webp" aria-label="Odaberi fotografije" multiple onChange={handleInput} type="file" />
        <div className="upload-icon"><UploadCloud size={27} /></div><div><p>Prevucite fotografije ili odaberite datoteke</p><span>JPEG, PNG ili WebP · najviše 30 datoteka · 15 MB po datoteci</span></div>
      </div>}

      <div className="surface file-surface">
        <div className="surface-header"><div><h2>{batch?.name ?? "Datoteke za obradu"}</h2><p>{batch ? `${batch.fileCount} datoteka · ${batchStatusCopy[batch.status]}` : `${files.length} od 30 datoteka`}</p></div>{batch?.downloadUrl && <a className="button button-secondary" href={`${API_URL}${batch.downloadUrl}`}><FileArchive size={16} />Preuzmi ZIP</a>}</div>
        {!batch && files.length === 0 ? <div className="empty-state"><ImageIcon size={28} /><p>Datoteke koje odaberete pojavit će se ovdje.</p><span>Možete ih ukloniti prije pokretanja obrade.</span></div> :
          <div className="file-list">{batch ? rows.map((job) => <JobRow job={job} key={job.id} />) : files.map((item) => <div className="file-row" key={item.id}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="" src={item.preview} /><div className="file-copy"><p>{item.file.name}</p><span>{formatBytes(item.file.size)}</span></div><button aria-label={`Ukloni ${item.file.name}`} className="icon-button is-danger" onClick={() => removeFile(item.id)} type="button"><Trash2 size={17} /></button></div>)}</div>}
      </div>

      {batch && <div className="metric-ribbon"><MetricCard icon={<Archive size={17} />} label="Ulaz" value={formatBytes(batch.stats.inputBytes)} /><MetricCard icon={<Download size={17} />} label="Izlaz" value={formatBytes(batch.stats.outputBytes)} /><MetricCard icon={<Sparkles size={17} />} label="Ušteda" value={`${batch.stats.savingsPercent}%`} /><MetricCard icon={<Clock3 size={17} />} label="Trajanje" value={formatDuration(batch.stats.durationMs)} /><MetricCard icon={<Gauge size={17} />} label="Prosjek" value={formatDuration(batch.stats.averageProcessingMs)} /><MetricCard icon={<X size={17} />} label="Greške" value={String(batch.stats.failed)} /></div>}
      </section>

    <aside className="settings-panel surface">
        <div className="surface-header settings-heading"><div><h2>Postavke pipelinea</h2><p>Primjenjuju se na cijeli batch</p></div><ServerCog size={19} /></div>
        <div className="settings-form">
          <Field label="Naziv batcha"><input className="control" disabled={Boolean(batch)} maxLength={80} onChange={(event) => onBatchName(event.target.value)} placeholder="Npr. Proizvodi - septembar" value={batchName} /></Field>
          <Field label={`Profil${profileModified ? " · izmijenjen" : ""}`}><select className="control" disabled={Boolean(batch)} onChange={(event) => chooseProfile(event.target.value)} value={selectedProfile}><option value="webshop">Web shop</option><option value="blog">Blog</option><option value="social">Društvene mreže</option><option value="custom">Prilagođene postavke</option></select></Field>
          <div className="field-pair"><Field label="Format"><select className="control" disabled={Boolean(batch)} onChange={(event) => updateOption("format", event.target.value as ProcessingOptions["format"])} value={options.format}><option value="webp">WebP</option><option value="jpeg">JPEG</option><option value="png">PNG</option></select></Field><Field label="Širina"><input className="control" disabled={Boolean(batch)} max={8000} min={200} onChange={(event) => updateOption("width", Number(event.target.value))} type="number" value={options.width} /></Field></div>
          <Field label={`Kvalitet · ${options.quality}%`}><input aria-label="Kvalitet slike" className="range-control w-full" disabled={Boolean(batch)} max={95} min={35} onChange={(event) => updateOption("quality", Number(event.target.value))} type="range" value={options.quality} /></Field>
          <Toggle checked={options.keepAspectRatio} disabled={Boolean(batch)} label="Zadrži proporcije" onChange={(value) => updateOption("keepAspectRatio", value)} />
          <Toggle checked={options.thumbnailEnabled} disabled={Boolean(batch)} label="Generiši thumbnail" onChange={(value) => updateOption("thumbnailEnabled", value)} />
          {options.thumbnailEnabled && <Field label="Širina thumbnaila"><input className="control" disabled={Boolean(batch)} max={1200} min={80} onChange={(event) => updateOption("thumbnailWidth", Number(event.target.value))} type="number" value={options.thumbnailWidth} /></Field>}
          <Toggle checked={options.stripMetadata} disabled={Boolean(batch)} label="Ukloni EXIF i metapodatke" onChange={(value) => updateOption("stripMetadata", value)} />
          <Toggle checked={options.watermarkEnabled} disabled={Boolean(batch)} label="Tekstualni watermark" onChange={(value) => updateOption("watermarkEnabled", value)} />
          {options.watermarkEnabled && <div className="sub-settings"><Field label="Tekst"><input className="control" disabled={Boolean(batch)} maxLength={80} onChange={(event) => updateOption("watermarkText", event.target.value)} value={options.watermarkText} /></Field><Field label="Pozicija"><select className="control" disabled={Boolean(batch)} onChange={(event) => updateOption("watermarkPosition", event.target.value)} value={options.watermarkPosition}><option value="northwest">Gore lijevo</option><option value="north">Gore</option><option value="northeast">Gore desno</option><option value="center">Sredina</option><option value="southwest">Dolje lijevo</option><option value="south">Dolje</option><option value="southeast">Dolje desno</option></select></Field><Field label={`Transparentnost · ${Math.round(options.watermarkOpacity * 100)}%`}><input className="range-control w-full" disabled={Boolean(batch)} max={100} min={5} onChange={(event) => updateOption("watermarkOpacity", Number(event.target.value) / 100)} type="range" value={Math.round(options.watermarkOpacity * 100)} /></Field></div>}
        </div>
        <button className="button button-primary process-button" disabled={!files.length || isSubmitting || Boolean(batch)} onClick={onStart} type="button">{isSubmitting ? <LoaderCircle className="animate-spin" size={18} /> : <CloudUpload size={18} />}{batch ? "Obrada je pokrenuta" : files.length ? `Obradi ${files.length} ${files.length === 1 ? "fotografiju" : "fotografija"}` : "Odaberite fotografije"}{!isSubmitting && !batch && <ChevronRight size={17} />}</button>
    </aside>
    </div>
  </div>;
}

function JobRow({ job }: { job: ApiJob }) {
  return <div className="file-row job-row"><div className={`file-type status-${job.status}`}><FileImage size={18} /></div><div className="file-copy"><div><p>{job.fileName}</p>{job.status === "completed" && <Check size={15} />}</div><span>{formatBytes(job.originalBytes)}<b>{statusCopy[job.status]}</b>{job.totalOutputBytes !== undefined && <>na {formatBytes(job.totalOutputBytes)}</>}{job.startedAt && job.finishedAt && <>{formatDuration(job.finishedAt - job.startedAt)}</>}</span>{job.status === "active" && <div className="progress-track"><div style={{ width: `${job.progress}%` }} /></div>}{job.error && <em>{job.error}</em>}</div>{job.downloadUrl && <a aria-label={`Preuzmi ${job.fileName}`} className="icon-button" href={`${API_URL}${job.downloadUrl}`}><ArrowDownToLine size={17} /></a>}</div>;
}

function HistoryView({ batches, loading, onOpen, onRefresh }: { batches: BatchSummary[]; loading: boolean; onOpen: (id: string) => void; onRefresh: () => void }) {
  return <section className="page-frame"><header className="page-heading section-hero history-hero"><div><h1>Svaki batch ostavlja jasan trag.</h1><p>Otvorite prethodni rezultat, provjerite uštedu ili preuzmite cijeli izlaz.</p></div><button aria-label="Osvježi historiju" className="button hero-action" onClick={onRefresh} type="button"><RefreshCw className={loading ? "animate-spin" : ""} size={17} />Osvježi</button></header>
    <div className="surface history-surface"><div className="history-head"><span>Batch</span><span>Status</span><span>Datoteke</span><span>Ulaz / izlaz</span><span>Trajanje</span><span>Akcije</span></div>{batches.length === 0 ? <div className="empty-state history-empty"><History size={29} /><p>{loading ? "Učitavanje historije..." : "Još nema sačuvanih batch obrada."}</p><span>Pokrenite prvu obradu da biste ovdje dobili trag rezultata.</span></div> : <div className="history-list">{batches.map((batch) => <div className="history-row" key={batch.batchId}><div className="history-name"><p>{batch.name}</p><span>{formatDate(batch.createdAt)} · {PROFILE_LABELS[batch.profile] ?? batch.profile}</span></div><StatusBadge status={batch.status} /><p data-label="Datoteke">{batch.stats.completed}/{batch.fileCount}</p><p data-label="Ulaz / izlaz">{formatBytes(batch.stats.inputBytes)}<span>{formatBytes(batch.stats.outputBytes)} · ušteda {batch.stats.savingsPercent}%</span></p><p data-label="Trajanje">{formatDuration(batch.stats.durationMs)}</p><div className="row-actions"><button aria-label={`Otvori ${batch.name}`} className="icon-button" onClick={() => onOpen(batch.batchId)} type="button"><ExternalLink size={16} /></button>{batch.downloadUrl && <a aria-label={`Preuzmi ${batch.name}`} className="icon-button" href={`${API_URL}${batch.downloadUrl}`}><FileArchive size={16} /></a>}</div></div>)}</div>}</div>
  </section>;
}

function ExperimentView({ activeSession, metrics, sessionName, sessions, workloadProfile, onLoadSession, onSessionName, onStart, onStop, onWorkloadProfile }: { activeSession: ExperimentSession | null; metrics: Metrics | null; sessionName: string; sessions: ExperimentSession[]; workloadProfile: string; onLoadSession: (id: string) => void; onSessionName: (value: string) => void; onStart: () => void; onStop: () => void; onWorkloadProfile: (value: string) => void }) {
  const running = activeSession?.status === "active";
  const samples = activeSession?.samples ?? [];
  const summary = activeSession?.summary;
  return <section className="page-frame experiment-page"><header className="page-heading section-hero experiment-hero"><div><h1>Skaliranje vidljivo u stvarnom vremenu.</h1><p>Uporedite red, workere, propusnost, latenciju i alocirani kapacitet.</p></div><span className="policy-chip"><ServerCog size={15} />{metrics ? POLICY_LABELS[metrics.deploymentPolicy] : "Politika nije dostupna"}</span></header>

    <div className="metric-ribbon experiment-metrics"><MetricCard icon={<Clock3 size={17} />} label="Dužina reda" value={String(metrics?.queueLength ?? "-")} /><MetricCard icon={<Activity size={17} />} label="Aktivni poslovi" value={String(metrics?.activeJobs ?? "-")} /><MetricCard icon={<Users size={17} />} label="Aktivni workeri" value={String(metrics?.activeWorkers ?? "-")} /><MetricCard icon={<Gauge size={17} />} label="Throughput / 60 s" value={String(metrics?.throughputLast60Seconds ?? "-")} /><MetricCard icon={<Cpu size={17} />} label="CPU workera" value={metrics ? `${metrics.averageWorkerCpuPercent.toFixed(1)}%` : "-"} /><MetricCard icon={<MemoryStick size={17} />} label="Memorija workera" value={metrics ? formatBytes(metrics.averageWorkerMemoryBytes) : "-"} /><MetricCard icon={<Cpu size={17} />} label="Alocirani CPU" value={metrics ? `${metrics.allocatedCpuCores.toFixed(2)} jezgri` : "-"} /><MetricCard icon={<MemoryStick size={17} />} label="Alocirana memorija" value={metrics ? `${metrics.allocatedMemoryMiB.toFixed(0)} MiB` : "-"} /><MetricCard icon={<Check size={17} />} label="Završeni" value={String(metrics?.completedJobs ?? "-")} /><MetricCard icon={<X size={17} />} label="Neuspješni" value={String(metrics?.failedJobs ?? "-")} /><MetricCard icon={<Clock3 size={17} />} label="Prosjek / P95" value={metrics ? `${formatDuration(metrics.averageProcessingMs)} / ${formatDuration(metrics.p95ProcessingMs)}` : "-"} /><MetricCard icon={<Clock3 size={17} />} label="Čekanje" value={formatDuration(metrics?.averageQueueWaitMs)} /><MetricCard icon={<Archive size={17} />} label="Obrađeni podaci" value={metrics ? formatBytes(metrics.processedBytes) : "-"} /></div>

    <div className="experiment-grid"><div className="surface chart-surface"><div className="surface-header"><div><h2>Tekuća sesija</h2><p>Red, workeri i throughput iz stvarnih uzoraka</p></div>{running && <span className="live-badge"><span />Aktivna</span>}</div>{samples.length > 1 ? <div className="chart-wrap"><ResponsiveContainer height="100%" initialDimension={{ width: 1, height: 1 }} minWidth={0} width="100%"><LineChart data={samples}><XAxis dataKey="timestamp" tickFormatter={(value) => new Date(value).toLocaleTimeString("bs-BA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} minTickGap={30} tick={{ fontSize: 11, fill: "#6c7b7d" }} axisLine={{ stroke: "#dbe2e1" }} tickLine={false} /><YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#6c7b7d" }} axisLine={false} tickLine={false} width={32} /><Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #dbe2e1", boxShadow: "0 12px 30px rgba(16,23,25,.10)" }} labelFormatter={(value) => formatDate(Number(value))} /><Line dataKey="queueLength" name="Red" stroke="#c98524" strokeWidth={2.5} dot={false} /><Line dataKey="activeWorkers" name="Workeri" stroke="#00a7a0" strokeWidth={2.5} dot={false} /><Line dataKey="throughputLast60Seconds" name="Throughput" stroke="#c63c73" strokeWidth={2.5} dot={false} /></LineChart></ResponsiveContainer></div> : <div className="empty-state chart-empty"><Activity size={29} /><p>Pokrenite sesiju za prikaz telemetrije.</p><span>Novi uzorak stiže svakih pet sekundi.</span></div>}{summary && <div className="summary-grid"><SummaryValue label="Worker-minute" value={summary.workerMinutes.toFixed(2)} /><SummaryValue label="CPU request jezgra-minute" value={summary.cpuRequestCoreMinutes.toFixed(2)} /><SummaryValue label="Memorija request MiB-minute" value={summary.memoryRequestMiBMinutes.toFixed(1)} /><SummaryValue label="Poslova / worker-minuti" value={summary.jobsPerWorkerMinute.toFixed(2)} /><SummaryValue label="Throughput" value={`${summary.averageThroughput.toFixed(2)} poslova/min`} /><SummaryValue label="Obrt prosjek / P95" value={`${formatDuration(summary.averageTurnaroundMs)} / ${formatDuration(summary.p95TurnaroundMs)}`} /><SummaryValue label="Čekanje prosjek / maksimum" value={`${formatDuration(summary.averageQueueWaitMs)} / ${formatDuration(summary.maximumQueueWaitMs)}`} /><SummaryValue label="Replike min / prosjek / maks" value={`${summary.minimumWorkers} / ${summary.averageWorkers.toFixed(2)} / ${summary.maximumWorkers}`} /><SummaryValue label="CPU u odnosu na request" value={`${summary.averageCapacityUtilizationPercent.toFixed(1)}%`} /><SummaryValue label="Neiskorišteni CPU kapacitet" value={`${summary.idleCapacityPercent.toFixed(1)}%`} /><SummaryValue label="CPU prosjek / maksimum" value={`${summary.averageWorkerCpuPercent.toFixed(1)}% / ${summary.maximumWorkerCpuPercent.toFixed(1)}%`} /><SummaryValue label="Memorija prosjek / maksimum" value={`${summary.averageWorkerMemoryMiB.toFixed(1)} / ${summary.maximumWorkerMemoryMiB.toFixed(1)} MiB`} /><SummaryValue label="Promjene broja replika" value={String(summary.scalingActions)} /><SummaryValue label="Scale-up reakcija" value={summary.scaleUpReactionMs === null ? "Nije zabilježena" : formatDuration(summary.scaleUpReactionMs)} /><SummaryValue label="Maksimalni red" value={summary.maximumQueueLength.toFixed(0)} /><SummaryValue label="Poslani / završeni / neuspješni" value={`${summary.submittedJobs} / ${summary.completedJobs} / ${summary.failedJobs}`} /><SummaryValue label="Nedovršeni poslovi" value={String(summary.incompleteJobs)} /><SummaryValue label="Stopa grešaka" value={`${(summary.failureRate * 100).toFixed(2)}%`} /><SummaryValue label="Ulaz / izlaz" value={`${formatBytes(summary.inputBytes)} / ${formatBytes(summary.outputBytes)}`} /><SummaryValue label="Procijenjeni trošak kapaciteta" value={summary.estimatedAllocatedCapacityCost === null ? "Stopa nije postavljena" : summary.estimatedAllocatedCapacityCost.toFixed(4)} /></div>}</div>

      <div className="experiment-side"><div className="surface session-control"><div className="surface-header"><div><h2>Upravljanje sesijom</h2><p>{running ? "Mjerenje je u toku" : "Definišite sljedeće mjerenje"}</p></div></div>{!running ? <div className="settings-form"><Field label="Naziv sesije"><input className="control" maxLength={80} onChange={(event) => onSessionName(event.target.value)} placeholder="Npr. Dynamic ramp 01" value={sessionName} /></Field><Field label="Profil opterećenja"><select className="control" onChange={(event) => onWorkloadProfile(event.target.value)} value={workloadProfile}><option value="low">Low</option><option value="high">High</option><option value="ramp">Ramp</option><option value="spike">Spike</option><option value="custom">Prilagođeni</option></select></Field><button className="button button-experiment" onClick={onStart} type="button"><Play size={16} />Pokreni sesiju</button></div> : <div className="running-session"><strong>{activeSession.name}</strong><span>{activeSession.workloadProfile} · od {formatDate(activeSession.startedAt)}</span><button className="button button-danger" onClick={onStop} type="button"><Square size={15} />Završi sesiju</button></div>}{activeSession && <div className="export-actions"><a className="button button-secondary" href={`${API_URL}/experiment/sessions/${activeSession.id}/export?format=json`}><Download size={14} />JSON</a><a className="button button-secondary" href={`${API_URL}/experiment/sessions/${activeSession.id}/export?format=csv`}><Download size={14} />CSV</a></div>}</div>
        <div className="surface previous-sessions"><div className="surface-header"><div><h2>Prethodne sesije</h2><p>{sessions.length} sačuvano</p></div></div><div className="session-list">{sessions.length ? sessions.map((session) => <button key={session.id} onClick={() => onLoadSession(session.id)} type="button"><div><p>{session.name}</p><span>{session.workloadProfile} · {formatDate(session.startedAt)}</span></div><ChevronRight size={16} /></button>) : <div className="empty-inline">Još nema sesija.</div>}</div></div></div>
    </div>
  </section>;
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) { return <button aria-current={active ? "page" : undefined} className={`nav-button ${active ? "is-active" : ""}`} onClick={onClick} type="button">{icon}<span>{label}</span></button>; }
function MetricCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) { return <div className="metric-item"><span className="metric-icon">{icon}</span><div><p>{label}</p><strong>{value}</strong></div></div>; }
function Field({ children, label }: { children: ReactNode; label: string }) { return <label className="field"><span>{label}</span>{children}</label>; }
function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: (value: boolean) => void }) { return <div className="toggle-row"><span>{label}</span><button aria-checked={checked} aria-label={label} className={`toggle ${checked ? "is-checked" : ""}`} disabled={disabled} onClick={() => onChange(!checked)} role="switch" type="button"><span /></button></div>; }
function StatusBadge({ status }: { status: BatchStatus }) { return <span className={`status-badge status-${status}`}>{batchStatusCopy[status]}</span>; }
function SummaryValue({ label, value }: { label: string; value: string }) { return <div className="summary-value"><p>{label}</p><strong>{value}</strong></div>; }
