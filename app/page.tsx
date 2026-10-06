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
  averageWorkers: number;
  maximumWorkers: number;
  averageThroughput: number;
  averageProcessingMs: number;
  medianProcessingMs: number;
  p95ProcessingMs: number;
  averageWorkerCpuPercent: number;
  maximumWorkerCpuPercent: number;
  averageWorkerMemoryMiB: number;
  maximumWorkerMemoryMiB: number;
  averageCapacityUtilizationPercent: number;
  completedJobs: number;
  failedJobs: number;
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
const POLICY_LABELS: Record<Metrics["deploymentPolicy"], string> = { STATIC: "S0 STATIČKA", CPU_HPA: "S1 CPU HPA", QUEUE_KEDA: "S2 RED / KEDA" };
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
  return new Intl.DateTimeFormat("bs-BA", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
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
    <main className="min-h-screen bg-[#f4f7f6] text-[#17201d]">
      <header className="sticky top-0 z-30 border-b border-[#dce4e1] bg-[#f8faf9]/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1480px] flex-wrap items-center justify-between gap-3 px-5 py-2 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-[#164b3d] text-white shadow-sm"><Layers3 size={19} /></div>
            <div><p className="text-[15px] font-bold">Cloud Media Processor</p><p className="text-xs text-[#70807a]">Priprema i eksperimentalna obrada medija</p></div>
          </div>
          <nav aria-label="Glavna navigacija" className="order-3 flex w-full items-center gap-1 rounded-lg bg-[#e9efec] p-1 sm:order-none sm:w-auto">
            <NavButton active={view === "processing"} icon={<SlidersHorizontal size={15} />} label="Obrada" onClick={() => setView("processing")} />
            <NavButton active={view === "history"} icon={<History size={15} />} label="Historija" onClick={() => setView("history")} />
            <NavButton active={view === "experiment"} icon={<Activity size={15} />} label="Eksperiment" onClick={() => setView("experiment")} />
          </nav>
          <span className="hidden items-center gap-2 text-xs font-medium text-[#5f7069] md:flex"><span className={`h-2 w-2 rounded-full ${apiOnline === null ? "bg-[#d6a33d]" : apiOnline ? "bg-[#31a779]" : "bg-[#d15f54]"}`} />{apiOnline === null ? "Provjera sistema" : apiOnline ? "Sistem dostupan" : "API nije dostupan"}</span>
        </div>
      </header>

      {message && <div className="mx-auto mt-5 flex max-w-[1416px] items-start justify-between gap-4 rounded-lg border border-[#efcfc8] bg-[#fff5f2] px-4 py-3 text-sm text-[#9b443b]"><span>{message}</span><button aria-label="Zatvori poruku" onClick={() => setMessage(null)} type="button"><X size={16} /></button></div>}

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

  return <div className="mx-auto grid max-w-[1480px] gap-6 px-5 py-7 lg:grid-cols-[minmax(0,1fr)_370px] lg:px-8">
    <section className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="mb-1 text-xs font-bold uppercase tracking-[0.14em] text-[#228666]">Radni prostor</p><h1 className="text-2xl font-bold sm:text-[30px]">Priprema medija u jednom prolazu</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[#66766f]">Optimizacija, konverzija, thumbnail, metapodaci i watermark izvršavaju se kao jedan batch pipeline.</p></div>{(files.length > 0 || batch) && <button className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-[#607169] hover:bg-[#e8eeeb]" onClick={onReset} type="button"><RotateCcw size={15} />Novi batch</button>}</div>

      {!batch && <div className={`relative overflow-hidden rounded-lg border-2 border-dashed bg-white px-6 py-10 text-center transition sm:py-12 ${isDragging ? "border-[#228666] bg-[#edf8f3]" : "border-[#cfdad6] hover:border-[#9db9ae]"}`} onDragEnter={() => onDragging(true)} onDragLeave={() => onDragging(false)} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
        <input accept="image/jpeg,image/png,image/webp" aria-label="Odaberi fotografije" className="absolute inset-0 cursor-pointer opacity-0" multiple onChange={handleInput} type="file" />
        <div className="pointer-events-none mx-auto mb-4 grid h-14 w-14 place-items-center rounded-lg bg-[#e4f2ec] text-[#176c52]"><UploadCloud size={26} /></div><p className="text-base font-bold">Prevucite fotografije ovdje ili kliknite za odabir</p><p className="mt-1.5 text-sm text-[#7b8983]">JPEG, PNG ili WebP · do 30 datoteka · najviše 15 MB po datoteci</p>
      </div>}

      <div className="overflow-hidden rounded-lg border border-[#dce4e1] bg-white shadow-[0_10px_30px_rgba(30,60,50,0.04)]">
        <div className="flex items-center justify-between border-b border-[#e4eae7] px-5 py-4"><div><h2 className="font-bold">{batch?.name ?? "Datoteke za obradu"}</h2><p className="mt-0.5 text-xs text-[#7a8983]">{batch ? `${batch.fileCount} datoteka · ${batchStatusCopy[batch.status]}` : `${files.length} od 30 datoteka`}</p></div>{batch?.downloadUrl && <a className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#e9f4ef] px-3 text-sm font-bold text-[#1d7459]" href={`${API_URL}${batch.downloadUrl}`}><FileArchive size={16} />ZIP</a>}</div>
        {!batch && files.length === 0 ? <div className="grid min-h-44 place-items-center px-6 py-10 text-center"><div><ImageIcon className="mx-auto mb-3 text-[#a9b8b2]" size={26} /><p className="text-sm font-semibold text-[#596a63]">Odabrane fotografije će se pojaviti ovdje</p></div></div> :
          <div className="divide-y divide-[#edf1ef]">{batch ? rows.map((job) => <JobRow job={job} key={job.id} />) : files.map((item) => <div className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-4 px-5 py-3.5" key={item.id}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="" className="h-12 w-12 rounded-lg bg-[#eef2f0] object-cover" src={item.preview} /><div className="min-w-0"><p className="truncate text-sm font-bold">{item.file.name}</p><p className="mt-1 text-xs text-[#7a8983]">{formatBytes(item.file.size)}</p></div><button aria-label={`Ukloni ${item.file.name}`} className="grid h-9 w-9 place-items-center rounded-lg text-[#89968f] hover:bg-[#fff0ed] hover:text-[#a94c43]" onClick={() => removeFile(item.id)} type="button"><Trash2 size={16} /></button></div>)}</div>}
      </div>

      {batch && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><MetricCard icon={<Archive size={17} />} label="Ulazni podaci" value={formatBytes(batch.stats.inputBytes)} /><MetricCard icon={<Download size={17} />} label="Izlazni podaci" value={formatBytes(batch.stats.outputBytes)} /><MetricCard icon={<Sparkles size={17} />} label="Ušteda prostora" value={`${batch.stats.savingsPercent}%`} /><MetricCard icon={<Clock3 size={17} />} label="Trajanje batcha" value={formatDuration(batch.stats.durationMs)} /><MetricCard icon={<Gauge size={17} />} label="Prosječna obrada" value={formatDuration(batch.stats.averageProcessingMs)} /><MetricCard icon={<X size={17} />} label="Greške" value={String(batch.stats.failed)} /></div>}
    </section>

    <aside className="space-y-5 lg:sticky lg:top-[88px] lg:self-start">
      <div className="rounded-lg border border-[#dce4e1] bg-white p-5 shadow-[0_10px_30px_rgba(30,60,50,0.04)]">
        <div className="mb-5 flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-lg bg-[#edf4f1] text-[#286d58]"><ServerCog size={18} /></div><div><h2 className="font-bold">Postavke pipelinea</h2><p className="text-xs text-[#7b8983]">Primjenjuju se na cijeli batch</p></div></div>
        <div className="space-y-4">
          <Field label="Naziv batcha"><input className="control" disabled={Boolean(batch)} maxLength={80} onChange={(event) => onBatchName(event.target.value)} placeholder="Npr. Proizvodi - septembar" value={batchName} /></Field>
          <Field label={`Profil${profileModified ? " · izmijenjen" : ""}`}><select className="control" disabled={Boolean(batch)} onChange={(event) => chooseProfile(event.target.value)} value={selectedProfile}><option value="webshop">Web shop</option><option value="blog">Blog</option><option value="social">Društvene mreže</option><option value="custom">Prilagođene postavke</option></select></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Format"><select className="control" disabled={Boolean(batch)} onChange={(event) => updateOption("format", event.target.value as ProcessingOptions["format"])} value={options.format}><option value="webp">WebP</option><option value="jpeg">JPEG</option><option value="png">PNG</option></select></Field><Field label="Širina"><input className="control" disabled={Boolean(batch)} max={8000} min={200} onChange={(event) => updateOption("width", Number(event.target.value))} type="number" value={options.width} /></Field></div>
          <Field label={`Kvalitet · ${options.quality}%`}><input aria-label="Kvalitet slike" className="range-control w-full" disabled={Boolean(batch)} max={95} min={35} onChange={(event) => updateOption("quality", Number(event.target.value))} type="range" value={options.quality} /></Field>
          <Toggle checked={options.keepAspectRatio} disabled={Boolean(batch)} label="Zadrži proporcije" onChange={(value) => updateOption("keepAspectRatio", value)} />
          <Toggle checked={options.thumbnailEnabled} disabled={Boolean(batch)} label="Generiši thumbnail" onChange={(value) => updateOption("thumbnailEnabled", value)} />
          {options.thumbnailEnabled && <Field label="Širina thumbnaila"><input className="control" disabled={Boolean(batch)} max={1200} min={80} onChange={(event) => updateOption("thumbnailWidth", Number(event.target.value))} type="number" value={options.thumbnailWidth} /></Field>}
          <Toggle checked={options.stripMetadata} disabled={Boolean(batch)} label="Ukloni EXIF i metapodatke" onChange={(value) => updateOption("stripMetadata", value)} />
          <Toggle checked={options.watermarkEnabled} disabled={Boolean(batch)} label="Tekstualni watermark" onChange={(value) => updateOption("watermarkEnabled", value)} />
          {options.watermarkEnabled && <div className="space-y-3 border-l-2 border-[#dce7e2] pl-3"><Field label="Tekst"><input className="control" disabled={Boolean(batch)} maxLength={80} onChange={(event) => updateOption("watermarkText", event.target.value)} value={options.watermarkText} /></Field><Field label="Pozicija"><select className="control" disabled={Boolean(batch)} onChange={(event) => updateOption("watermarkPosition", event.target.value)} value={options.watermarkPosition}><option value="northwest">Gore lijevo</option><option value="north">Gore</option><option value="northeast">Gore desno</option><option value="center">Sredina</option><option value="southwest">Dolje lijevo</option><option value="south">Dolje</option><option value="southeast">Dolje desno</option></select></Field><Field label={`Transparentnost · ${Math.round(options.watermarkOpacity * 100)}%`}><input className="range-control w-full" disabled={Boolean(batch)} max={100} min={5} onChange={(event) => updateOption("watermarkOpacity", Number(event.target.value) / 100)} type="range" value={Math.round(options.watermarkOpacity * 100)} /></Field></div>}
        </div>
        <button className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#164b3d] px-4 text-sm font-bold text-white transition hover:bg-[#0f3e32] disabled:cursor-not-allowed disabled:opacity-45" disabled={!files.length || isSubmitting || Boolean(batch)} onClick={onStart} type="button">{isSubmitting ? <LoaderCircle className="animate-spin" size={18} /> : <CloudUpload size={18} />}{batch ? "Obrada je pokrenuta" : `Obradi ${files.length || ""} ${files.length === 1 ? "fotografiju" : "fotografija"}`}{!isSubmitting && !batch && <ChevronRight size={17} />}</button>
      </div>
    </aside>
  </div>;
}

function JobRow({ job }: { job: ApiJob }) {
  return <div className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-4 px-5 py-3.5"><div className="grid h-10 w-10 place-items-center rounded-lg bg-[#edf3f0] text-[#668078]"><FileImage size={18} /></div><div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-sm font-bold">{job.fileName}</p>{job.status === "completed" && <Check className="shrink-0 text-[#228666]" size={15} />}</div><div className="mt-1 flex flex-wrap gap-x-3 text-xs text-[#7a8983]"><span>{formatBytes(job.originalBytes)}</span><span className="font-semibold text-[#4c655b]">{statusCopy[job.status]}</span>{job.totalOutputBytes !== undefined && <span>→ {formatBytes(job.totalOutputBytes)}</span>}{job.startedAt && job.finishedAt && <span>{formatDuration(job.finishedAt - job.startedAt)}</span>}</div>{job.status === "active" && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#e7eeeb]"><div className="h-full rounded-full bg-[#2b8e6e]" style={{ width: `${job.progress}%` }} /></div>}{job.error && <p className="mt-1 text-xs text-[#a74b43]">{job.error}</p>}</div>{job.downloadUrl && <a aria-label={`Preuzmi ${job.fileName}`} className="grid h-9 w-9 place-items-center rounded-lg text-[#1d7459] hover:bg-[#eaf5f0]" href={`${API_URL}${job.downloadUrl}`}><ArrowDownToLine size={17} /></a>}</div>;
}

function HistoryView({ batches, loading, onOpen, onRefresh }: { batches: BatchSummary[]; loading: boolean; onOpen: (id: string) => void; onRefresh: () => void }) {
  return <section className="mx-auto max-w-[1416px] px-5 py-7 lg:px-8"><div className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><p className="mb-1 text-xs font-bold uppercase tracking-[0.14em] text-[#228666]">Redis historija</p><h1 className="text-2xl font-bold sm:text-[30px]">Batch obrade</h1><p className="mt-2 text-sm text-[#66766f]">Ponovo otvorite rezultat ili preuzmite sve izlazne datoteke kao ZIP.</p></div><button aria-label="Osvježi historiju" className="grid h-10 w-10 place-items-center rounded-lg border border-[#dce4e1] bg-white text-[#476259]" onClick={onRefresh} type="button"><RefreshCw className={loading ? "animate-spin" : ""} size={17} /></button></div>
    <div className="overflow-hidden rounded-lg border border-[#dce4e1] bg-white"><div className="hidden grid-cols-[minmax(220px,1.5fr)_150px_100px_120px_120px_80px] gap-4 border-b border-[#e4eae7] bg-[#f8faf9] px-5 py-3 text-xs font-bold uppercase text-[#76857f] md:grid"><span>Batch</span><span>Status</span><span>Datoteke</span><span>Ulaz / izlaz</span><span>Trajanje</span><span /></div>{batches.length === 0 ? <div className="grid min-h-52 place-items-center text-center text-sm text-[#718079]">{loading ? "Učitavanje historije..." : "Još nema sačuvanih batch obrada."}</div> : <div className="divide-y divide-[#edf1ef]">{batches.map((batch) => <div className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(220px,1.5fr)_150px_100px_120px_120px_80px] md:items-center md:gap-4" key={batch.batchId}><div className="min-w-0"><p className="truncate text-sm font-bold">{batch.name}</p><p className="mt-1 text-xs text-[#7a8983]">{formatDate(batch.createdAt)} · {PROFILE_LABELS[batch.profile] ?? batch.profile}</p></div><StatusBadge status={batch.status} /><p className="text-sm"><span className="text-[#7a8983] md:hidden">Datoteke: </span>{batch.stats.completed}/{batch.fileCount}</p><p className="text-xs text-[#65756e]">{formatBytes(batch.stats.inputBytes)}<br />{formatBytes(batch.stats.outputBytes)} ({batch.stats.savingsPercent}%)</p><p className="text-sm">{formatDuration(batch.stats.durationMs)}</p><div className="flex gap-1"><button aria-label={`Otvori ${batch.name}`} className="grid h-9 w-9 place-items-center rounded-lg text-[#1d7459] hover:bg-[#eaf5f0]" onClick={() => onOpen(batch.batchId)} type="button"><ExternalLink size={16} /></button>{batch.downloadUrl && <a aria-label={`Preuzmi ${batch.name}`} className="grid h-9 w-9 place-items-center rounded-lg text-[#1d7459] hover:bg-[#eaf5f0]" href={`${API_URL}${batch.downloadUrl}`}><FileArchive size={16} /></a>}</div></div>)}</div>}</div>
  </section>;
}

function ExperimentView({ activeSession, metrics, sessionName, sessions, workloadProfile, onLoadSession, onSessionName, onStart, onStop, onWorkloadProfile }: { activeSession: ExperimentSession | null; metrics: Metrics | null; sessionName: string; sessions: ExperimentSession[]; workloadProfile: string; onLoadSession: (id: string) => void; onSessionName: (value: string) => void; onStart: () => void; onStop: () => void; onWorkloadProfile: (value: string) => void }) {
  const running = activeSession?.status === "active";
  const samples = activeSession?.samples ?? [];
  const summary = activeSession?.summary;
  return <section className="mx-auto max-w-[1416px] space-y-6 px-5 py-7 lg:px-8"><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="mb-1 text-xs font-bold uppercase tracking-[0.14em] text-[#228666]">Stvarni podaci sistema</p><h1 className="text-2xl font-bold sm:text-[30px]">Eksperimentalni dashboard</h1><p className="mt-2 text-sm text-[#66766f]">Vrijednosti dolaze iz Redis reda, BullMQ događaja i heartbeat zapisa aktivnih workera.</p></div><span className={`rounded-lg px-3 py-2 text-xs font-bold ${metrics?.deploymentPolicy === "STATIC" ? "bg-[#e8ecef] text-[#43515b]" : "bg-[#dff3ea] text-[#176b51]"}`}>POLITIKA: {metrics ? POLICY_LABELS[metrics.deploymentPolicy] : "-"}</span></div>

    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><MetricCard icon={<Clock3 size={17} />} label="Dužina reda" value={String(metrics?.queueLength ?? "-")} /><MetricCard icon={<Activity size={17} />} label="Aktivni poslovi" value={String(metrics?.activeJobs ?? "-")} /><MetricCard icon={<Users size={17} />} label="Aktivni workeri" value={String(metrics?.activeWorkers ?? "-")} /><MetricCard icon={<Gauge size={17} />} label="Throughput / 60 s" value={String(metrics?.throughputLast60Seconds ?? "-")} /><MetricCard icon={<Cpu size={17} />} label="Prosječni CPU workera" value={metrics ? `${metrics.averageWorkerCpuPercent.toFixed(1)}%` : "-"} /><MetricCard icon={<MemoryStick size={17} />} label="Prosječna memorija workera" value={metrics ? formatBytes(metrics.averageWorkerMemoryBytes) : "-"} /><MetricCard icon={<Cpu size={17} />} label="Alocirani CPU" value={metrics ? `${metrics.allocatedCpuCores.toFixed(2)} jezgri` : "-"} /><MetricCard icon={<MemoryStick size={17} />} label="Alocirana memorija" value={metrics ? `${metrics.allocatedMemoryMiB.toFixed(0)} MiB` : "-"} /><MetricCard icon={<Check size={17} />} label="Završeni poslovi" value={String(metrics?.completedJobs ?? "-")} /><MetricCard icon={<X size={17} />} label="Neuspješni poslovi" value={String(metrics?.failedJobs ?? "-")} /><MetricCard icon={<Clock3 size={17} />} label="Prosječna / P95 obrada" value={metrics ? `${formatDuration(metrics.averageProcessingMs)} / ${formatDuration(metrics.p95ProcessingMs)}` : "-"} /><MetricCard icon={<Clock3 size={17} />} label="Prosječno čekanje" value={formatDuration(metrics?.averageQueueWaitMs)} /><MetricCard icon={<Archive size={17} />} label="Obrađeni podaci" value={metrics ? formatBytes(metrics.processedBytes) : "-"} /></div>

    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]"><div className="rounded-lg border border-[#dce4e1] bg-white p-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-bold">Tekuća sesija</h2><p className="mt-1 text-xs text-[#7a8983]">Red, workeri i throughput iz stvarnih uzoraka</p></div>{running && <span className="inline-flex items-center gap-2 text-xs font-bold text-[#1d7459]"><span className="h-2 w-2 rounded-full bg-[#31a779]" />AKTIVNA</span>}</div>{samples.length > 1 ? <div className="h-72 w-full"><ResponsiveContainer><LineChart data={samples}><XAxis dataKey="timestamp" tickFormatter={(value) => new Date(value).toLocaleTimeString("bs-BA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} minTickGap={30} tick={{ fontSize: 11 }} /><YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} /><Tooltip labelFormatter={(value) => formatDate(Number(value))} /><Line dataKey="queueLength" name="Red" stroke="#c47a32" strokeWidth={2} dot={false} /><Line dataKey="activeWorkers" name="Workeri" stroke="#228666" strokeWidth={2} dot={false} /><Line dataKey="throughputLast60Seconds" name="Throughput" stroke="#516f9a" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer></div> : <div className="grid h-72 place-items-center text-center text-sm text-[#78877f]">Pokrenite sesiju da se prikažu stvarni uzorci.</div>}{summary && <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[#e6ece9] pt-4 text-sm sm:grid-cols-3"><SummaryValue label="Worker-minute" value={summary.workerMinutes.toFixed(2)} /><SummaryValue label="CPU request jezgra-minute" value={summary.cpuRequestCoreMinutes.toFixed(2)} /><SummaryValue label="Memorija request MiB-minute" value={summary.memoryRequestMiBMinutes.toFixed(1)} /><SummaryValue label="Poslova / worker-minuti" value={summary.jobsPerWorkerMinute.toFixed(2)} /><SummaryValue label="CPU u odnosu na request" value={`${summary.averageCapacityUtilizationPercent.toFixed(1)}%`} /><SummaryValue label="CPU prosjek / maksimum" value={`${summary.averageWorkerCpuPercent.toFixed(1)}% / ${summary.maximumWorkerCpuPercent.toFixed(1)}%`} /><SummaryValue label="Memorija prosjek / maksimum" value={`${summary.averageWorkerMemoryMiB.toFixed(1)} / ${summary.maximumWorkerMemoryMiB.toFixed(1)} MiB`} /><SummaryValue label="Promjene broja replika" value={String(summary.scalingActions)} /><SummaryValue label="Scale-up reakcija" value={summary.scaleUpReactionMs === null ? "Nije zabilježena" : formatDuration(summary.scaleUpReactionMs)} /><SummaryValue label="Maksimalni red" value={summary.maximumQueueLength.toFixed(0)} /><SummaryValue label="Završeni / neuspješni" value={`${summary.completedJobs} / ${summary.failedJobs}`} /><SummaryValue label="Procijenjeni trošak alociranog kapaciteta" value={summary.estimatedAllocatedCapacityCost === null ? "Stopa nije postavljena" : summary.estimatedAllocatedCapacityCost.toFixed(4)} /></div>}</div>

      <div className="space-y-5"><div className="rounded-lg border border-[#dce4e1] bg-white p-5"><h2 className="font-bold">Upravljanje sesijom</h2>{!running ? <div className="mt-4 space-y-4"><Field label="Naziv sesije"><input className="control" maxLength={80} onChange={(event) => onSessionName(event.target.value)} placeholder="Npr. Dynamic ramp 01" value={sessionName} /></Field><Field label="Profil opterećenja"><select className="control" onChange={(event) => onWorkloadProfile(event.target.value)} value={workloadProfile}><option value="low">Low</option><option value="high">High</option><option value="ramp">Ramp</option><option value="spike">Spike</option><option value="custom">Prilagođeni</option></select></Field><button className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#164b3d] text-sm font-bold text-white" onClick={onStart} type="button"><Play size={16} />Pokreni sesiju</button></div> : <div className="mt-4"><p className="text-sm font-bold">{activeSession.name}</p><p className="mt-1 text-xs text-[#77867f]">{activeSession.workloadProfile} · od {formatDate(activeSession.startedAt)}</p><button className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#9b443b] text-sm font-bold text-white" onClick={onStop} type="button"><Square size={15} />Završi sesiju</button></div>}{activeSession && <div className="mt-3 grid grid-cols-2 gap-2"><a className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[#edf4f1] text-xs font-bold text-[#216f57]" href={`${API_URL}/experiment/sessions/${activeSession.id}/export?format=json`}><Download size={14} />JSON</a><a className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[#edf4f1] text-xs font-bold text-[#216f57]" href={`${API_URL}/experiment/sessions/${activeSession.id}/export?format=csv`}><Download size={14} />CSV</a></div>}</div>
        <div className="rounded-lg border border-[#dce4e1] bg-white p-5"><h2 className="mb-3 font-bold">Prethodne sesije</h2><div className="max-h-64 divide-y divide-[#edf1ef] overflow-auto">{sessions.length ? sessions.map((session) => <button className="flex w-full items-center justify-between gap-3 py-3 text-left" key={session.id} onClick={() => onLoadSession(session.id)} type="button"><div className="min-w-0"><p className="truncate text-sm font-bold">{session.name}</p><p className="mt-0.5 text-xs text-[#7a8983]">{session.workloadProfile} · {formatDate(session.startedAt)}</p></div><ChevronRight className="shrink-0 text-[#84928c]" size={16} /></button>) : <p className="py-5 text-sm text-[#7a8983]">Još nema sesija.</p>}</div></div></div>
    </div>
  </section>;
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) { return <button aria-current={active ? "page" : undefined} className={`inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm font-bold transition sm:flex-none ${active ? "bg-white text-[#164b3d] shadow-sm" : "text-[#687872] hover:text-[#243b33]"}`} onClick={onClick} type="button">{icon}{label}</button>; }
function MetricCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) { return <div className="flex min-h-20 items-center gap-3 rounded-lg border border-[#dce4e1] bg-white px-4 py-3.5"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#e9f4ef] text-[#24795e]">{icon}</div><div className="min-w-0"><p className="text-[11px] font-semibold uppercase text-[#829089]">{label}</p><p className="mt-0.5 break-words text-base font-bold">{value}</p></div></div>; }
function Field({ children, label }: { children: ReactNode; label: string }) { return <label className="block"><span className="mb-1.5 block text-xs font-bold text-[#566760]">{label}</span>{children}</label>; }
function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: (value: boolean) => void }) { return <div className="flex items-center justify-between gap-4 rounded-lg bg-[#f4f7f6] p-3"><span className="text-sm font-semibold">{label}</span><button aria-checked={checked} aria-label={label} className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? "bg-[#238666]" : "bg-[#c8d2ce]"}`} disabled={disabled} onClick={() => onChange(!checked)} role="switch" type="button"><span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition ${checked ? "left-6" : "left-1"}`} /></button></div>; }
function StatusBadge({ status }: { status: BatchStatus }) { return <span className={`w-fit rounded-md px-2 py-1 text-xs font-bold ${status === "completed" ? "bg-[#e3f3eb] text-[#1d7459]" : status === "failed" ? "bg-[#fff0ed] text-[#a74b43]" : "bg-[#f8edda] text-[#8c6128]"}`}>{batchStatusCopy[status]}</span>; }
function SummaryValue({ label, value }: { label: string; value: string }) { return <div><p className="text-xs text-[#7a8983]">{label}</p><p className="mt-1 font-bold">{value}</p></div>; }
