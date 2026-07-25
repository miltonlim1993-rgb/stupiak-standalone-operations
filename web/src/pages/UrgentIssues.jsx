import { useEffect, useMemo, useRef, useState } from "react";
import { opsClient } from "@/api/opsClient";
import { useAuth } from "@/lib/AuthContext";
import {
  ROLES,
  ROLE_LABELS,
  ISSUE_STATUS_LABELS,
  ISSUE_STATUS_CLASSES,
  canManage,
} from "@/lib/ops-helpers";
import {
  Plus,
  Search,
  AlertTriangle,
  CheckCircle2,
  Siren,
  Loader2,
  ArrowUpCircle,
  Camera,
  Images,
  Image as ImageIcon,
  Trash2,
  UploadCloud,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import MobileSheet from "@/components/MobileSheet";
import MediaLightbox from "@/components/MediaLightbox";
import PageNotifications from "@/components/PageNotifications";
import { clearMediaDrafts, createMediaDraftId, listMediaDrafts, removeMediaDraft, saveMediaDraft } from "@/lib/media-drafts";
import { acceptAttribute, acceptsFile, mediaRuleLabel, resolveMediaRule } from "@/lib/media-rules";

const PRIORITY_META = {
  high: { label: "High", icon: ArrowUpCircle, badge: "border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200", iconBox: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300" },
  urgent: { label: "Urgent", icon: AlertTriangle, badge: "border-red-200 bg-red-100 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200", iconBox: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" },
  critical: { label: "Critical", icon: Siren, badge: "border-red-700 bg-red-600 text-white", iconBox: "bg-red-600 text-white" },
};
const CATEGORIES = ["equipment", "staffing", "food_safety", "customer", "supplier", "facility", "other"];
const FILTERS = ["open", "in_progress", "resolved"];
const ISSUE_META_PREFIX = "CHEFOPS_ISSUE_META_V1:";

function localIssueDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeIssue(issue) {
  return {
    ...issue,
    status: String(issue?.status || "open").trim().toLowerCase() || "open",
    priority: String(issue?.priority || "urgent").trim().toLowerCase() || "urgent",
  };
}

function PriorityBadge({ priority }) {
  const meta = PRIORITY_META[priority] || PRIORITY_META.urgent;
  const Icon = meta.icon;
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold ${meta.badge}`}><Icon className="h-3 w-3" />{meta.label}</span>;
}

function parseIssueMeta(value) {
  const raw = String(value || "");
  if (!raw.startsWith(ISSUE_META_PREFIX)) return { note: raw, media: [], reported_by: "", reported_at: "" };
  try {
    const parsed = JSON.parse(raw.slice(ISSUE_META_PREFIX.length));
    return {
      note: String(parsed?.note || ""),
      media: Array.isArray(parsed?.media) ? parsed.media : Array.isArray(parsed?.photos) ? parsed.photos : [],
      reported_by: String(parsed?.reported_by || ""),
      reported_at: String(parsed?.reported_at || ""),
    };
  } catch {
    return { note: "", media: [], reported_by: "", reported_at: "" };
  }
}

function issueMetaText(meta) {
  return `${ISSUE_META_PREFIX}${JSON.stringify({
    note: String(meta?.note || ""),
    media: Array.isArray(meta?.media) ? meta.media : [],
    reported_by: String(meta?.reported_by || ""),
    reported_at: String(meta?.reported_at || ""),
  })}`;
}

function isVideoMedia(item) {
  return String(item?.mime_type || "").toLowerCase().startsWith("video/");
}

export default function UrgentIssues() {
  const { user } = useAuth();
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("open");
  const [search, setSearch] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mediaRules, setMediaRules] = useState([]);

  useEffect(() => {
    loadIssues();
  }, []);

  useEffect(() => {
    opsClient.entities.MediaRule.filter({ module: "urgent_issue" }, "outlet_id", 50)
      .then(setMediaRules)
      .catch(() => setMediaRules([]));
  }, [user?.outlet_id]);

  const loadIssues = async () => {
    try {
      const year = new Date().getFullYear();
      const list = await opsClient.entities.UrgentIssue.filter({}, "-created_date", 100, { year });
      setIssues((list || []).map(normalizeIssue));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (id, newStatus) => {
    const updates = { status: newStatus };
    if (newStatus === "resolved") updates.resolved_date = new Date().toISOString();
    try {
      await opsClient.entities.UrgentIssue.update(id, updates);
      setIssues((prev) => prev.map((issue) => (issue.id === id ? { ...issue, ...updates } : issue)));
    } catch (err) {
      console.error(err);
    }
  };


  const removeIssueMedia = async (issue, index) => {
    if (!window.confirm("Delete this issue attachment?")) return;
    const meta = parseIssueMeta(issue.followup_notes);
    const nextMedia = meta.media.filter((_, itemIndex) => itemIndex !== index);
    const followup_notes = issueMetaText({ ...meta, media: nextMedia });
    try {
      const year = Number(String(issue.due_date || localIssueDate()).slice(0, 4));
      const updated = await opsClient.entities.UrgentIssue.update(issue.id, { followup_notes }, { year });
      setIssues((current) => current.map((row) => row.id === issue.id ? normalizeIssue({ ...row, ...updated, followup_notes }) : row));
    } catch (err) {
      console.error(err);
    }
  };

  const statusFiltered = filter === "open"
    ? issues.filter((issue) => issue.status === "open" || issue.status === "escalated")
    : issues.filter((issue) => issue.status === filter);
  const issueRule = resolveMediaRule(mediaRules, "urgent_issue", user?.outlet_id || "");
  const term = search.trim().toLowerCase();
  const filtered = term
    ? statusFiltered.filter((issue) => `${issue.title || ""} ${issue.description || ""} ${issue.category || ""} ${issue.priority || ""} ${issue.assigned_to_role || ""}`.toLowerCase().includes(term))
    : statusFiltered;

  return (
    <div className="chefops-page urgent-page mx-auto max-w-lg space-y-4 p-4 pb-24">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-heading font-bold">Urgent Issues</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Report a problem with on-site photos and assign it immediately.</p>
        </div>
        <Button size="sm" className="h-9 rounded-xl px-3" onClick={() => setDrawerOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> Report
        </Button>
      </div>

      <PageNotifications page="/urgent" limit={2} />

      <div className="chefops-sticky-tools chefops-issues-toolbar space-y-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search issue, category or assignee" className="h-10 pl-9" />
        </div>
        <div className="chefops-hide-scrollbar flex gap-2 overflow-x-auto pb-0.5">
          {FILTERS.map((item) => (
            <button
              key={item}
              onClick={() => setFilter(item)}
              className={`whitespace-nowrap rounded-full px-3 py-2 text-xs font-medium transition-colors ${
                filter === item ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}
            >
              {ISSUE_STATUS_LABELS[item]}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-12 text-center">
          <CheckCircle2 className="mx-auto mb-2 h-10 w-10 text-emerald-500" />
          <p className="text-sm text-muted-foreground">No issues here. 🎉</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              onStatusChange={updateStatus}
              managerAccess={canManage(user?.role)}
              canEditMedia={canManage(user?.role) || String(issue.created_by || "").toLowerCase() === String(user?.email || "").toLowerCase()}
              onRemoveMedia={(index) => removeIssueMedia(issue, index)}
            />
          ))}
        </div>
      )}

      <MobileSheet
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Report urgent issue"
        description={`Add details and up to ${issueRule.max_files} ${mediaRuleLabel(issueRule)}. Rules are controlled by Sheet.`}
      >
        <IssueForm
          user={user}
          mediaRule={issueRule}
          onCancel={() => setDrawerOpen(false)}
          onDone={(created) => {
            setDrawerOpen(false);
            setFilter("open");
            if (created) setIssues((current) => [normalizeIssue(created), ...current.filter((item) => item.id !== created.id)]);
            window.setTimeout(() => loadIssues(), 250);
          }}
        />
      </MobileSheet>
    </div>
  );
}

function IssueCard({ issue, onStatusChange, managerAccess, canEditMedia, onRemoveMedia }) {
  const meta = parseIssueMeta(issue.followup_notes);
  const [activeMedia, setActiveMedia] = useState(null);
  const priorityMeta = PRIORITY_META[issue.priority] || PRIORITY_META.urgent;
  const PriorityIcon = priorityMeta.icon;
  return (
    <div className={`rounded-2xl border bg-card p-3.5 ${
      issue.priority === "critical"
        ? "border-red-500"
        : issue.status === "open"
          ? "border-red-200 dark:border-red-900"
          : "border-border"
    }`}>
      <div className="flex items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${priorityMeta.iconBox}`}><PriorityIcon className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{issue.title}</p>
          {issue.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{issue.description}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <PriorityBadge priority={issue.priority} />
            <span className={`rounded-full px-2 py-1 text-[10px] ${ISSUE_STATUS_CLASSES[issue.status]}`}>
              {ISSUE_STATUS_LABELS[issue.status]}
            </span>
            {issue.assigned_to_role ? <span className="text-xs capitalize text-muted-foreground">→ {issue.assigned_to_role}</span> : null}
            <span className="text-xs capitalize text-muted-foreground">{String(issue.category || "other").replace("_", " ")}</span>
          </div>
        </div>
      </div>

      {meta.media.length > 0 ? (
        <div className={`mt-3 grid gap-2 ${meta.media.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
          {meta.media.map((item, index) => {
            const video = isVideoMedia(item);
            const src = item.file_url || item.view_url;
            return (
              <div key={`${item.drive_file_id || item.file_url}-${index}`} className="group relative overflow-hidden rounded-xl border border-border bg-muted">
                <button
                  type="button"
                  onClick={() => setActiveMedia({
                    src,
                    title: `${issue.title || 'Urgent issue'} · ${video ? 'Video' : 'Photo'} ${index + 1}`,
                    type: video ? 'video' : 'image',
                  })}
                  className="relative block w-full text-left"
                >
                  {video ? (
                    <div className="relative">
                      <video src={src} muted preload="metadata" className="h-28 w-full object-cover" />
                      <span className="absolute inset-0 flex items-center justify-center"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/65 text-white"><Play className="h-5 w-5 fill-current" /></span></span>
                    </div>
                  ) : (
                    <img src={src} alt={`Issue evidence ${index + 1}`} className="h-28 w-full object-cover transition group-active:scale-[0.98]" />
                  )}
                  <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/65 px-2 py-1 text-[10px] text-white">
                    {video ? 'Video' : 'Photo'} {index + 1}
                  </span>
                </button>
                {canEditMedia ? (
                  <button
                    type="button"
                    onClick={() => onRemoveMedia(index)}
                    className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-white"
                    aria-label={`Delete ${video ? 'video' : 'photo'} ${index + 1}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <MediaLightbox
        open={Boolean(activeMedia)}
        onOpenChange={(open) => { if (!open) setActiveMedia(null); }}
        src={activeMedia?.src || ""}
        title={activeMedia?.title || "Issue evidence"}
        type={activeMedia?.type || "image"}
      />

      {meta.note ? <p className="mt-2 text-xs italic text-muted-foreground">“{meta.note}”</p> : null}

      {managerAccess && issue.status !== "resolved" ? (
        <div className="mt-3 flex gap-2 pl-[52px]">
          {issue.status === "open" ? (
            <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => onStatusChange(issue.id, "in_progress")}>
              Start
            </Button>
          ) : null}
          {issue.status === "in_progress" ? (
            <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => onStatusChange(issue.id, "escalated")}>
              <ArrowUpCircle className="mr-1 h-3 w-3" /> Escalate
            </Button>
          ) : null}
          <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs text-emerald-600" onClick={() => onStatusChange(issue.id, "resolved")}>
            <CheckCircle2 className="mr-1 h-3 w-3" /> Resolve
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function issueDraftStorageKey(user) {
  return `chefops.issue-draft.v1:${String(user?.email || 'user').toLowerCase()}:${String(user?.outlet_id || 'outlet')}`;
}

function defaultIssueForm(user) {
  try {
    const parsed = JSON.parse(localStorage.getItem(issueDraftStorageKey(user)) || 'null');
    if (parsed && typeof parsed === 'object') {
      return {
        title: String(parsed.title || ''),
        description: String(parsed.description || ''),
        priority: String(parsed.priority || 'urgent'),
        category: String(parsed.category || 'other'),
        assigned_to_role: String(parsed.assigned_to_role || 'supervisor'),
      };
    }
  } catch {}
  return { title: '', description: '', priority: 'urgent', category: 'other', assigned_to_role: 'supervisor' };
}

function IssueForm({ user, mediaRule, onCancel, onDone }) {
  const [form, setForm] = useState(() => defaultIssueForm(user));
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);
  const scopeKey = `urgent-issue:${String(user?.email || 'user').toLowerCase()}:${String(user?.outlet_id || 'outlet')}`;
  const maxFiles = Math.max(1, Number(mediaRule?.max_files || 4));
  const maxBytes = Math.max(1, Number(mediaRule?.max_file_mb || 10)) * 1024 * 1024;
  const captureMode = String(mediaRule?.capture_mode || 'CAMERA_AND_GALLERY').toUpperCase();
  const showCamera = captureMode !== 'GALLERY_ONLY';
  const showGallery = captureMode !== 'CAMERA_ONLY';
  const accepted = acceptAttribute(mediaRule);

  useEffect(() => {
    let cancelled = false;
    listMediaDrafts({ module: 'urgent_issue', scopeKey })
      .then((rows) => { if (!cancelled) setFiles(rows); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [scopeKey]);

  useEffect(() => {
    try { localStorage.setItem(issueDraftStorageKey(user), JSON.stringify(form)); } catch {}
  }, [form, user?.email, user?.outlet_id]);

  const previews = useMemo(() => files.map((entry) => ({
    entry,
    url: entry.file ? URL.createObjectURL(entry.file) : entry.meta?.uploaded?.file_url || entry.meta?.uploaded?.view_url || '',
  })), [files]);
  useEffect(() => () => previews.forEach((preview) => { if (preview.entry.file && preview.url) URL.revokeObjectURL(preview.url); }), [previews]);

  const addFiles = async (incoming) => {
    setError('');
    const candidates = Array.from(incoming || []);
    const invalidType = candidates.find((file) => !acceptsFile(mediaRule, file));
    if (invalidType) {
      setError(`Only ${mediaRuleLabel(mediaRule)} allowed by the Sheet can be attached.`);
      return;
    }
    const tooLarge = candidates.find((file) => file.size > maxBytes);
    if (tooLarge) {
      setError(`${tooLarge.name} is larger than ${mediaRule.max_file_mb || 10} MB.`);
      return;
    }
    const room = Math.max(0, maxFiles - files.length);
    if (!room) {
      setError(`A maximum of ${maxFiles} attachment${maxFiles === 1 ? '' : 's'} is allowed.`);
      return;
    }
    const existingKeys = new Set(files.map((entry) => `${entry.file_name}:${entry.file_size}:${entry.last_modified}`));
    const next = [];
    for (const file of candidates.slice(0, room)) {
      const duplicateKey = `${file.name}:${file.size}:${file.lastModified}`;
      if (existingKeys.has(duplicateKey)) continue;
      existingKeys.add(duplicateKey);
      const id = createMediaDraftId('issue-media');
      const draft = await saveMediaDraft({
        id,
        module: 'urgent_issue',
        scopeKey,
        file,
        meta: { media_kind: file.type.startsWith('video/') ? 'VIDEO' : 'IMAGE' },
      });
      next.push(draft);
    }
    setFiles((current) => [...current, ...next].slice(0, maxFiles));
    if (candidates.length > room) setError(`Only the first ${room} attachment${room === 1 ? '' : 's'} were kept. The Sheet limit is ${maxFiles}.`);
  };

  const removeFile = async (entry) => {
    await removeMediaDraft(entry.id).catch(() => undefined);
    setFiles((current) => current.filter((item) => item.id !== entry.id));
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const media = [];
      for (const entry of files) {
        let uploaded = entry.meta?.uploaded;
        if (!uploaded) {
          uploaded = await opsClient.integrations.Core.UploadFile({
            file: entry.file,
            folderType: 'Urgent Issues',
            outletName: user?.outlet_id || 'General',
            outletId: user?.outlet_id || '',
          });
          await saveMediaDraft({
            id: entry.id,
            module: 'urgent_issue',
            scopeKey,
            file: entry.file,
            meta: { ...entry.meta, uploaded },
          });
          setFiles((current) => current.map((item) => item.id === entry.id ? { ...item, meta: { ...item.meta, uploaded } } : item));
        }
        media.push({
          drive_file_id: uploaded.drive_file_id || '',
          file_name: uploaded.file_name || entry.file_name || entry.file?.name || '',
          file_url: uploaded.file_url || '',
          view_url: uploaded.view_url || '',
          mime_type: uploaded.mime_type || entry.file_type || entry.file?.type || '',
          file_size: Number(uploaded.file_size || entry.file_size || entry.file?.size || 0),
        });
      }

      const dueDate = localIssueDate();
      const created = await opsClient.entities.UrgentIssue.create({
        ...form,
        outlet_id: user?.outlet_id || '',
        status: 'open',
        due_date: dueDate,
        assigned_to_name: '',
        followup_notes: media.length
          ? issueMetaText({
              note: '',
              media,
              reported_by: user?.full_name || '',
              reported_at: new Date().toISOString(),
            })
          : '',
      }, { year: Number(dueDate.slice(0, 4)) });
      await clearMediaDrafts({ module: 'urgent_issue', scopeKey });
      try { localStorage.removeItem(issueDraftStorageKey(user)); } catch {}
      setFiles([]);
      onDone(created);
    } catch (err) {
      setError(`${err.message || 'Failed to create issue'}. Your draft is still saved on this device.`);
      const rows = await listMediaDrafts({ module: 'urgent_issue', scopeKey }).catch(() => []);
      setFiles(rows);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <section className="space-y-3 rounded-2xl border border-border bg-card p-3.5">
        <div className="space-y-2">
          <Label htmlFor="issue-title">Issue title</Label>
          <Input
            id="issue-title"
            className="h-10 rounded-xl"
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
            placeholder="e.g. Freezer not cooling"
            required
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="issue-description">What happened?</Label>
          <Textarea
            id="issue-description"
            className="min-h-20 rounded-xl"
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            placeholder="Describe the problem, location and immediate action taken."
            rows={3}
          />
        </div>
      </section>

      <section className="space-y-2.5 rounded-2xl border border-border bg-card p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Evidence</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {mediaRuleLabel(mediaRule)} · maximum {maxFiles} · {mediaRule.max_file_mb || 10} MB each
            </p>
            <p className="mt-1 text-[10px] font-medium text-emerald-700">Draft automatically saved on this device</p>
          </div>
          <span className="rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">{files.length}/{maxFiles}</span>
        </div>

        {showCamera ? (
          <input
            ref={cameraRef}
            type="file"
            accept={accepted}
            capture="environment"
            className="hidden"
            onChange={async (event) => {
              await addFiles(event.target.files);
              event.target.value = '';
            }}
          />
        ) : null}
        {showGallery ? (
          <input
            ref={galleryRef}
            type="file"
            accept={accepted}
            multiple
            className="hidden"
            onChange={async (event) => {
              await addFiles(event.target.files);
              event.target.value = '';
            }}
          />
        ) : null}

        <div className={`grid gap-2 ${showCamera && showGallery ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {showCamera ? (
            <button
              type="button"
              disabled={files.length >= maxFiles || saving}
              onClick={() => cameraRef.current?.click()}
              className="flex h-12 items-center justify-center gap-2 rounded-xl border border-dashed border-primary/40 bg-primary/5 px-3 text-xs font-medium text-primary disabled:opacity-40"
            >
              <Camera className="h-4 w-4" /> Capture
            </button>
          ) : null}
          {showGallery ? (
            <button
              type="button"
              disabled={files.length >= maxFiles || saving}
              onClick={() => galleryRef.current?.click()}
              className="flex h-12 items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 px-3 text-xs font-medium disabled:opacity-40"
            >
              <Images className="h-4 w-4" /> Choose
            </button>
          ) : null}
        </div>

        {previews.length ? (
          <div className="grid grid-cols-2 gap-2">
            {previews.map(({ entry, url }, index) => {
              const video = String(entry.file_type || entry.file?.type || entry.meta?.uploaded?.mime_type || '').startsWith('video/');
              return (
                <div key={entry.id} className="relative overflow-hidden rounded-xl border border-border bg-muted">
                  {video ? (
                    <div className="relative">
                      <video src={url} muted preload="metadata" className="h-24 w-full object-cover" />
                      <span className="absolute inset-0 flex items-center justify-center"><Play className="h-7 w-7 fill-white text-white drop-shadow" /></span>
                    </div>
                  ) : (
                    <img src={url} alt={entry.file_name || `Evidence ${index + 1}`} className="h-24 w-full object-cover" />
                  )}
                  <button
                    type="button"
                    onClick={() => removeFile(entry)}
                    disabled={saving}
                    className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-white disabled:opacity-40"
                    aria-label={`Remove attachment ${index + 1}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                  {entry.meta?.uploaded ? <span className="absolute bottom-2 left-2 rounded-full bg-emerald-600 px-2 py-1 text-[9px] font-semibold text-white">Uploaded draft</span> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-xl bg-muted/50 p-2.5 text-[11px] text-muted-foreground">
            <ImageIcon className="h-5 w-5 shrink-0" /> Only file types enabled in MediaRules can be attached.
          </div>
        )}
      </section>

      <section className="grid grid-cols-2 gap-2.5 rounded-2xl border border-border bg-card p-3.5">
        <div className="space-y-2">
          <Label>Priority</Label>
          <select
            className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
            value={form.priority}
            onChange={(event) => setForm({ ...form, priority: event.target.value })}
          >
            {Object.entries(PRIORITY_META).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
          </select>
        </div>
        <div className="space-y-2">
          <Label>Category</Label>
          <select
            className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm capitalize"
            value={form.category}
            onChange={(event) => setForm({ ...form, category: event.target.value })}
          >
            {CATEGORIES.map((category) => <option key={category} value={category}>{category.replace('_', ' ')}</option>)}
          </select>
        </div>
        <div className="col-span-2 space-y-2">
          <Label>Assign to role</Label>
          <select
            className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
            value={form.assigned_to_role}
            onChange={(event) => setForm({ ...form, assigned_to_role: event.target.value })}
          >
            {ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
          </select>
        </div>
      </section>

      {error ? <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <div className="grid grid-cols-[0.8fr_1.2fr] gap-2.5 pt-1">
        <Button type="button" variant="outline" className="h-11 rounded-xl" disabled={saving} onClick={onCancel}>
          Close
        </Button>
        <Button type="submit" className="h-11 rounded-xl" disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : files.length ? <UploadCloud className="mr-2 h-4 w-4" /> : null}
          {saving ? 'Uploading…' : 'Report issue'}
        </Button>
      </div>
    </form>
  );
}

