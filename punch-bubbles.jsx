import React, { useState, useMemo, useRef, useEffect } from "react";
import * as d3 from "d3";
import { X, Link as LinkIcon, Check, Clock, Bot, User, History as HistoryIcon, TrendingUp, HelpCircle, RefreshCw as RefreshIcon } from "lucide-react";

const API_BASE = "https://punch-worker.ben-a90.workers.dev";

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}
async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}
async function apiPatch(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status}`);
  return res.json();
}
async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
  return res.json();
}
// Fire-and-forget wrapper for calls the UI shouldn't block on — local state already
// updated optimistically, this just persists it. Logs failures rather than throwing,
// so a flaky network doesn't crash the panel.
function persist(promise) {
  promise.catch((err) => console.error("PUNCH sync failed:", err));
}

// now/daysAgo are still used by the Portfolio/Searches "record picker" mock pool below —
// that feature stays mock until real Procore/NetSuite polling exists (see initialAvailableRecords).
const now = new Date();

const PROJECT_TYPES = ["T&M", "Contract", "Service Call", "Warranty", "Overhead"];

const CHECKLIST_TM = [
  { key: "address", label: "Project address confirmed" },
  { key: "admin", label: "Admin page filled out" },
  { key: "directory", label: "People added to directory" },
  { key: "budget", label: "Budget populated" },
  { key: "preconEmails", label: "Preconstruction emails recorded for PM reference" },
  { key: "docs", label: "Drawings/docs moved to documents folder" },
  { key: "tmAgreement", label: "T&M Agreement signed and recorded" },
];

const CHECKLIST_CONTRACT = [
  { key: "admin", label: "Admin page filled out" },
  { key: "po", label: "PO recorded" },
  { key: "tenderEmails", label: "Tender process emails recorded for PM reference" },
  { key: "estimateReview", label: "Estimates reviewed — usable for PM & site teams" },
  { key: "budgetPC", label: "Budget & PC populated with boilerplate codes" },
  { key: "labourBudget", label: "Labour budget set up" },
  { key: "directory", label: "People added to directory" },
  { key: "drawings", label: "Drawings moved to documents folder" },
  { key: "startupDocs", label: "Startup docs issued (WSIB, H&S, COI)" },
];

const ONTARIO_ITEM = { key: "form1000", label: "Form 1000 filled out (Ontario)" };

function templateForProjectType(projectType) {
  return projectType === "Contract" || projectType === "Service Call" ? CHECKLIST_CONTRACT : CHECKLIST_TM;
}

function buildChecklist(projectType, isOntario, previousChecklist) {
  const base = templateForProjectType(projectType);
  const items = isOntario ? [...base, ONTARIO_ITEM] : base;
  const prevByKey = new Map((previousChecklist || []).map((c) => [c.key, c.done]));
  return items.map((item) => ({ ...item, done: prevByKey.get(item.key) || false }));
}

// Bridges the database's snake_case columns to the camelCase shape this component
// uses everywhere. Real rows come back from the Worker looking like { created_at, ... };
// everything below expects { createdAt, ... }.
function normalizeTask(row) {
  return {
    id: row.id,
    ticket: String(row.ticket).padStart(4, "0"),
    summary: row.summary,
    category: row.category,
    priority: row.priority,
    status: row.status,
    list: row.list,
    source: row.source,
    rawText: row.raw_text,
    createdAt: row.created_at,
    lastPriorityChangeAt: row.last_priority_change_at || row.created_at,
    dueDate: row.due_date,
    orderIndex: row.order_index,
    person: row.person,
    sourceUrl: row.source_url,
    resolutionNote: row.resolution_note,
    resolutionLink: row.resolution_link,
    completedAt: row.completed_at,
    deferReason: row.defer_reason,
    projectType: row.project_type,
    isOntario: row.is_ontario,
    checklist: row.checklist || undefined,
    history: row.history || [],
    parentTaskId: row.parent_task_id || null,
    isProject: row.is_project || false,
    description: row.description || "",
    color: row.color || null,
  };
}

function normalizeRecurring(row) {
  return {
    id: row.id,
    summary: row.summary,
    description: row.description || "",
    category: row.category,
    priority: row.priority,
    cadenceDays: row.cadence_days,
    createdAt: row.created_at,
    lastDoneAt: row.last_done_at,
    skipUntil: row.skip_until,
    notes: row.notes || "",
    history: row.history || [],
    recurring: true,
  };
}

// Mock "what's in the source system but not yet on the list" pool — in the real
// build this comes from re-querying Procore/NetSuite and diffing against current tasks.
const initialAvailableRecords = {
  portfolio: [
    { summary: "New project: Oakridge Residence — admin setup pending", category: "Portfolio", priority: "normal", sourceUrl: "https://app.procore.com/projects/mock-oakridge" },
    { summary: "New project: Fenwick Library addition — PO not yet confirmed", category: "Portfolio", priority: "high", sourceUrl: "https://app.procore.com/projects/mock-fenwick" },
  ],
  searches: [
    { summary: "Saved search: unsynced Procore/NetSuite project records", category: "Sync", priority: "normal", sourceUrl: null },
    { summary: "Saved search: NetSuite inbound projects awaiting approval", category: "Sync", priority: "normal", sourceUrl: null },
  ],
};

const priorityOptions = ["urgent", "high", "normal", "low"];

const initialCategories = [
  "Accounting",
  "Operations",
  "Logistics",
  "Site Issue",
  "Data Management",
  "Email Reply",
  "Change Order",
  "NetSuite Access",
  "Portfolio",
  "Sync",
  "Sales",
  "General",
  "Project",
];
const ESCALATION_ORDER = ["low", "normal", "high", "urgent"];
const ESCALATE_EVERY_DAYS = 5; // one step up the ladder per this many days since last set

// Whole days until task.dueDate, negative once overdue. Null when there's no due date —
// distinct from daysUntilDue(rt), which is the recurring-task cadence calculation.
function daysUntilTaskDue(task) {
  if (!task.dueDate) return null;
  return Math.ceil((new Date(task.dueDate) - now) / 86400000);
}

function isOverdue(task) {
  const d = daysUntilTaskDue(task);
  return d !== null && d < 0 && task.status === "open";
}

function dueDateColor(task) {
  const d = daysUntilTaskDue(task);
  if (d === null) return "#8A8375";
  if (d < 0) return priorityColor.urgent;
  if (d <= 2) return priorityColor.high;
  return "#8A8375";
}

function effectivePriority(task) {
  const since = task.lastPriorityChangeAt || task.createdAt;
  const bumps = Math.floor(daysOpen(since) / ESCALATE_EVERY_DAYS);
  const baseIdx = ESCALATION_ORDER.indexOf(task.priority);
  let idx = Math.min(ESCALATION_ORDER.length - 1, baseIdx + bumps);

  // A due date is a stronger signal than age alone — due today or overdue forces
  // urgent regardless of the age ladder; within 2 days floors it at high.
  const daysToDue = daysUntilTaskDue(task);
  if (daysToDue !== null) {
    if (daysToDue <= 0) idx = ESCALATION_ORDER.length - 1;
    else if (daysToDue <= 2) idx = Math.max(idx, ESCALATION_ORDER.indexOf("high"));
  }
  return ESCALATION_ORDER[idx];
}

function daysUntilEscalation(task) {
  const since = task.lastPriorityChangeAt || task.createdAt;
  const daysSince = daysOpen(since);
  return ESCALATE_EVERY_DAYS - (daysSince % ESCALATE_EVERY_DAYS);
}

function historyEvent(type, text) {
  return { type, text, at: now.toISOString() };
}

// The front-card status line should show real substance — a note, a reply, a
// defer reason — never an administrative echo like "category changed" or
// "checked: X". History tab still shows everything; this just picks what
// belongs at a glance.
const ACTIONABLE_HISTORY_TYPES = new Set([
  "note",
  "deferred",
  "resolved",
  "copilot_sent",
  "force_completed",
  "cycle_deferred",
]);

function getLatestActionableEvent(history) {
  if (!history) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (ACTIONABLE_HISTORY_TYPES.has(history[i].type)) return history[i];
  }
  return null;
}

const deferOptions = [
  { label: "Tomorrow", days: 1 },
  { label: "3 days", days: 3 },
  { label: "Next week", days: 7 },
];

// Type scale for the task detail card: 4 sizes max, so it reads as one system
// instead of a dozen hand-picked numbers. XS/SM for read-only labels and meta,
// MD for body copy and buttons, LG for the title.
const FONT_MONO = "'JetBrains Mono', monospace";
const FONT_BODY = "'Inter', sans-serif";
const SIZE_XS = 10;
const SIZE_SM = 11;
const SIZE_MD = 13;
const SIZE_LG = 16;

const priorityColor = {
  urgent: "#C1401C",
  high: "#E2871A",
  normal: "#6B7A8C",
  low: "#5B7A5B",
};

const priorityWeight = { urgent: 34, high: 24, normal: 15, low: 8 };

// Curated palette for project bubbles — deliberately clear of priorityColor's hues
// (red/orange/slate-gray/green) so a project's own color is never confused with a
// child bubble's priority color at a glance.
const PROJECT_COLORS = [
  "#1F8A8A", // teal
  "#3A5FA0", // deep blue
  "#6B4FA8", // indigo
  "#A8478F", // magenta
  "#C9A227", // mustard
  "#7A5230", // umber
  "#B8567A", // rose
  "#7D5BA6", // lavender
];
const DEFAULT_PROJECT_COLOR = PROJECT_COLORS[0];

function daysOpen(createdAt) {
  return Math.max(0, Math.floor((now - new Date(createdAt)) / 86400000));
}

// "When did this actually happen" stamps (history events, creation dates) show
// the time alongside the date — same-day events were otherwise indistinguishable.
function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function radiusFor(task, childCount) {
  // Project bubbles size by how much they contain, not by priority/age — and
  // keep growing with no early cap so a big project visibly reads as big.
  if (task.isProject) return 40 + Math.min((childCount || 0) * 6, 140);
  const base = 22;
  const age = Math.min(daysOpen(task.createdAt) * 2.5, 22);
  return base + priorityWeight[effectivePriority(task)] * 0.6 + age;
}

// Wraps text into up to maxLines, sized to fit a bubble of the given radius.
function wrapText(text, r) {
  const fontSize = Math.max(7, r * 0.14);
  const maxChars = Math.max(6, Math.floor((r * 1.5) / (fontSize * 0.55)));
  const maxLines = r > 45 ? 3 : r > 32 ? 2 : 1;

  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (test.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = test;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);

  const wordsUsed = lines.join(" ").split(" ").length;
  if (wordsUsed < words.length && lines.length > 0) {
    let last = lines[lines.length - 1];
    if (last.length > maxChars - 1) last = last.slice(0, maxChars - 1);
    lines[lines.length - 1] = last + "…";
  }
  return { lines, fontSize };
}

const tabs = [
  { id: "inbox", label: "INBOX", view: "bubbles" },
  { id: "portfolio", label: "PORTFOLIO", view: "list" },
  { id: "searches", label: "SAVED SEARCHES", view: "list" },
  { id: "recurring", label: "RECURRING", view: "recurring" },
  { id: "snoozed", label: "SNOOZED", view: "bubbles" },
  { id: "digest", label: "DIGEST", view: "digest" },
];

const WIDTH = 620;
const HEIGHT = 480;

const cadenceOptions = [
  { label: "Daily", days: 1 },
  { label: "Weekly", days: 7 },
  { label: "Biweekly", days: 14 },
  { label: "Monthly", days: 30 },
];

function nextDueDate(rt) {
  const anchor = rt.skipUntil || rt.lastDoneAt || rt.createdAt;
  return new Date(new Date(anchor).getTime() + rt.cadenceDays * 86400000);
}

function daysUntilDue(rt) {
  return Math.ceil((nextDueDate(rt) - now) / 86400000);
}

export default function PunchBubbles() {
  const [tasks, setTasks] = useState([]);
  const [recurringTasks, setRecurringTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  // Shadows the module-level WIDTH/HEIGHT (620x480 default) with the actual
  // available window size, so the bubble canvas isn't stuck in a fixed box
  // with dead space on either side, and can't extend below the visible page.
  function computeCanvasSize() {
    if (typeof window === "undefined") return { w: 620, h: 480 };
    const w = Math.max(620, Math.min(window.innerWidth - 80, 1400));
    const aspectH = Math.round(w * (480 / 620));
    const maxViewportH = Math.max(320, window.innerHeight - 280); // room for header/tabs/legend
    return { w, h: Math.min(aspectH, maxViewportH) };
  }
  const [WIDTH, setWIDTH] = useState(() => computeCanvasSize().w);
  const [HEIGHT, setHEIGHT] = useState(() => computeCanvasSize().h);

  useEffect(() => {
    function handleResize() {
      const { w, h } = computeCanvasSize();
      setWIDTH(w);
      setHEIGHT(h);
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  const [tab, setTab] = useState("inbox");
  const [selected, setSelected] = useState(null);
  const [note, setNote] = useState(""); // shared: resolve reason, defer reason, and copilot context
  const [hoveredId, setHoveredId] = useState(null);
  const hoverLeaveTimeout = useRef(null);

  function handleHoverEnter(id, e) {
    // Touch has no real "hover" — a tap fires enter/down/up almost simultaneously,
    // which was colliding with drag-detection on the very first tap after a reload.
    // Mouse/pen still get the hover tooltip; touch goes straight to tap-to-open.
    if (e && e.pointerType === "touch") return;
    if (hoverLeaveTimeout.current) clearTimeout(hoverLeaveTimeout.current);
    setHoveredId(id);
  }

  function handleHoverLeave() {
    hoverLeaveTimeout.current = setTimeout(() => setHoveredId(null), 150);
  }
  const [draftSummary, setDraftSummary] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [availableRecords, setAvailableRecords] = useState(initialAvailableRecords);
  const [addPanelOpen, setAddPanelOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [manualCategory, setManualCategory] = useState("");
  const [manualPriority, setManualPriority] = useState("normal");
  const [manualLink, setManualLink] = useState("");
  const [manualPerson, setManualPerson] = useState("");
  const [modalTab, setModalTab] = useState("details"); // "details" | "history"
  const [categories, setCategories] = useState(initialCategories);
  const [feedbackLog, setFeedbackLog] = useState([]);
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryText, setNewCategoryText] = useState("");
  const [copilotSuggestions, setCopilotSuggestions] = useState(null);
  const [pickedSuggestion, setPickedSuggestion] = useState(null);
  const [deletingConfirm, setDeletingConfirm] = useState(false);
  const [resolvingConfirm, setResolvingConfirm] = useState(false);
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  const [editingLink, setEditingLink] = useState(false);
  const [draftSourceUrl, setDraftSourceUrl] = useState("");
  const [forceCompleteConfirm, setForceCompleteConfirm] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [recurName, setRecurName] = useState("");
  const [recurDescription, setRecurDescription] = useState("");
  const [recurCadence, setRecurCadence] = useState(7);
  const [recurCategory, setRecurCategory] = useState("");
  const [recurPriority, setRecurPriority] = useState("normal");
  const [recurNotesDraft, setRecurNotesDraft] = useState("");
  const [pickedRecordIdx, setPickedRecordIdx] = useState("");
  const [newlyAddedIds, setNewlyAddedIds] = useState(() => new Set());
  const [copilotLoading, setCopilotLoading] = useState(false);

  // Project bubbles: which project (if any) is currently expanded in place,
  // the drag-to-nest highlight target, the Inbox add-panel's task/project
  // toggle + project draft fields, and the opened-project header's edit state.
  const [openedProjectId, setOpenedProjectId] = useState(null);
  const [dragOverProjectId, setDragOverProjectId] = useState(null);
  const [addMode, setAddMode] = useState("task"); // "task" | "project" — Inbox add panel only
  const [projectTitle, setProjectTitle] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectColor, setProjectColor] = useState(DEFAULT_PROJECT_COLOR);
  const [pickedChildIdx, setPickedChildIdx] = useState("");
  const [draftProjectTitle, setDraftProjectTitle] = useState("");
  const [draftProjectDescription, setDraftProjectDescription] = useState("");
  const [deletingProjectConfirm, setDeletingProjectConfirm] = useState(false);
  const [addTaskPanelOpen, setAddTaskPanelOpen] = useState(false);
  const [addTaskMode, setAddTaskMode] = useState("existing"); // "existing" | "new" — inside an opened project

  const svgRef = useRef(null);
  const draggingId = useRef(null);
  const dragMoved = useRef(false);
  const lastChildDragPos = useRef(null);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [digests, setDigests] = useState([]);
  const [digestLoading, setDigestLoading] = useState(false);
  const [digestGenerating, setDigestGenerating] = useState(false);
  const [digestError, setDigestError] = useState(null);
  const [digestsFetched, setDigestsFetched] = useState(false);

  async function fetchAndMergeTasks(replaceAll) {
    const [openRows, snoozedRows, recurRows] = await Promise.all([
      apiGet("/tasks?status=open"),
      apiGet("/tasks?status=snoozed"),
      apiGet("/recurring"),
    ]);
    const normalizedTasks = [...openRows, ...snoozedRows].map(normalizeTask);
    const normalizedRecur = recurRows.map(normalizeRecurring);

    if (replaceAll) {
      setTasks(normalizedTasks);
      setRecurringTasks(normalizedRecur);
      return;
    }

    // Merge-only for polling/manual refresh: add anything new, never overwrite
    // a task the user might have mid-open in the detail panel right now.
    setTasks((prev) => {
      const existingIds = new Set(prev.map((t) => t.id));
      const newOnes = normalizedTasks.filter((t) => !existingIds.has(t.id));
      newOnes.forEach((t) => flashNewlyAdded(t.id));
      return [...prev, ...newOnes];
    });
    setRecurringTasks((prev) => {
      const existingIds = new Set(prev.map((t) => t.id));
      const newOnes = normalizedRecur.filter((t) => !existingIds.has(t.id));
      return [...prev, ...newOnes];
    });
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        await fetchAndMergeTasks(true);
      } catch (err) {
        if (!cancelled) setLoadError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll every 45s for new tasks (new emails/Teams messages) without a manual reload.
  useEffect(() => {
    const interval = setInterval(() => {
      fetchAndMergeTasks(false).catch((err) => console.error("Background refresh failed:", err));
    }, 45000);
    return () => clearInterval(interval);
  }, []);

  async function manualRefresh() {
    setIsRefreshing(true);
    try {
      await fetchAndMergeTasks(false);
    } catch (err) {
      console.error("Manual refresh failed:", err);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function loadDigests() {
    setDigestLoading(true);
    setDigestError(null);
    try {
      const rows = await apiGet("/digest");
      setDigests(rows);
    } catch (err) {
      setDigestError(err.message);
    } finally {
      setDigestLoading(false);
      setDigestsFetched(true);
    }
  }

  async function generateDigest() {
    setDigestGenerating(true);
    setDigestError(null);
    try {
      const result = await apiPost("/digest/generate", {});
      if (result.message) {
        // Nothing new since last digest — no row was created.
        setDigestError(result.message);
      } else {
        setDigests((prev) => [result, ...prev]);
      }
    } catch (err) {
      setDigestError(err.message);
    } finally {
      setDigestGenerating(false);
    }
  }

  useEffect(() => {
    if (tab === "digest" && !digestsFetched) {
      loadDigests();
    }
  }, [tab, digestsFetched]);

  const currentTab = tabs.find((t) => t.id === tab);
  const snoozedTasks = tasks.filter((t) => t.status === "snoozed");
  const activeTasks =
    tab === "snoozed"
      ? snoozedTasks
      : tab === "recurring"
      ? [...recurringTasks].sort((a, b) => daysUntilDue(a) - daysUntilDue(b))
      // Nested project children live only inside their project's opened view,
      // never on the top-level board.
      : tasks.filter((t) => t.status === "open" && t.list === tab && !t.parentTaskId);
  const inboxOpenCount = tasks.filter((t) => t.status === "open" && t.list === "inbox").length;

  // Physics only reruns when the task list itself changes — not on every drag move.
  const POSITIONS_KEY = "punch_bubble_positions";
  const [positions, setPositions] = useState(() => {
    try {
      const raw = localStorage.getItem(POSITIONS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  });
  const positionsRef = useRef(positions);
  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  function persistPositions(next) {
    setPositions(next);
    try {
      localStorage.setItem(POSITIONS_KEY, JSON.stringify(next));
    } catch (e) {
      // ignore storage errors (e.g. private browsing quota)
    }
  }

  function updatePosition(id, x, y) {
    persistPositions({ ...positionsRef.current, [id]: { x, y } });
  }

  // Same pattern as the board's own position store, nested one level by project id —
  // positions inside an opened project survive refreshes and re-opens independently
  // of the board's positions.
  const PROJECT_POSITIONS_KEY = "punch_project_child_positions";
  const [projectPositions, setProjectPositions] = useState(() => {
    try {
      const raw = localStorage.getItem(PROJECT_POSITIONS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  });
  const projectPositionsRef = useRef(projectPositions);
  useEffect(() => {
    projectPositionsRef.current = projectPositions;
  }, [projectPositions]);

  function persistProjectPositions(next) {
    setProjectPositions(next);
    try {
      localStorage.setItem(PROJECT_POSITIONS_KEY, JSON.stringify(next));
    } catch (e) {
      // ignore storage errors (e.g. private browsing quota)
    }
  }

  function updateChildPosition(projectId, childId, x, y) {
    const forProject = { ...(projectPositionsRef.current[projectId] || {}), [childId]: { x, y } };
    persistProjectPositions({ ...projectPositionsRef.current, [projectId]: forProject });
  }

  // Only tasks with no remembered position get physics-placed; anything already
  // known (dragged or previously settled) is pinned via fx/fy so it never moves
  // again on its own — new arrivals just find open space around it.
  const settledNodes = useMemo(() => {
    const known = positionsRef.current;
    const childCountByParent = {};
    tasks.forEach((t) => {
      if (t.parentTaskId && t.status === "open") {
        childCountByParent[t.parentTaskId] = (childCountByParent[t.parentTaskId] || 0) + 1;
      }
    });
    const simNodes = activeTasks.map((t, i) => {
      const angle = i * 2.399963; // golden angle, avoids uniform rings
      const startRadius = 20 + i * 12;
      const effPriority = effectivePriority(t);
      // Snoozed bubbles render small and flat regardless of priority/age —
      // visually "parked," not competing for attention like Inbox does.
      const r = tab === "snoozed" ? 20 : radiusFor(t, childCountByParent[t.id]);
      const saved = known[t.id];
      const x = saved ? saved.x : WIDTH / 2 + Math.cos(angle) * startRadius;
      const y = saved ? saved.y : HEIGHT / 2 + Math.sin(angle) * startRadius;
      return {
        ...t,
        r,
        effPriority,
        childCount: childCountByParent[t.id] || 0,
        x,
        y,
        ...(saved ? { fx: saved.x, fy: saved.y } : {}),
      };
    });
    const sim = d3
      .forceSimulation(simNodes)
      .force("charge", d3.forceManyBody().strength(-25)) // negative = repel
      .force("x", d3.forceX(WIDTH / 2).strength(0.15))
      .force("y", d3.forceY(HEIGHT / 2).strength(0.15))
      .force(
        "collide",
        d3.forceCollide((d) => d.r + 8).iterations(3)
      )
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    simNodes.forEach((n) => {
      n.x = Math.max(n.r + 4, Math.min(WIDTH - n.r - 4, n.x));
      n.y = Math.max(n.r + 4, Math.min(HEIGHT - n.r - 4, n.y));
      delete n.fx;
      delete n.fy;
    });
    return simNodes;
    // The nesting signature (which tasks currently point at which parent) is included
    // so a project bubble's radius updates immediately when a child is added/removed,
    // even though the project's own id+priority in activeTasks didn't change.
  }, [
    tab,
    activeTasks.map((t) => t.id + t.priority).join(","),
    tasks.filter((t) => t.parentTaskId).map((t) => t.id + t.parentTaskId).join(","),
    WIDTH,
    HEIGHT,
  ]);

  // Remember any newly-placed bubbles so they stay put next time, without
  // touching positions that were already known (avoids an update loop).
  useEffect(() => {
    const known = positionsRef.current;
    const additions = {};
    let hasNew = false;
    settledNodes.forEach((n) => {
      if (!known[n.id]) {
        additions[n.id] = { x: n.x, y: n.y };
        hasNew = true;
      }
    });
    if (hasNew) persistPositions({ ...known, ...additions });
  }, [settledNodes]);

  // Live overlay: settledNodes is memoized (only recomputes when the task set
  // changes, for performance), but a drag needs to render every single move —
  // this merges the current positions store on top so dragging is instant.
  // Stored positions are raw canvas pixels — if WIDTH/HEIGHT changed since they were
  // saved (browser zoom changes window.innerWidth/innerHeight, which computeCanvasSize
  // feeds straight into WIDTH/HEIGHT), a saved position can now sit outside the current
  // canvas. settledNodes already re-clamps on recompute, but this overlay was blindly
  // preferring the stale stored value over that — re-clamp here too.
  const nodes = settledNodes.map((n) => {
    if (!positions[n.id]) return n;
    const x = Math.max(n.r + 4, Math.min(WIDTH - n.r - 4, positions[n.id].x));
    const y = Math.max(n.r + 4, Math.min(HEIGHT - n.r - 4, positions[n.id].y));
    return { ...n, x, y };
  });

  // --- Opened project: children + their own one-shot physics, mirroring the
  // board's settledNodes/nodes pattern above but bounded to a circle instead
  // of the WIDTH/HEIGHT rectangle. ---
  const PROJECT_RING_RADIUS = Math.min(WIDTH, HEIGHT) / 2 - 30;
  const openedProject = openedProjectId ? tasks.find((t) => t.id === openedProjectId) : null;
  const projectChildren = openedProjectId
    ? tasks.filter((t) => t.parentTaskId === openedProjectId && t.status === "open")
    : [];

  const settledChildNodes = useMemo(() => {
    if (!openedProjectId) return [];
    const known = projectPositionsRef.current[openedProjectId] || {};
    const simNodes = projectChildren.map((t, i) => {
      const angle = i * 2.399963;
      const startRadius = 20 + i * 10;
      const effPriority = effectivePriority(t);
      const r = radiusFor(t);
      const saved = known[t.id];
      const x = saved ? saved.x : WIDTH / 2 + Math.cos(angle) * startRadius;
      const y = saved ? saved.y : HEIGHT / 2 + Math.sin(angle) * startRadius;
      return { ...t, r, effPriority, x, y, ...(saved ? { fx: saved.x, fy: saved.y } : {}) };
    });
    const sim = d3
      .forceSimulation(simNodes)
      .force("charge", d3.forceManyBody().strength(-20))
      .force("x", d3.forceX(WIDTH / 2).strength(0.1))
      .force("y", d3.forceY(HEIGHT / 2).strength(0.1))
      .force("collide", d3.forceCollide((d) => d.r + 6).iterations(3))
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    simNodes.forEach((n) => {
      // Clamp into the project's ring, not the rectangular canvas.
      const dx = n.x - WIDTH / 2;
      const dy = n.y - HEIGHT / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxDist = PROJECT_RING_RADIUS - n.r - 6;
      if (dist > maxDist && dist > 0) {
        const scale = maxDist / dist;
        n.x = WIDTH / 2 + dx * scale;
        n.y = HEIGHT / 2 + dy * scale;
      }
      delete n.fx;
      delete n.fy;
    });
    return simNodes;
  }, [openedProjectId, projectChildren.map((t) => t.id + t.priority).join(","), WIDTH, HEIGHT]);

  useEffect(() => {
    if (!openedProjectId) return;
    const known = projectPositionsRef.current[openedProjectId] || {};
    const additions = {};
    let hasNew = false;
    settledChildNodes.forEach((n) => {
      if (!known[n.id]) {
        additions[n.id] = { x: n.x, y: n.y };
        hasNew = true;
      }
    });
    if (hasNew) {
      persistProjectPositions({ ...projectPositionsRef.current, [openedProjectId]: { ...known, ...additions } });
    }
  }, [settledChildNodes, openedProjectId]);

  const childPositionsForOpen = openedProjectId ? projectPositions[openedProjectId] || {} : {};
  // Same fix as the board's `nodes` overlay above, but clamped to the ring instead of
  // the rectangle — this is what was actually letting children drift outside the
  // project's circle after a zoom change instead of just near a rectangular edge.
  const childNodes = settledChildNodes.map((n) => {
    const saved = childPositionsForOpen[n.id];
    if (!saved) return n;
    const dx = saved.x - WIDTH / 2;
    const dy = saved.y - HEIGHT / 2;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxDist = PROJECT_RING_RADIUS - n.r - 6;
    if (dist <= maxDist || dist === 0) return { ...n, x: saved.x, y: saved.y };
    const scale = maxDist / dist;
    return { ...n, x: WIDTH / 2 + dx * scale, y: HEIGHT / 2 + dy * scale };
  });

  function openProject(id) {
    const proj = tasks.find((t) => t.id === id);
    setOpenedProjectId(id);
    setDraftProjectTitle(proj ? proj.summary : "");
    setDraftProjectDescription(proj ? proj.description || "" : "");
    setDeletingProjectConfirm(false);
    setPickedChildIdx("");
    setAddPanelOpen(false);
    setAddTaskPanelOpen(false);
    setAddTaskMode("existing");
  }

  function closeProject() {
    setOpenedProjectId(null);
    setDeletingProjectConfirm(false);
    setAddTaskPanelOpen(false);
  }

  function nestTaskIntoProject(taskId, projectId) {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, parentTaskId: projectId } : t)));
    persist(apiPatch(`/tasks/${taskId}`, { parent_task_id: projectId }));
  }

  function removeChildFromProject(taskId) {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, parentTaskId: null } : t)));
    persist(apiPatch(`/tasks/${taskId}`, { parent_task_id: null }));
    if (openedProjectId) {
      const forProject = { ...(projectPositionsRef.current[openedProjectId] || {}) };
      delete forProject[taskId];
      persistProjectPositions({ ...projectPositionsRef.current, [openedProjectId]: forProject });
    }
    if (selected && selected.id === taskId) setSelected(null);
  }

  function createProject() {
    const title = projectTitle.trim();
    if (!title) return;
    const tempId = `project-${Date.now()}`;
    const description = projectDescription.trim();
    const color = projectColor || DEFAULT_PROJECT_COLOR;
    const optimistic = {
      id: tempId,
      ticket: nextTicketNumber(),
      summary: title,
      description,
      category: "Project",
      priority: "normal",
      createdAt: now.toISOString(),
      lastPriorityChangeAt: now.toISOString(),
      status: "open",
      list: "inbox",
      isProject: true,
      color,
      parentTaskId: null,
      history: [historyEvent("created", "Project created")],
    };
    setTasks((prev) => [...prev, optimistic]);
    flashNewlyAdded(tempId);
    setProjectTitle("");
    setProjectDescription("");
    setProjectColor(DEFAULT_PROJECT_COLOR);
    setAddPanelOpen(false);

    apiPost("/ingest", {
      source: "manual",
      raw_text: title,
      skip_classification: true,
      summary: title,
      description,
      color,
      is_project: true,
      category: "Project",
      priority: "normal",
      list: "inbox",
    })
      .then((row) => {
        const real = normalizeTask(row);
        real.history = optimistic.history;
        setTasks((prev) => prev.map((t) => (t.id === tempId ? real : t)));
      })
      .catch((err) => console.error("PUNCH sync failed:", err));
  }

  function saveProjectField(field, patchKey, value) {
    setTasks((prev) => prev.map((t) => (t.id === openedProjectId ? { ...t, [field]: value } : t)));
    persist(apiPatch(`/tasks/${openedProjectId}`, { [patchKey]: value }));
  }

  function saveProjectTitle() {
    const trimmed = draftProjectTitle.trim();
    if (!trimmed || !openedProject || trimmed === openedProject.summary) return;
    saveProjectField("summary", "summary", trimmed);
  }

  function saveProjectDescription() {
    if (!openedProject || draftProjectDescription === (openedProject.description || "")) return;
    saveProjectField("description", "description", draftProjectDescription);
  }

  function saveProjectColor(color) {
    saveProjectField("color", "color", color);
  }

  function deleteProject() {
    const id = openedProjectId;
    persist(apiDelete(`/tasks/${id}`));
    setTasks((prev) =>
      prev.filter((t) => t.id !== id).map((t) => (t.parentTaskId === id ? { ...t, parentTaskId: null } : t))
    );
    const nextProjectPositions = { ...projectPositionsRef.current };
    delete nextProjectPositions[id];
    persistProjectPositions(nextProjectPositions);
    closeProject();
  }

  function addExistingTaskToProject() {
    if (!pickedChildIdx || !openedProjectId) return;
    nestTaskIntoProject(pickedChildIdx, openedProjectId);
    setPickedChildIdx("");
  }

  function handlePointerDown(e, node) {
    e.stopPropagation();
    draggingId.current = node.id;
    dragMoved.current = false;
    lastChildDragPos.current = null;
    e.target.setPointerCapture(e.pointerId);
  }

  function handleSvgPointerMove(e) {
    if (!draggingId.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = WIDTH / rect.width;
    const scaleY = HEIGHT / rect.height;
    const rawX = (e.clientX - rect.left) * scaleX;
    const rawY = (e.clientY - rect.top) * scaleY;
    dragMoved.current = true;

    if (openedProjectId) {
      const node = settledChildNodes.find((n) => n.id === draggingId.current);
      const r = node ? node.r : 26;
      // Deliberately NOT clamped to the ring — dragging a child past its edge
      // and releasing outside is how it gets un-nested (see handleSvgPointerUp).
      const clampedX = Math.max(r + 4, Math.min(WIDTH - r - 4, rawX));
      const clampedY = Math.max(r + 4, Math.min(HEIGHT - r - 4, rawY));
      // Tracked synchronously here rather than read back from projectPositions —
      // that store is only mirrored into a ref via a useEffect (a passive effect,
      // fired after a render/paint), which can still be stale at pointer-up if the
      // browser delivers the last move and the release without a paint in between.
      lastChildDragPos.current = { x: clampedX, y: clampedY };
      updateChildPosition(openedProjectId, draggingId.current, clampedX, clampedY);
      return;
    }

    const node = settledNodes.find((n) => n.id === draggingId.current);
    const r = node ? node.r : 30;
    const clampedX = Math.max(r + 4, Math.min(WIDTH - r - 4, rawX));
    const clampedY = Math.max(r + 4, Math.min(HEIGHT - r - 4, rawY));
    updatePosition(draggingId.current, clampedX, clampedY);

    // Drag-to-nest: while dragging an ordinary bubble over a project bubble,
    // highlight it as the drop target (resolved on pointer-up below).
    if (node && !node.isProject) {
      const target = nodes.find((n) => {
        if (!n.isProject || n.id === draggingId.current) return false;
        const dx = clampedX - n.x;
        const dy = clampedY - n.y;
        return Math.sqrt(dx * dx + dy * dy) < n.r;
      });
      setDragOverProjectId(target ? target.id : null);
    }
  }

  function handleSvgPointerUp() {
    const id = draggingId.current;
    if (id && openedProjectId) {
      const stored = lastChildDragPos.current;
      if (stored) {
        const dx = stored.x - WIDTH / 2;
        const dy = stored.y - HEIGHT / 2;
        if (Math.sqrt(dx * dx + dy * dy) > PROJECT_RING_RADIUS) {
          removeChildFromProject(id);
        }
      }
    } else if (id && dragOverProjectId) {
      nestTaskIntoProject(id, dragOverProjectId);
    }
    setDragOverProjectId(null);
    lastChildDragPos.current = null;
    draggingId.current = null;
  }

  // Single bubble renderer, reused for the closed board, the faded "ghost" background
  // pass behind an opened project, and the crisp children floating inside one — same
  // visuals and drag/click wiring everywhere; context (board vs. project) is handled
  // by handleSvgPointerMove/Up and openProject/openDetail already knowing what's
  // being dragged/clicked via draggingId/openedProjectId.
  function renderBubble(n, i) {
    const color = n.isProject ? n.color || DEFAULT_PROJECT_COLOR : tab === "snoozed" ? "#6B7A8C" : priorityColor[n.effPriority];
    const age = daysOpen(n.createdAt);
    const daysUntilDue = n.dueDate ? Math.ceil((new Date(n.dueDate) - now) / 86400000) : null;
    return (
      <g
        key={n.id}
        transform={`translate(${n.x},${n.y})`}
        style={{ cursor: "grab" }}
        onPointerDown={(e) => handlePointerDown(e, n)}
        onPointerEnter={(e) => handleHoverEnter(n.id, e)}
        onPointerLeave={handleHoverLeave}
        onClick={() => {
          if (dragMoved.current) {
            dragMoved.current = false;
            return;
          }
          if (n.isProject) {
            openProject(n.id);
            return;
          }
          openDetail((tab === "recurring" ? recurringTasks : tasks).find((t) => t.id === n.id) || n);
        }}
      >
        <g
          style={{
            animation: [
              newlyAddedIds.has(n.id)
                ? "inflate 0.5s cubic-bezier(0.34,1.56,0.64,1) both"
                : null,
              `drift ${4 + (i % 3)}s ease-in-out infinite${newlyAddedIds.has(n.id) ? " 0.5s" : ""}`,
              !n.isProject && isOverdue(n) ? "overduePulse 1.6s ease-in-out infinite" : null,
            ]
              .filter(Boolean)
              .join(", "),
            animationDelay: newlyAddedIds.has(n.id) ? undefined : `${i * 0.3}s`,
          }}
        >
          <circle
            r={n.r}
            fill="#2A2724"
            stroke={dragOverProjectId === n.id ? "#F1ECE1" : color}
            strokeWidth={n.isProject ? "3.5" : "2.5"}
          />
          <circle r={n.r - 5} fill={color} fillOpacity="0.14" />
          {n.isProject ? (
            <>
              {/* inner ring — marks a project as a container, not a single task */}
              <circle r={n.r - 8} fill="none" stroke={color} strokeWidth="1" strokeOpacity="0.55" />
              {/* preview dots — one per open child, so a closed project still shows what's inside */}
              {Array.from({ length: Math.min(n.childCount, 10) }).map((_, di) => {
                const dAngle = di * 2.399963;
                const dRadius = Math.min(n.r - 16, 6 + di * ((n.r - 20) / 10));
                return (
                  <circle
                    key={di}
                    cx={Math.cos(dAngle) * dRadius}
                    cy={Math.sin(dAngle) * dRadius}
                    r={Math.max(2.5, n.r * 0.06)}
                    fill={color}
                    fillOpacity="0.85"
                  />
                );
              })}
              {n.childCount > 10 && (
                <text
                  y={n.r - 18}
                  textAnchor="middle"
                  style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700, fill: "#D9D2C4" }}
                >
                  +{n.childCount - 10}
                </text>
              )}
            </>
          ) : (
            // punched hole, like a physical inspection tag
            <circle cx={0} cy={-n.r + 9} r={3.5} fill="#1E1C1A" stroke="#5C5850" strokeWidth="1" />
          )}
          {(() => {
            const { lines, fontSize } = wrapText(n.summary, n.r);
            const ageFontSize = Math.max(9, n.r * 0.22);
            const blockHeight = lines.length * fontSize * 1.2;
            const startY = -blockHeight / 2 + fontSize * 0.4 + ageFontSize * 0.6;
            return (
              <>
                <text
                  y={startY - fontSize * 1.1 - 2}
                  textAnchor="middle"
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: ageFontSize,
                    fontWeight: 700,
                    fill: "#F1ECE1",
                  }}
                >
                  {n.isProject
                    ? `${n.childCount} ITEM${n.childCount === 1 ? "" : "S"}`
                    : tab === "snoozed"
                    ? daysUntilDue !== null
                      ? daysUntilDue <= 0
                        ? "DUE"
                        : `${daysUntilDue}d`
                      : ""
                    : `${age}d`}
                </text>
                {lines.map((line, li) => (
                  <text
                    key={li}
                    y={startY + li * fontSize * 1.2}
                    textAnchor="middle"
                    style={{
                      fontFamily: "'Inter', sans-serif",
                      fontSize,
                      fontWeight: 500,
                      fill: "#D9D2C4",
                    }}
                  >
                    {line}
                  </text>
                ))}
              </>
            );
          })()}
        </g>
      </g>
    );
  }

  function apiPathFor(id) {
    return selected?.recurring ? `/recurring/${id}` : `/tasks/${id}`;
  }

  function updateStore(id, updater) {
    if (selected?.recurring) {
      setRecurringTasks((prev) => prev.map((t) => (t.id === id ? updater(t) : t)));
    } else {
      setTasks((prev) => prev.map((t) => (t.id === id ? updater(t) : t)));
    }
  }

  function pushHistory(taskId, type, text) {
    const event = historyEvent(type, text);
    let newHistory;
    updateStore(taskId, (t) => {
      newHistory = [...(t.history || []), event];
      return { ...t, history: newHistory };
    });
    setSelected((prev) =>
      prev && prev.id === taskId ? { ...prev, history: [...(prev.history || []), event] } : prev
    );
    persist(apiPatch(apiPathFor(taskId), { history: newHistory }));
  }

  function openDetail(task) {
    setSelected(task);
    setNote("");
    setDraftSummary(task.summary);
    setDraftDescription(task.description || "");
    setRecurNotesDraft(task.notes || "");
    setCopilotSuggestions(null);
    setPickedSuggestion(null);
    setAddingCategory(false);
    setDeletingConfirm(false);
    setResolvingConfirm(false);
    setSnoozeMenuOpen(false);
    setEditingLink(false);
    setDraftSourceUrl(task.sourceUrl || "");
    setForceCompleteConfirm(false);
    setDeleteReason("");
    setModalTab("details");
  }

  function saveCategoryDirect(value) {
    if (value === selected.category) return;
    updateStore(selected.id, (t) => ({ ...t, category: value }));
    setSelected((prev) => ({ ...prev, category: value }));
    persist(apiPatch(apiPathFor(selected.id), { category: value }));
    pushHistory(selected.id, "category_changed", `Category changed to "${value}"`);
  }

  function saveSourceUrl() {
    const trimmed = draftSourceUrl.trim();
    if (trimmed === (selected.sourceUrl || "")) {
      setEditingLink(false);
      return;
    }
    updateStore(selected.id, (t) => ({ ...t, sourceUrl: trimmed || null }));
    setSelected((prev) => ({ ...prev, sourceUrl: trimmed || null }));
    persist(apiPatch(`/tasks/${selected.id}`, { source_url: trimmed || null }));
    setEditingLink(false);
  }

  function addNewCategory() {
    const trimmed = newCategoryText.trim();
    if (!trimmed) return;
    if (!categories.includes(trimmed)) setCategories((prev) => [...prev, trimmed]);
    saveCategoryDirect(trimmed);
    setNewCategoryText("");
    setAddingCategory(false);
  }

  function deleteTask(reason) {
    persist(
      apiPost("/feedback", {
        task_id: selected.id,
        raw_text: selected.summary,
        source: selected.source || selected.list,
        assigned_category: selected.category,
        assigned_priority: selected.priority,
        reason,
      })
    );
    persist(apiDelete(`/tasks/${selected.id}`));
    setTasks((prev) => prev.filter((t) => t.id !== selected.id));
    setSelected(null);
  }

  function savePriority(newPriority) {
    if (newPriority === selected.priority) return;
    const old = selected.priority;
    const changedAt = now.toISOString();
    updateStore(selected.id, (t) => ({ ...t, priority: newPriority, lastPriorityChangeAt: changedAt }));
    setSelected((prev) => ({ ...prev, priority: newPriority, lastPriorityChangeAt: changedAt }));
    const patchBody = selected.recurring
      ? { priority: newPriority }
      : { priority: newPriority, last_priority_change_at: changedAt };
    persist(apiPatch(apiPathFor(selected.id), patchBody));
    pushHistory(selected.id, "priority_changed", `Priority set to ${newPriority.toUpperCase()} (was ${old.toUpperCase()})`);
  }

  function saveDueDate(newDueDate) {
    const value = newDueDate || null;
    if (value === (selected.dueDate || null)) return;
    updateStore(selected.id, (t) => ({ ...t, dueDate: value }));
    setSelected((prev) => ({ ...prev, dueDate: value }));
    persist(apiPatch(`/tasks/${selected.id}`, { due_date: value }));
    pushHistory(
      selected.id,
      "due_date_changed",
      value ? `Due date set to ${new Date(value).toLocaleDateString()}` : "Due date cleared"
    );
  }

  function addNoteOnly() {
    if (!note.trim()) return;
    pushHistory(selected.id, "note", note.trim());
    setNote("");
  }

  function toggleChecklistItem(key) {
    const item = selected.checklist.find((c) => c.key === key);
    const newChecklist = selected.checklist.map((c) => (c.key === key ? { ...c, done: !c.done } : c));
    setTasks((prev) => prev.map((t) => (t.id === selected.id ? { ...t, checklist: newChecklist } : t)));
    setSelected((prev) => ({ ...prev, checklist: newChecklist }));
    persist(apiPatch(`/tasks/${selected.id}`, { checklist: newChecklist }));
    pushHistory(selected.id, "checklist", `${item.done ? "Unchecked" : "Checked"}: ${item.label}`);
  }

  function switchProjectType(newType) {
    if (newType === selected.projectType) return;
    const newChecklist = buildChecklist(newType, selected.isOntario, selected.checklist);
    updateStore(selected.id, (t) => ({ ...t, projectType: newType, checklist: newChecklist }));
    setSelected((prev) => ({ ...prev, projectType: newType, checklist: newChecklist }));
    persist(apiPatch(`/tasks/${selected.id}`, { project_type: newType, checklist: newChecklist }));
    pushHistory(selected.id, "project_type_changed", `Project type set to ${newType} (was ${selected.projectType}) — checklist updated`);
  }

  function toggleOntario() {
    const newVal = !selected.isOntario;
    const newChecklist = buildChecklist(selected.projectType, newVal, selected.checklist);
    updateStore(selected.id, (t) => ({ ...t, isOntario: newVal, checklist: newChecklist }));
    setSelected((prev) => ({ ...prev, isOntario: newVal, checklist: newChecklist }));
    persist(apiPatch(`/tasks/${selected.id}`, { is_ontario: newVal, checklist: newChecklist }));
    pushHistory(selected.id, "ontario_changed", newVal ? "Marked as Ontario — Form 1000 added" : "Unmarked as Ontario — Form 1000 removed");
  }

  function forceCompleteChecklist() {
    if (!note.trim()) return;
    const remaining = selected.checklist.filter((c) => !c.done).map((c) => c.label);
    pushHistory(
      selected.id,
      "force_completed",
      `Marked complete without finishing checklist. Reason: "${note}". Left unchecked: ${remaining.length ? remaining.join(", ") : "none"}`
    );
    persist(
      apiPatch(`/tasks/${selected.id}`, {
        status: "done",
        resolution_note: note,
        completed_at: now.toISOString(),
      })
    );
    setTasks((prev) => prev.filter((t) => t.id !== selected.id));
    setSelected(null);
  }

  function saveTitle() {
    const trimmed = draftSummary.trim();
    if (!trimmed || trimmed === selected.summary) return;
    updateStore(selected.id, (t) => ({ ...t, summary: trimmed }));
    setSelected((prev) => ({ ...prev, summary: trimmed }));
    persist(apiPatch(apiPathFor(selected.id), { summary: trimmed }));
    pushHistory(selected.id, "title_changed", "Title edited");
  }

  function saveDescription() {
    const trimmed = draftDescription.trim();
    if (trimmed === (selected.description || "")) return;
    updateStore(selected.id, (t) => ({ ...t, description: trimmed }));
    setSelected((prev) => ({ ...prev, description: trimmed }));
    persist(apiPatch(`/recurring/${selected.id}`, { description: trimmed }));
    pushHistory(selected.id, "description_changed", "Description edited");
  }

  function saveRecurringNotes() {
    if (recurNotesDraft === (selected.notes || "")) return;
    setRecurringTasks((prev) =>
      prev.map((t) => (t.id === selected.id ? { ...t, notes: recurNotesDraft } : t))
    );
    setSelected((prev) => ({ ...prev, notes: recurNotesDraft }));
    persist(apiPatch(`/recurring/${selected.id}`, { notes: recurNotesDraft }));
    pushHistory(selected.id, "notes_updated", "Notes updated");
  }

  function markDoneThisCycle() {
    const doneAt = now.toISOString();
    setRecurringTasks((prev) =>
      prev.map((t) => (t.id === selected.id ? { ...t, lastDoneAt: doneAt, skipUntil: null } : t))
    );
    persist(apiPatch(`/recurring/${selected.id}`, { last_done_at: doneAt, skip_until: null }));
    pushHistory(selected.id, "cycle_completed", "Marked done for this cycle");
    setSelected(null);
  }

  function deferRecurring(days) {
    if (!note.trim()) return;
    const skipUntil = new Date(now.getTime() + days * 86400000).toISOString();
    setRecurringTasks((prev) =>
      prev.map((t) => (t.id === selected.id ? { ...t, skipUntil } : t))
    );
    persist(apiPatch(`/recurring/${selected.id}`, { skip_until: skipUntil }));
    pushHistory(selected.id, "cycle_deferred", `Skipped to ${new Date(skipUntil).toLocaleDateString()} — ${note}`);
    setSelected(null);
  }

  function deleteRecurring() {
    persist(apiDelete(`/recurring/${selected.id}`));
    setRecurringTasks((prev) => prev.filter((t) => t.id !== selected.id));
    setSelected(null);
  }

  function addRecurringTask() {
    const name = recurName.trim();
    if (!name) return;
    const tempId = `recur-${Date.now()}`;
    const optimistic = {
      id: tempId,
      summary: name,
      description: recurDescription.trim(),
      category: recurCategory || "General",
      priority: recurPriority,
      cadenceDays: recurCadence,
      createdAt: now.toISOString(),
      lastDoneAt: now.toISOString(),
      skipUntil: null,
      notes: "",
      recurring: true,
      history: [historyEvent("created", "Set up as a recurring task")],
    };
    setRecurringTasks((prev) => [...prev, optimistic]);
    flashNewlyAdded(tempId);
    setRecurName("");
    setRecurDescription("");
    setRecurCadence(7);
    setRecurCategory("");
    setRecurPriority("normal");
    setAddPanelOpen(false);

    apiPost("/recurring", {
      summary: name,
      description: optimistic.description,
      category: optimistic.category,
      priority: recurPriority,
      cadence_days: recurCadence,
    })
      .then((row) => {
        const real = normalizeRecurring(row);
        setRecurringTasks((prev) => prev.map((t) => (t.id === tempId ? real : t)));
      })
      .catch((err) => console.error("PUNCH sync failed:", err));
  }

  function resolveTask() {
    pushHistory(selected.id, "resolved", note.trim() || "Marked resolved");
    persist(
      apiPatch(`/tasks/${selected.id}`, {
        status: "done",
        resolution_note: note,
        completed_at: now.toISOString(),
      })
    );
    setTasks((prev) => prev.filter((t) => t.id !== selected.id));
    setSelected(null);
  }

  function deferTask(days) {
    if (!note.trim()) return; // require a reason so deferrals stay accountable
    const newDue = new Date(now.getTime() + days * 86400000).toISOString();
    pushHistory(selected.id, "deferred", `Deferred to ${new Date(newDue).toLocaleDateString()} — ${note}`);
    persist(apiPatch(`/tasks/${selected.id}`, { status: "snoozed", due_date: newDue, defer_reason: note }));
    setTasks((prev) =>
      prev.map((t) =>
        t.id === selected.id
          ? { ...t, status: "snoozed", dueDate: newDue, deferReason: note }
          : t
      )
    );
    setSelected(null);
  }

  function reactivateTask() {
    const event = historyEvent("reactivated", "Brought back from snoozed");
    const newHistory = [...(selected.history || []), event];
    setTasks((prev) =>
      prev.map((t) => (t.id === selected.id ? { ...t, status: "open", history: newHistory } : t))
    );
    persist(apiPatch(`/tasks/${selected.id}`, { status: "open", history: newHistory }));
    setSelected(null);
  }

  function nextTicketNumber() {
    const max = tasks.reduce((m, t) => Math.max(m, parseInt(t.ticket, 10) || 0), 0);
    return String(max + 1).padStart(4, "0");
  }

  function flashNewlyAdded(id) {
    setNewlyAddedIds((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setNewlyAddedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 650);
  }

  function addManualTask(parentTaskId) {
    const text = manualText.trim();
    if (!text) return;
    const tempId = `manual-${Date.now()}`;
    const category = manualCategory.trim() || "General";
    const sourceUrl = manualLink.trim() || null;
    const person = manualPerson.trim() || null;
    const optimistic = {
      id: tempId,
      ticket: nextTicketNumber(),
      summary: text,
      category,
      priority: manualPriority,
      createdAt: now.toISOString(),
      lastPriorityChangeAt: now.toISOString(),
      status: "open",
      list: "inbox",
      sourceUrl,
      person,
      parentTaskId: parentTaskId || null,
      history: [historyEvent("created", parentTaskId ? "Added directly into project" : "Added manually")],
    };
    setTasks((prev) => [...prev, optimistic]);
    flashNewlyAdded(tempId);
    setManualText("");
    setManualCategory("");
    setManualPriority("normal");
    setManualLink("");
    setManualPerson("");
    setAddPanelOpen(false);

    apiPost("/ingest", {
      source: "manual",
      raw_text: text,
      skip_classification: true,
      summary: text,
      category,
      priority: manualPriority,
      source_url: sourceUrl,
      person,
      list: "inbox",
      parent_task_id: parentTaskId || null,
    })
      .then((row) => {
        const real = normalizeTask(row);
        real.history = optimistic.history;
        setTasks((prev) => prev.map((t) => (t.id === tempId ? real : t)));
      })
      .catch((err) => console.error("PUNCH sync failed:", err));
  }

  function addFromRecord() {
    if (pickedRecordIdx === "") return;
    const pool = availableRecords[tab] || [];
    const record = pool[Number(pickedRecordIdx)];
    if (!record) return;
    const tempId = `record-${Date.now()}`;
    const isPortfolio = tab === "portfolio";
    const extra = isPortfolio
      ? { projectType: "T&M", isOntario: false, checklist: buildChecklist("T&M", false) }
      : {};
    const optimistic = {
      id: tempId,
      ticket: nextTicketNumber(),
      ...record,
      createdAt: now.toISOString(),
      lastPriorityChangeAt: now.toISOString(),
      status: "open",
      list: tab,
      person: record.person || null,
      history: [historyEvent("created", `Added from ${isPortfolio ? "Procore" : "saved search"} record picker`)],
      ...extra,
    };
    setTasks((prev) => [...prev, optimistic]);
    setAvailableRecords((prev) => ({
      ...prev,
      [tab]: prev[tab].filter((_, i) => i !== Number(pickedRecordIdx)),
    }));
    flashNewlyAdded(tempId);
    setPickedRecordIdx("");
    setAddPanelOpen(false);

    apiPost("/ingest", {
      source: tab,
      raw_text: record.summary,
      skip_classification: true,
      summary: record.summary,
      category: record.category,
      priority: record.priority,
      source_url: record.sourceUrl || null,
      person: record.person || null,
      list: tab,
      project_type: isPortfolio ? "T&M" : undefined,
      is_ontario: isPortfolio ? false : undefined,
      checklist: isPortfolio ? extra.checklist : undefined,
    })
      .then((row) => {
        const real = normalizeTask(row);
        real.history = optimistic.history;
        setTasks((prev) => prev.map((t) => (t.id === tempId ? real : t)));
      })
      .catch((err) => console.error("PUNCH sync failed:", err));
  }

  function askCopilot() {
    if (!note.trim()) return;
    setCopilotLoading(true);
    setCopilotSuggestions(null);
    setPickedSuggestion(null);
    // One Claude call, only on click, never polled in the background.
    apiPost("/copilot", { taskId: selected.id, note })
      .then((data) => {
        setCopilotLoading(false);
        setCopilotSuggestions(data.suggestions);
      })
      .catch((err) => {
        setCopilotLoading(false);
        console.error("Copilot request failed:", err);
      });
  }

  function sendCopilotSuggestion() {
    if (!pickedSuggestion) return;
    // TODO: real send via Graph API (email) or Teams connector, into the task's
    // stored conversationId if one exists, else a new message. pickedSuggestion.action
    // determines which connector/endpoint to call. The Copilot draft itself is real
    // (Claude-generated via /copilot) — only the actual send is still a stand-in.
    const newDue = new Date(now.getTime() + 3 * 86400000).toISOString();
    pushHistory(selected.id, "copilot_sent", `Copilot (${pickedSuggestion.action}): "${pickedSuggestion.text}"`);
    persist(
      apiPatch(`/tasks/${selected.id}`, {
        status: "snoozed",
        due_date: newDue,
        defer_reason: `${note} — message sent`,
      })
    );
    setTasks((prev) =>
      prev.map((t) =>
        t.id === selected.id
          ? { ...t, status: "snoozed", dueDate: newDue, deferReason: `${note} — message sent` }
          : t
      )
    );
    setCopilotSuggestions(null);
    setPickedSuggestion(null);
    setSelected(null);
  }

  return (
    <div
      style={{
        minHeight: "100%",
        background: "#1E1C1A",
        backgroundImage:
          "radial-gradient(circle at 20% 15%, rgba(226,135,26,0.05), transparent 45%)",
        padding: "36px 20px",
        fontFamily: "'Inter', sans-serif",
        position: "relative",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;700&display=swap');
        @keyframes inflate { 0% { transform: scale(0); } 60% { transform: scale(1.18); } 100% { transform: scale(1); } }
        @keyframes drift { 0%,100% { transform: translateY(0px); } 50% { transform: translateY(-4px); } }
        @keyframes rowIn { 0% { opacity: 0; transform: scale(0.9) translateY(-4px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes overduePulse { 0%,100% { filter: drop-shadow(0 0 0px rgba(193,64,28,0)); } 50% { filter: drop-shadow(0 0 7px rgba(193,64,28,0.85)); } }
        .punch-hover-edit { transition: border-color .12s ease, background-color .12s ease; }
        .punch-hover-edit:hover, .punch-hover-edit:focus { border-color: #4A473F !important; background-color: #1E1C1A !important; }
        .punch-color-hover { position: relative; }
        .punch-color-popover { display: none; }
        .punch-color-hover:hover .punch-color-popover { display: flex; }
      `}</style>

      {loading ? (
        <div
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            color: "#8B8680",
            fontSize: 13,
            textAlign: "center",
            padding: "80px 0",
          }}
        >
          LOADING PUNCH...
        </div>
      ) : loadError ? (
        <div
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            color: "#C1401C",
            fontSize: 13,
            textAlign: "center",
            padding: "80px 20px",
          }}
        >
          Couldn't reach the Worker: {loadError}
          <br />
          <span style={{ color: "#8B8680", fontSize: 11 }}>
            Check the Worker's deployed, CORS is open, and the URL in API_BASE is correct.
          </span>
        </div>
      ) : (
      <div style={{ margin: "0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div
            style={{
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 700,
              fontSize: 36,
              letterSpacing: "0.04em",
              color: "#F1ECE1",
              textTransform: "uppercase",
            }}
          >
            Punch
          </div>
          <button
            onClick={manualRefresh}
            disabled={isRefreshing}
            title="Check for new tasks now"
            style={{
              background: "transparent",
              border: "1px solid #3A3733",
              borderRadius: "50%",
              width: 28,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#8B8680",
              cursor: isRefreshing ? "default" : "pointer",
              marginTop: 6,
            }}
          >
            <RefreshIcon size={14} style={isRefreshing ? { animation: "spin 0.8s linear infinite" } : undefined} />
          </button>
        </div>
        <div
          style={{
            display: "flex",
            gap: 4,
            marginBottom: addPanelOpen ? 10 : 20,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {tabs.map((t) => {
            const count =
              t.id === "snoozed"
                ? snoozedTasks.length
                : t.id === "recurring"
                ? recurringTasks.length
                : tasks.filter((task) => task.status === "open" && task.list === t.id).length;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => {
                  setTab(t.id);
                  setAddPanelOpen(false);
                }}
                style={{
                  padding: "6px 14px",
                  background: active ? "#E2871A" : "transparent",
                  color: active ? "#1E1C1A" : "#8B8680",
                  border: `1px solid ${active ? "#E2871A" : "#3A3733"}`,
                  borderRadius: 4,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 700,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {t.label} ({count})
              </button>
            );
          })}
          {tab !== "snoozed" && tab !== "digest" && !openedProjectId && (
            <button
              onClick={() => setAddPanelOpen((v) => !v)}
              aria-label="Add"
              style={{
                marginLeft: 4,
                width: 26,
                height: 26,
                borderRadius: "50%",
                background: addPanelOpen ? "#F1ECE1" : "transparent",
                color: addPanelOpen ? "#1E1C1A" : "#8B8680",
                border: "1px solid #3A3733",
                cursor: "pointer",
                fontSize: 15,
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              +
            </button>
          )}
        </div>

        {addPanelOpen && tab !== "snoozed" && tab !== "digest" && !openedProjectId && (
          <div
            style={{
              background: "#2A2724",
              border: "1px solid #3A3733",
              borderRadius: 4,
              padding: 12,
              marginBottom: 20,
            }}
          >
            {currentTab.view === "bubbles" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 4, marginBottom: 2 }}>
                  {["task", "project"].map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setAddMode(mode)}
                      style={{
                        padding: "5px 12px",
                        background: addMode === mode ? "#E2871A" : "transparent",
                        color: addMode === mode ? "#1E1C1A" : "#8B8680",
                        border: `1px solid ${addMode === mode ? "#E2871A" : "#3A3733"}`,
                        borderRadius: 4,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 700,
                        fontSize: 10,
                        cursor: "pointer",
                      }}
                    >
                      {mode.toUpperCase()}
                    </button>
                  ))}
                </div>
                {addMode === "project" ? (
                  <>
                    <input
                      value={projectTitle}
                      onChange={(e) => setProjectTitle(e.target.value)}
                      placeholder="Project title..."
                      style={{
                        padding: 8,
                        borderRadius: 4,
                        border: "1px solid #4A473F",
                        background: "#1E1C1A",
                        color: "#F1ECE1",
                        fontFamily: "'Inter', sans-serif",
                        fontSize: 13,
                      }}
                    />
                    <textarea
                      value={projectDescription}
                      onChange={(e) => setProjectDescription(e.target.value)}
                      placeholder="Description (optional)"
                      rows={2}
                      style={{
                        padding: 8,
                        borderRadius: 4,
                        border: "1px solid #4A473F",
                        background: "#1E1C1A",
                        color: "#F1ECE1",
                        fontFamily: "'Inter', sans-serif",
                        fontSize: 12.5,
                        resize: "vertical",
                      }}
                    />
                    <div style={{ display: "flex", gap: 6 }}>
                      {PROJECT_COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => setProjectColor(c)}
                          aria-label={`Set color ${c}`}
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: "50%",
                            background: c,
                            border: projectColor === c ? "2px solid #F1ECE1" : "1px solid #3A3733",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        />
                      ))}
                    </div>
                    <button
                      onClick={createProject}
                      style={{
                        padding: "8px 20px",
                        background: "#E2871A",
                        color: "#1E1C1A",
                        border: "none",
                        borderRadius: 4,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 700,
                        fontSize: 11,
                        cursor: "pointer",
                        alignSelf: "flex-start",
                      }}
                    >
                      CREATE PROJECT
                    </button>
                  </>
                ) : (
              <>
                <input
                  value={manualText}
                  onChange={(e) => setManualText(e.target.value)}
                  placeholder="Task description..."
                  style={{
                    padding: 8,
                    borderRadius: 4,
                    border: "1px solid #4A473F",
                    background: "#1E1C1A",
                    color: "#F1ECE1",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 13,
                  }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <select
                    value={manualCategory || "General"}
                    onChange={(e) => setManualCategory(e.target.value)}
                    style={{
                      flex: 1,
                      padding: 8,
                      borderRadius: 4,
                      border: "1px solid #4A473F",
                      background: "#1E1C1A",
                      color: "#F1ECE1",
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 12.5,
                    }}
                  >
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <select
                    value={manualPriority}
                    onChange={(e) => setManualPriority(e.target.value)}
                    style={{
                      padding: 8,
                      borderRadius: 4,
                      border: `1px solid ${priorityColor[manualPriority]}`,
                      background: "#1E1C1A",
                      color: priorityColor[manualPriority],
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 700,
                      fontSize: 11,
                    }}
                  >
                    {priorityOptions.map((p) => (
                      <option key={p} value={p}>
                        {p.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={manualLink}
                    onChange={(e) => setManualLink(e.target.value)}
                    placeholder="Link (optional) — https://..."
                    style={{
                      flex: 1,
                      padding: 8,
                      borderRadius: 4,
                      border: "1px solid #4A473F",
                      background: "#1E1C1A",
                      color: "#F1ECE1",
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 12.5,
                    }}
                  />
                  <input
                    value={manualPerson}
                    onChange={(e) => setManualPerson(e.target.value)}
                    placeholder="Person (optional)"
                    style={{
                      width: 130,
                      padding: 8,
                      borderRadius: 4,
                      border: "1px solid #4A473F",
                      background: "#1E1C1A",
                      color: "#F1ECE1",
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 12.5,
                    }}
                  />
                  <button
                    onClick={() => addManualTask()}
                    style={{
                      padding: "8px 20px",
                      background: "#E2871A",
                      color: "#1E1C1A",
                      border: "none",
                      borderRadius: 4,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 700,
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    ADD
                  </button>
                </div>
              </>
                )}
              </div>
            ) : currentTab.view === "recurring" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <input
                  value={recurName}
                  onChange={(e) => setRecurName(e.target.value)}
                  placeholder="Name (e.g. Payroll direct cost check)"
                  style={{
                    padding: 8,
                    borderRadius: 4,
                    border: "1px solid #4A473F",
                    background: "#1E1C1A",
                    color: "#F1ECE1",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 13,
                  }}
                />
                <input
                  value={recurDescription}
                  onChange={(e) => setRecurDescription(e.target.value)}
                  placeholder="Description (optional)"
                  style={{
                    padding: 8,
                    borderRadius: 4,
                    border: "1px solid #4A473F",
                    background: "#1E1C1A",
                    color: "#F1ECE1",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 12.5,
                  }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <select
                    value={recurCadence}
                    onChange={(e) => setRecurCadence(Number(e.target.value))}
                    style={{
                      flex: 1,
                      padding: 8,
                      borderRadius: 4,
                      border: "1px solid #4A473F",
                      background: "#1E1C1A",
                      color: "#F1ECE1",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 700,
                      fontSize: 11,
                    }}
                  >
                    {cadenceOptions.map((c) => (
                      <option key={c.label} value={c.days}>
                        {c.label.toUpperCase()}
                      </option>
                    ))}
                  </select>
                  <select
                    value={recurCategory || "General"}
                    onChange={(e) => setRecurCategory(e.target.value)}
                    style={{
                      flex: 1,
                      padding: 8,
                      borderRadius: 4,
                      border: "1px solid #4A473F",
                      background: "#1E1C1A",
                      color: "#F1ECE1",
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 12.5,
                    }}
                  >
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <select
                    value={recurPriority}
                    onChange={(e) => setRecurPriority(e.target.value)}
                    style={{
                      padding: 8,
                      borderRadius: 4,
                      border: `1px solid ${priorityColor[recurPriority]}`,
                      background: "#1E1C1A",
                      color: priorityColor[recurPriority],
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 700,
                      fontSize: 11,
                    }}
                  >
                    {priorityOptions.map((p) => (
                      <option key={p} value={p}>
                        {p.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={addRecurringTask}
                  style={{
                    padding: "8px 20px",
                    background: "#E2871A",
                    color: "#1E1C1A",
                    border: "none",
                    borderRadius: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 700,
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  ADD RECURRING TASK
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select
                  value={pickedRecordIdx}
                  onChange={(e) => setPickedRecordIdx(e.target.value)}
                  style={{
                    flex: 1,
                    padding: 8,
                    borderRadius: 4,
                    border: "1px solid #4A473F",
                    background: "#1E1C1A",
                    color: "#F1ECE1",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 13,
                  }}
                >
                  <option value="">
                    {(availableRecords[tab] || []).length === 0
                      ? "No records missing from this list"
                      : "Select a record not currently on this list..."}
                  </option>
                  {(availableRecords[tab] || []).map((r, i) => (
                    <option key={i} value={i}>
                      {r.summary}
                    </option>
                  ))}
                </select>
                <button
                  onClick={addFromRecord}
                  disabled={pickedRecordIdx === ""}
                  style={{
                    padding: "8px 16px",
                    background: pickedRecordIdx === "" ? "#4A473F" : "#E2871A",
                    color: pickedRecordIdx === "" ? "#8B8680" : "#1E1C1A",
                    border: "none",
                    borderRadius: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 700,
                    fontSize: 11,
                    cursor: pickedRecordIdx === "" ? "not-allowed" : "pointer",
                  }}
                >
                  ADD
                </button>
              </div>
            )}
          </div>
        )}

        <div style={{ maxWidth: WIDTH, margin: "0 auto" }}>
        {tab === "digest" ? (
          <div>
            <button
              onClick={generateDigest}
              disabled={digestGenerating}
              style={{
                padding: "9px 16px",
                background: digestGenerating ? "#E9E2D2" : "#E2871A",
                color: "#1E1C1A",
                border: "none",
                borderRadius: 4,
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 700,
                fontSize: 11,
                cursor: digestGenerating ? "default" : "pointer",
                marginBottom: 14,
              }}
            >
              {digestGenerating ? "GENERATING..." : "GENERATE DIGEST NOW"}
            </button>

            {digestError && (
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  color: "#8B8680",
                  marginBottom: 14,
                }}
              >
                {digestError}
              </div>
            )}

            {digestLoading ? (
              <div style={{ fontFamily: "'JetBrains Mono', monospace", color: "#8B8680", fontSize: 12 }}>
                LOADING...
              </div>
            ) : digests.length === 0 ? (
              <div style={{ fontFamily: "'JetBrains Mono', monospace", color: "#5C5850", fontSize: 13 }}>
                No digests generated yet.
              </div>
            ) : (
              digests.map((d) => (
                <div
                  key={d.id}
                  style={{
                    background: "#2A2724",
                    border: "1px solid #3A3733",
                    borderRadius: 4,
                    padding: "14px 16px",
                    marginBottom: 12,
                  }}
                >
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: "#8B8680",
                      marginBottom: 8,
                    }}
                  >
                    {formatDateTime(d.created_at)}
                  </div>
                  <div
                    style={{
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 13.5,
                      color: "#F1ECE1",
                      lineHeight: 1.5,
                      marginBottom: 10,
                    }}
                  >
                    {d.summary}
                  </div>
                  {(() => {
                    let suggestions = [];
                    try {
                      suggestions = JSON.parse(d.prompt_notes || "[]");
                    } catch (e) {
                      suggestions = [];
                    }
                    return suggestions.length > 0 ? (
                      <div>
                        <div
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 10,
                            color: "#E2871A",
                            marginBottom: 6,
                          }}
                        >
                          SUGGESTED PROMPT TWEAKS
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {suggestions.map((s, i) => (
                            <li
                              key={i}
                              style={{
                                fontFamily: "'Inter', sans-serif",
                                fontSize: 12.5,
                                color: "#D9D2C4",
                                marginBottom: 4,
                                lineHeight: 1.4,
                              }}
                            >
                              {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null;
                  })()}
                </div>
              ))
            )}
          </div>
        ) : activeTasks.length === 0 ? (
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              color: "#5C5850",
              fontSize: 13,
              padding: "60px 0",
              textAlign: "center",
            }}
          >
            {tab === "snoozed"
              ? "Nothing deferred right now."
              : tab === "recurring"
              ? "No recurring tasks set up yet."
              : "LIST CLEAR — nothing punched in."}
          </div>
        ) : currentTab.view === "bubbles" ? (
          <div style={{ position: "relative" }}>
            {openedProject && (
              <div
                style={{
                  position: "absolute",
                  top: 10,
                  left: 10,
                  zIndex: 5,
                  width: 250,
                  background: "#2A2724",
                  border: `1px solid ${openedProject.color || DEFAULT_PROJECT_COLOR}`,
                  borderRadius: 6,
                  padding: 10,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 6 }}>
                  <div className="punch-color-hover" style={{ marginTop: 5, flexShrink: 0 }}>
                    <div
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: "50%",
                        background: openedProject.color || DEFAULT_PROJECT_COLOR,
                        border: "1px solid #F1ECE1",
                        cursor: "pointer",
                      }}
                      title="Change color"
                    />
                    <div
                      className="punch-color-popover"
                      style={{
                        position: "absolute",
                        top: 20,
                        left: 0,
                        zIndex: 10,
                        flexWrap: "wrap",
                        gap: 4,
                        width: 96,
                        background: "#1E1C1A",
                        border: "1px solid #3A3733",
                        borderRadius: 4,
                        padding: 6,
                      }}
                    >
                      {PROJECT_COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => saveProjectColor(c)}
                          aria-label={`Set color ${c}`}
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: "50%",
                            background: c,
                            border: (openedProject.color || DEFAULT_PROJECT_COLOR) === c ? "2px solid #F1ECE1" : "1px solid #3A3733",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  <input
                    className="punch-hover-edit"
                    value={draftProjectTitle}
                    onChange={(e) => setDraftProjectTitle(e.target.value)}
                    onBlur={saveProjectTitle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        saveProjectTitle();
                        e.target.blur();
                      }
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontFamily: "'Inter', sans-serif",
                      fontWeight: 700,
                      fontSize: 13.5,
                      color: "#F1ECE1",
                      background: "transparent",
                      border: "1px solid transparent",
                      borderRadius: 3,
                      padding: "2px 4px",
                    }}
                  />
                  <button
                    onClick={closeProject}
                    aria-label="Close"
                    title="Back to board"
                    style={{
                      flexShrink: 0,
                      background: "transparent",
                      color: "#8B8680",
                      border: "none",
                      cursor: "pointer",
                      fontSize: 15,
                      lineHeight: 1,
                      padding: 2,
                    }}
                  >
                    ×
                  </button>
                </div>

                <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                  <select
                    className="punch-hover-edit"
                    value={openedProject.priority}
                    onChange={(e) => saveProjectField("priority", "priority", e.target.value)}
                    style={{
                      flex: 1,
                      padding: "3px 5px",
                      borderRadius: 3,
                      border: "1px solid transparent",
                      background: "transparent",
                      color: priorityColor[openedProject.priority] || priorityColor.normal,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 700,
                      fontSize: 10,
                    }}
                  >
                    {priorityOptions.map((p) => (
                      <option key={p} value={p}>
                        {p.toUpperCase()}
                      </option>
                    ))}
                  </select>
                  <select
                    className="punch-hover-edit"
                    value={openedProject.category || "Project"}
                    onChange={(e) => saveProjectField("category", "category", e.target.value)}
                    style={{
                      flex: 1,
                      padding: "3px 5px",
                      borderRadius: 3,
                      border: "1px solid transparent",
                      background: "transparent",
                      color: "#B8B2A4",
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 11,
                    }}
                  >
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <textarea
                  className="punch-hover-edit"
                  value={draftProjectDescription}
                  onChange={(e) => setDraftProjectDescription(e.target.value)}
                  onBlur={saveProjectDescription}
                  placeholder="Description (optional)"
                  rows={2}
                  style={{
                    width: "100%",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 11.5,
                    color: "#B8B2A4",
                    background: "transparent",
                    border: "1px solid transparent",
                    borderRadius: 3,
                    padding: "2px 4px",
                    marginBottom: 8,
                    resize: "vertical",
                    boxSizing: "border-box",
                  }}
                />

                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 9.5,
                    fontWeight: 700,
                    color: "#6B7A8C",
                    marginBottom: 8,
                  }}
                >
                  {projectChildren.length} ITEM{projectChildren.length === 1 ? "" : "S"}
                </div>

                <button
                  onClick={() => setAddTaskPanelOpen((v) => !v)}
                  style={{
                    width: "100%",
                    padding: "6px 0",
                    background: addTaskPanelOpen ? "#F1ECE1" : "transparent",
                    color: addTaskPanelOpen ? "#1E1C1A" : "#E2871A",
                    border: "1px solid #E2871A",
                    borderRadius: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 700,
                    fontSize: 10.5,
                    cursor: "pointer",
                  }}
                >
                  + ADD TASK
                </button>

                {addTaskPanelOpen && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                      {["existing", "new"].map((mode) => (
                        <button
                          key={mode}
                          onClick={() => setAddTaskMode(mode)}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: addTaskMode === mode ? "#E2871A" : "transparent",
                            color: addTaskMode === mode ? "#1E1C1A" : "#8B8680",
                            border: `1px solid ${addTaskMode === mode ? "#E2871A" : "#3A3733"}`,
                            borderRadius: 4,
                            fontFamily: "'JetBrains Mono', monospace",
                            fontWeight: 700,
                            fontSize: 9,
                            cursor: "pointer",
                          }}
                        >
                          {mode === "existing" ? "EXISTING" : "NEW"}
                        </button>
                      ))}
                    </div>

                    {addTaskMode === "existing" ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <select
                          value={pickedChildIdx}
                          onChange={(e) => setPickedChildIdx(e.target.value)}
                          style={{
                            padding: 6,
                            borderRadius: 4,
                            border: "1px solid #4A473F",
                            background: "#1E1C1A",
                            color: "#F1ECE1",
                            fontFamily: "'Inter', sans-serif",
                            fontSize: 11.5,
                          }}
                        >
                          <option value="">Pick a task...</option>
                          {tasks
                            .filter((t) => t.status === "open" && t.list === "inbox" && !t.parentTaskId && !t.isProject)
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.summary}
                              </option>
                            ))}
                        </select>
                        <button
                          onClick={() => {
                            addExistingTaskToProject();
                            setAddTaskPanelOpen(false);
                          }}
                          disabled={!pickedChildIdx}
                          style={{
                            padding: "7px 0",
                            background: pickedChildIdx ? "#E2871A" : "#4A473F",
                            color: "#1E1C1A",
                            border: "none",
                            borderRadius: 4,
                            fontFamily: "'JetBrains Mono', monospace",
                            fontWeight: 700,
                            fontSize: 10.5,
                            cursor: pickedChildIdx ? "pointer" : "default",
                          }}
                        >
                          ADD
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <input
                          value={manualText}
                          onChange={(e) => setManualText(e.target.value)}
                          placeholder="Task description..."
                          style={{
                            padding: 6,
                            borderRadius: 4,
                            border: "1px solid #4A473F",
                            background: "#1E1C1A",
                            color: "#F1ECE1",
                            fontFamily: "'Inter', sans-serif",
                            fontSize: 11.5,
                          }}
                        />
                        <div style={{ display: "flex", gap: 6 }}>
                          <select
                            value={manualCategory || "General"}
                            onChange={(e) => setManualCategory(e.target.value)}
                            style={{
                              flex: 1,
                              padding: 6,
                              borderRadius: 4,
                              border: "1px solid #4A473F",
                              background: "#1E1C1A",
                              color: "#F1ECE1",
                              fontFamily: "'Inter', sans-serif",
                              fontSize: 11,
                            }}
                          >
                            {categories.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          <select
                            value={manualPriority}
                            onChange={(e) => setManualPriority(e.target.value)}
                            style={{
                              padding: 6,
                              borderRadius: 4,
                              border: `1px solid ${priorityColor[manualPriority]}`,
                              background: "#1E1C1A",
                              color: priorityColor[manualPriority],
                              fontFamily: "'JetBrains Mono', monospace",
                              fontWeight: 700,
                              fontSize: 10,
                            }}
                          >
                            {priorityOptions.map((p) => (
                              <option key={p} value={p}>
                                {p.toUpperCase()}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button
                          onClick={() => {
                            addManualTask(openedProjectId);
                            setAddTaskPanelOpen(false);
                          }}
                          style={{
                            padding: "7px 0",
                            background: "#E2871A",
                            color: "#1E1C1A",
                            border: "none",
                            borderRadius: 4,
                            fontFamily: "'JetBrains Mono', monospace",
                            fontWeight: 700,
                            fontSize: 10.5,
                            cursor: "pointer",
                          }}
                        >
                          ADD
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div style={{ marginTop: 10, textAlign: "right" }}>
                  {deletingProjectConfirm ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                      <span style={{ fontSize: 10, color: "#C1401C", fontFamily: "'Inter', sans-serif" }}>
                        Delete project? Tasks inside just get un-nested.
                      </span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          onClick={deleteProject}
                          style={{
                            padding: "5px 10px",
                            background: "#C1401C",
                            color: "#F1ECE1",
                            border: "none",
                            borderRadius: 4,
                            fontFamily: "'JetBrains Mono', monospace",
                            fontWeight: 700,
                            fontSize: 9.5,
                            cursor: "pointer",
                          }}
                        >
                          CONFIRM
                        </button>
                        <button
                          onClick={() => setDeletingProjectConfirm(false)}
                          style={{
                            padding: "5px 10px",
                            background: "transparent",
                            color: "#8B8680",
                            border: "1px solid #3A3733",
                            borderRadius: 4,
                            fontFamily: "'JetBrains Mono', monospace",
                            fontWeight: 700,
                            fontSize: 9.5,
                            cursor: "pointer",
                          }}
                        >
                          CANCEL
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeletingProjectConfirm(true)}
                      style={{
                        padding: "4px 8px",
                        background: "transparent",
                        color: "#8A5A4A",
                        border: "1px solid #3A3733",
                        borderRadius: 4,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 700,
                        fontSize: 9.5,
                        cursor: "pointer",
                      }}
                    >
                      DELETE PROJECT
                    </button>
                  )}
                </div>
              </div>
            )}
            <svg
              ref={svgRef}
              width={WIDTH}
              height={HEIGHT}
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              style={{ display: "block", margin: "0 auto", touchAction: "none", overflow: "visible" }}
              onPointerMove={handleSvgPointerMove}
              onPointerUp={handleSvgPointerUp}
              onPointerLeave={handleSvgPointerUp}
              onClick={(e) => {
                if (openedProjectId && e.target === e.currentTarget) closeProject();
              }}
            >
              <defs>
                <filter id="punchBlur" x="-30%" y="-30%" width="160%" height="160%">
                  <feGaussianBlur stdDeviation="4" />
                </filter>
                {openedProject && (
                  <radialGradient id="punchProjectGradient" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor={openedProject.color || DEFAULT_PROJECT_COLOR} stopOpacity="0.12" />
                    <stop offset="65%" stopColor={openedProject.color || DEFAULT_PROJECT_COLOR} stopOpacity="0.28" />
                    <stop offset="100%" stopColor={openedProject.color || DEFAULT_PROJECT_COLOR} stopOpacity="0.62" />
                  </radialGradient>
                )}
              </defs>

              {openedProjectId ? (
                <>
                  {/* Background pass: the normal board, faded + blurred — visible both around
                      the project's footprint and bleeding through its translucent disc below. */}
                  <g style={{ filter: "url(#punchBlur)", opacity: 0.4, pointerEvents: "none" }}>
                    {nodes.filter((n) => n.id !== openedProjectId).map((n, i) => renderBubble(n, i))}
                  </g>
                  {/* Project disc pass: a radial gradient so the background shows through more
                      at the center than at the rim, which reads as the container's boundary. */}
                  <circle
                    cx={WIDTH / 2}
                    cy={HEIGHT / 2}
                    r={PROJECT_RING_RADIUS}
                    fill="url(#punchProjectGradient)"
                    stroke={openedProject ? openedProject.color || DEFAULT_PROJECT_COLOR : DEFAULT_PROJECT_COLOR}
                    strokeWidth="2.5"
                    style={{ pointerEvents: "none" }}
                  />
                  {/* Foreground pass: crisp, fully-interactive children */}
                  {childNodes.length === 0 ? (
                    <text
                      x={WIDTH / 2}
                      y={HEIGHT / 2}
                      textAnchor="middle"
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 12,
                        fill: "#8B8680",
                        pointerEvents: "none",
                      }}
                    >
                      Nothing in here yet — add a task above.
                    </text>
                  ) : (
                    childNodes.map((n, i) => renderBubble(n, i))
                  )}
                </>
              ) : (
                nodes.map((n, i) => renderBubble(n, i))
              )}

              {/* Hover tooltip rendered last so it always paints above every bubble,
                  regardless of draw order. */}
              {(() => {
                const hoveredNode = nodes.find((n) => n.id === hoveredId) || childNodes.find((n) => n.id === hoveredId);
                if (!hoveredNode) return null;
                const color =
                  hoveredNode.isProject
                    ? hoveredNode.color || DEFAULT_PROJECT_COLOR
                    : tab === "snoozed"
                    ? "#6B7A8C"
                    : priorityColor[hoveredNode.effPriority];
              // Projects don't need a change-history line in their tooltip — the
              // preview dots already communicate "what's inside."
              const latest =
                !hoveredNode.isProject && hoveredNode.history && hoveredNode.history.length > 0
                  ? hoveredNode.history[hoveredNode.history.length - 1]
                  : null;
              return (
                <g
                  transform={`translate(${hoveredNode.x},${hoveredNode.y})`}
                  style={{ pointerEvents: "auto" }}
                  onPointerEnter={(e) => handleHoverEnter(hoveredNode.id, e)}
                  onPointerLeave={handleHoverLeave}
                >
                  <foreignObject x={-110} y={hoveredNode.r + 8} width={220} height={latest ? 148 : 108}>
                    <div
                      style={{
                        background: "#F1ECE1",
                        border: `1px solid ${color}`,
                        borderRadius: 4,
                        padding: "8px 10px",
                        fontFamily: "'Inter', sans-serif",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: 3,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 9,
                            fontWeight: 700,
                            color,
                          }}
                        >
                          {hoveredNode.category.toUpperCase()}
                        </div>
                        {hoveredNode.sourceUrl && (
                          <a
                            href={hoveredNode.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{ display: "flex", color: "#6B7A8C" }}
                            title="View source record"
                          >
                            <LinkIcon size={11} />
                          </a>
                        )}
                      </div>
                      <div style={{ fontSize: 11.5, color: "#2A2419", lineHeight: 1.3, marginBottom: 5 }}>
                        {hoveredNode.summary}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 6,
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 9,
                          color: "#8A8375",
                          marginBottom: latest ? 6 : 0,
                        }}
                      >
                        {/* Manual tasks have no real sender — omit the field entirely
                            rather than showing a hollow "UNKNOWN SENDER" fallback. */}
                        {[
                          (hoveredNode.source || "unknown").toUpperCase(),
                          hoveredNode.person
                            ? hoveredNode.person.toUpperCase()
                            : hoveredNode.source === "manual"
                            ? null
                            : "UNKNOWN SENDER",
                          hoveredNode.createdAt
                            ? formatDateTime(hoveredNode.createdAt)
                            : "UNKNOWN DATE",
                        ]
                          .filter(Boolean)
                          .map((part, i, arr) => (
                            <React.Fragment key={i}>
                              <span>{part}</span>
                              {i < arr.length - 1 && <span>·</span>}
                            </React.Fragment>
                          ))}
                      </div>
                      {latest && (
                        <div
                          style={{
                            fontSize: 9.5,
                            color: "#8A8375",
                            lineHeight: 1.3,
                            borderTop: "1px dashed #C9C0AC",
                            paddingTop: 4,
                          }}
                        >
                          {formatDateTime(latest.at)} · {latest.type.replace("_", " ").toUpperCase()}
                          {": "}
                          {latest.text.length > 60 ? latest.text.slice(0, 60) + "…" : latest.text}
                        </div>
                      )}
                    </div>
                  </foreignObject>
                </g>
              );
            })()}
            </svg>
          </div>
        ) : currentTab.view === "recurring" ? (
          <div>
            {activeTasks.map((rt) => {
              const due = daysUntilDue(rt);
              const isOverdue = due < 0;
              const isDueToday = due === 0;
              const color = isOverdue ? "#C1401C" : isDueToday ? "#E2871A" : "#5B7A5B";
              const dueLabel = isOverdue ? `${Math.abs(due)}D OVERDUE` : isDueToday ? "DUE TODAY" : `DUE IN ${due}D`;
              return (
                <div
                  key={rt.id}
                  onClick={() => openDetail(rt)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    background: "#2A2724",
                    border: `1px solid ${color}55`,
                    borderLeft: `4px solid ${color}`,
                    borderRadius: 4,
                    padding: "10px 12px",
                    marginBottom: 8,
                    cursor: "pointer",
                    animation: newlyAddedIds.has(rt.id) ? "rowIn 0.4s ease-out both" : undefined,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: "'Inter', sans-serif",
                        fontSize: 13.5,
                        color: "#F1ECE1",
                        marginBottom: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {rt.summary}
                    </div>
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        color: "#8B8680",
                      }}
                    >
                      {cadenceOptions.find((c) => c.days === rt.cadenceDays)?.label.toUpperCase() || `EVERY ${rt.cadenceDays}D`} · {rt.category.toUpperCase()}
                    </div>
                  </div>
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10.5,
                      fontWeight: 700,
                      color,
                      flexShrink: 0,
                    }}
                  >
                    {dueLabel}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div>
            {activeTasks.map((t) => {
              const color = priorityColor[effectivePriority(t)];
              const age = daysOpen(t.createdAt);
              return (
                <div
                  key={t.id}
                  onClick={() => openDetail(t)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    background: "#2A2724",
                    border: `1px solid ${color}55`,
                    borderLeft: `4px solid ${color}`,
                    borderRadius: 4,
                    padding: "10px 12px",
                    marginBottom: 8,
                    cursor: "pointer",
                    animation: newlyAddedIds.has(t.id) ? "rowIn 0.4s ease-out both" : undefined,
                  }}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      border: "1.5px solid #5C5850",
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: "'Inter', sans-serif",
                        fontSize: 13.5,
                        color: "#F1ECE1",
                        marginBottom: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.summary}
                    </div>
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        color: "#8B8680",
                      }}
                    >
                      #{t.ticket} · {t.category.toUpperCase()}
                    </div>
                  </div>
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10.5,
                      fontWeight: 700,
                      color,
                      flexShrink: 0,
                    }}
                  >
                    {age}D
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 16,
            justifyContent: "center",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10.5,
            color: "#8B8680",
            marginTop: 8,
          }}
        >
          {Object.entries(priorityColor).map(([k, c]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: c }} />
              {k.toUpperCase()}
            </div>
          ))}
        </div>
        </div>
      </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(10,9,8,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10,
          }}
          onClick={() => setSelected(null)}
        >
          <div
            style={{
              background: "#F1ECE1",
              width: 380,
              maxWidth: "90vw",
              borderRadius: 6,
              padding: 24,
              position: "relative",
              boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setSelected(null)}
              style={{
                position: "absolute",
                top: 14,
                right: 14,
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#8A8375",
              }}
              aria-label="Close"
            >
              <X size={18} />
            </button>

            <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
              <button
                onClick={() => setModalTab("details")}
                style={{
                  padding: "3px 10px",
                  background: modalTab === "details" ? "#2A2419" : "transparent",
                  color: modalTab === "details" ? "#F1ECE1" : "#8A8375",
                  border: "none",
                  borderRadius: 3,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 700,
                  fontSize: 10,
                  cursor: "pointer",
                }}
              >
                DETAILS
              </button>
              <button
                onClick={() => setModalTab("history")}
                style={{
                  padding: "3px 10px",
                  background: modalTab === "history" ? "#2A2419" : "transparent",
                  color: modalTab === "history" ? "#F1ECE1" : "#8A8375",
                  border: "none",
                  borderRadius: 3,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 700,
                  fontSize: 10,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <HistoryIcon size={10} /> HISTORY ({(selected.history || []).length})
              </button>
            </div>

            {modalTab === "history" ? (
              <div style={{ maxHeight: 380, overflowY: "auto" }}>
                {[...(selected.history || [])].reverse().map((ev, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "8px 0",
                      borderTop: i === 0 ? "none" : "1px solid #E9E2D2",
                    }}
                  >
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        color: "#B8AF9E",
                        marginBottom: 2,
                      }}
                    >
                      {formatDateTime(ev.at)} · {ev.type.replace("_", " ").toUpperCase()}
                    </div>
                    <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: "#2A2419" }}>
                      {ev.text}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                {selected.recurring ? (
                  <>
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        color: "#8A8375",
                        marginBottom: 8,
                      }}
                    >
                      RECURRING
                    </div>
                    <textarea
                      value={draftSummary}
                      onChange={(e) => setDraftSummary(e.target.value)}
                      onBlur={saveTitle}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          saveTitle();
                          e.target.blur();
                        }
                      }}
                      rows={1}
                      style={{
                        width: "100%",
                        fontFamily: "'Inter', sans-serif",
                        fontWeight: 600,
                        fontSize: 16,
                        color: "#2A2419",
                        marginBottom: 6,
                        lineHeight: 1.4,
                        border: "1px solid transparent",
                        borderRadius: 3,
                        padding: "2px 4px",
                        marginLeft: -4,
                        background: "transparent",
                        resize: "none",
                        outline: "none",
                      }}
                      onFocus={(e) => (e.target.style.border = "1px solid #C9C0AC")}
                    />
                    <textarea
                      value={draftDescription}
                      onChange={(e) => setDraftDescription(e.target.value)}
                      onBlur={saveDescription}
                      placeholder="Description..."
                      rows={2}
                      style={{
                        width: "100%",
                        fontFamily: "'Inter', sans-serif",
                        fontSize: 13,
                        color: "#5C5850",
                        marginBottom: 12,
                        lineHeight: 1.4,
                        border: "1px solid transparent",
                        borderRadius: 3,
                        padding: "2px 4px",
                        marginLeft: -4,
                        background: "transparent",
                        resize: "none",
                        outline: "none",
                      }}
                      onFocus={(e) => (e.target.style.border = "1px solid #C9C0AC")}
                    />

                    {getLatestActionableEvent(selected.history) && (
                      <div
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 10,
                          color: "#8A8375",
                          marginBottom: 10,
                          lineHeight: 1.4,
                        }}
                      >
                        {formatDateTime(getLatestActionableEvent(selected.history).at)}
                        {" · "}
                        {getLatestActionableEvent(selected.history).type.replace("_", " ").toUpperCase()}
                        {": "}
                        <span style={{ color: "#5C5850" }}>
                          {getLatestActionableEvent(selected.history).text}
                        </span>
                      </div>
                    )}

                    <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                      <select
                        value={selected.cadenceDays}
                        onChange={(e) => {
                          const days = Number(e.target.value);
                          updateStore(selected.id, (t) => ({ ...t, cadenceDays: days }));
                          setSelected((prev) => ({ ...prev, cadenceDays: days }));
                          pushHistory(selected.id, "cadence_changed", `Cadence set to every ${days}d`);
                        }}
                        style={{
                          padding: "4px 8px",
                          borderRadius: 4,
                          border: "1px solid #C9C0AC",
                          background: "transparent",
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 11,
                          fontWeight: 700,
                          color: "#5C5850",
                        }}
                      >
                        {cadenceOptions.map((c) => (
                          <option key={c.label} value={c.days}>
                            {c.label.toUpperCase()}
                          </option>
                        ))}
                      </select>
                      <select
                        value={categories.includes(selected.category) ? selected.category : "__custom__"}
                        onChange={(e) => saveCategoryDirect(e.target.value)}
                        style={{
                          padding: "4px 8px",
                          borderRadius: 4,
                          border: "1px solid #C9C0AC",
                          background: "transparent",
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 11,
                          color: "#5C5850",
                        }}
                      >
                        {!categories.includes(selected.category) && (
                          <option value="__custom__">{selected.category.toUpperCase()}</option>
                        )}
                        {categories.map((c) => (
                          <option key={c} value={c}>
                            {c.toUpperCase()}
                          </option>
                        ))}
                      </select>
                      <select
                        value={selected.priority}
                        onChange={(e) => savePriority(e.target.value)}
                        style={{
                          padding: "4px 8px",
                          borderRadius: 4,
                          border: `1px solid ${priorityColor[selected.priority]}`,
                          background: "transparent",
                          fontFamily: "'JetBrains Mono', monospace",
                          fontWeight: 700,
                          fontSize: 11,
                          color: priorityColor[selected.priority],
                        }}
                      >
                        {priorityOptions.map((p) => (
                          <option key={p} value={p}>
                            {p.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        fontWeight: 700,
                        color:
                          daysUntilDue(selected) < 0
                            ? "#C1401C"
                            : daysUntilDue(selected) === 0
                            ? "#E2871A"
                            : "#5B7A5B",
                        marginBottom: 16,
                      }}
                    >
                      {daysUntilDue(selected) < 0
                        ? `${Math.abs(daysUntilDue(selected))}D OVERDUE`
                        : daysUntilDue(selected) === 0
                        ? "DUE TODAY"
                        : `DUE IN ${daysUntilDue(selected)}D`}
                      {" · LAST DONE "}
                      {selected.lastDoneAt ? new Date(selected.lastDoneAt).toLocaleDateString() : "NEVER"}
                    </div>

                    <label
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        color: "#5C5850",
                        display: "block",
                        marginBottom: 6,
                      }}
                    >
                      NOTES
                    </label>
                    <textarea
                      value={recurNotesDraft}
                      onChange={(e) => setRecurNotesDraft(e.target.value)}
                      onBlur={saveRecurringNotes}
                      placeholder="Anything worth remembering for next time..."
                      style={{
                        width: "100%",
                        minHeight: 60,
                        padding: 8,
                        borderRadius: 4,
                        border: "1px solid #C9C0AC",
                        background: "#FBF9F4",
                        fontFamily: "'Inter', sans-serif",
                        fontSize: 13,
                        marginBottom: 14,
                        resize: "vertical",
                      }}
                    />

                    <button
                      onClick={markDoneThisCycle}
                      style={{
                        width: "100%",
                        padding: "10px 0",
                        background: "#5B8C5A",
                        color: "#F1ECE1",
                        border: "none",
                        borderRadius: 4,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 700,
                        fontSize: 13,
                        letterSpacing: "0.04em",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        marginBottom: 10,
                      }}
                    >
                      <Check size={14} strokeWidth={3} /> MARK DONE FOR THIS CYCLE
                    </button>

                    <label
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        color: "#5C5850",
                        display: "block",
                        marginBottom: 6,
                      }}
                    >
                      SKIP THIS CYCLE — WHY? (needed to skip)
                    </label>
                    <input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. On vacation this week"
                      style={{
                        width: "100%",
                        padding: 8,
                        borderRadius: 4,
                        border: "1px solid #C9C0AC",
                        background: "#FBF9F4",
                        fontFamily: "'Inter', sans-serif",
                        fontSize: 13,
                        marginBottom: 10,
                      }}
                    />
                    <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                      {deferOptions.map((opt) => (
                        <button
                          key={opt.label}
                          onClick={() => deferRecurring(opt.days)}
                          disabled={!note.trim()}
                          title={!note.trim() ? "Add a reason above first" : undefined}
                          style={{
                            flex: 1,
                            padding: "8px 0",
                            background: note.trim() ? "#E9E2D2" : "#F1ECE1",
                            color: note.trim() ? "#2A2419" : "#B8AF9E",
                            border: "1px solid #C9C0AC",
                            borderRadius: 4,
                            fontFamily: "'JetBrains Mono', monospace",
                            fontWeight: 700,
                            fontSize: 10,
                            cursor: note.trim() ? "pointer" : "not-allowed",
                          }}
                        >
                          {opt.label.toUpperCase()}
                        </button>
                      ))}
                    </div>

                    {deletingConfirm ? (
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: "#5C5850", flex: 1 }}>
                          Stop this recurring task for good?
                        </span>
                        <button
                          onClick={deleteRecurring}
                          style={{
                            background: "#C1401C",
                            color: "#F1ECE1",
                            border: "none",
                            borderRadius: 4,
                            padding: "6px 10px",
                            fontFamily: "'JetBrains Mono', monospace",
                            fontWeight: 700,
                            fontSize: 10,
                            cursor: "pointer",
                          }}
                        >
                          CONFIRM
                        </button>
                        <button
                          onClick={() => setDeletingConfirm(false)}
                          style={{
                            background: "transparent",
                            color: "#8A8375",
                            border: "1px solid #C9C0AC",
                            borderRadius: 4,
                            padding: "6px 8px",
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 10,
                            cursor: "pointer",
                          }}
                        >
                          X
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeletingConfirm(true)}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "#B8AF9E",
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 10,
                          cursor: "pointer",
                        }}
                      >
                        Stop recurring
                      </button>
                    )}
                  </>
                ) : (
                  <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 6,
                    flexWrap: "wrap",
                  }}
            >
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#5C5850",
                  letterSpacing: "0.05em",
                }}
              >
                #{selected.ticket}
              </span>
              <select
                value={effectivePriority(selected)}
                onChange={(e) => savePriority(e.target.value)}
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  fontWeight: 700,
                  color: priorityColor[effectivePriority(selected)],
                  background: "transparent",
                  border: `1px solid ${priorityColor[effectivePriority(selected)]}`,
                  borderRadius: 3,
                  padding: "1px 4px",
                }}
              >
                {priorityOptions.map((p) => (
                  <option key={p} value={p}>
                    {p.toUpperCase()}
                  </option>
                ))}
              </select>
              <span
                title={
                  effectivePriority(selected) !== selected.priority
                    ? `Auto-aged up from ${selected.priority.toUpperCase()}. Next bump in ${daysUntilEscalation(selected)}d if untouched.`
                    : `Ages up automatically — next bump in ${daysUntilEscalation(selected)}d if untouched.`
                }
                style={{
                  display: "flex",
                  color: effectivePriority(selected) !== selected.priority ? priorityColor[effectivePriority(selected)] : "#B8AF9E",
                  cursor: "help",
                }}
              >
                <TrendingUp size={13} />
              </span>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: SIZE_SM,
                  color: "#8A8375",
                }}
              >
                · {daysOpen(selected.createdAt)}D OPEN
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: SIZE_SM,
                    fontWeight: isOverdue(selected) ? 700 : 400,
                    color: dueDateColor(selected),
                  }}
                >
                  · {isOverdue(selected) ? `${Math.abs(daysUntilTaskDue(selected))}D OVERDUE` : "DUE"}
                </span>
                <input
                  type="date"
                  value={selected.dueDate ? selected.dueDate.slice(0, 10) : ""}
                  onChange={(e) => saveDueDate(e.target.value || null)}
                  title="Set due date"
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: SIZE_XS,
                    color: dueDateColor(selected),
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    colorScheme: "light",
                  }}
                />
              </span>
            </div>

            <textarea
              value={draftSummary}
              onChange={(e) => setDraftSummary(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  saveTitle();
                  e.target.blur();
                }
              }}
              rows={2}
              style={{
                width: "100%",
                fontFamily: "'Inter', sans-serif",
                fontWeight: 600,
                fontSize: 16,
                color: "#2A2419",
                marginBottom: 4,
                lineHeight: 1.4,
                border: "1px solid transparent",
                borderRadius: 3,
                padding: "2px 4px",
                marginLeft: -4,
                background: "transparent",
                resize: "none",
                outline: "none",
              }}
              onFocus={(e) => (e.target.style.border = "1px solid #C9C0AC")}
            />
            {getLatestActionableEvent(selected.history) && (
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10,
                  color: "#8A8375",
                  marginBottom: 10,
                  lineHeight: 1.4,
                }}
              >
                {formatDateTime(getLatestActionableEvent(selected.history).at)}
                {" · "}
                {getLatestActionableEvent(selected.history).type.replace("_", " ").toUpperCase()}
                {": "}
                <span style={{ color: "#5C5850" }}>
                  {getLatestActionableEvent(selected.history).text}
                </span>
              </div>
            )}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              {addingCategory ? (
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <input
                    autoFocus
                    value={newCategoryText}
                    onChange={(e) => setNewCategoryText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addNewCategory()}
                    placeholder="New category..."
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: "#2A2419",
                      background: "#FBF9F4",
                      border: "1px solid #C9C0AC",
                      borderRadius: 3,
                      padding: "3px 6px",
                      width: 130,
                    }}
                  />
                  <button
                    onClick={addNewCategory}
                    style={{
                      background: "#E9E2D2",
                      border: "1px solid #C9C0AC",
                      borderRadius: 3,
                      padding: "3px 8px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    ADD
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                  <select
                    value={categories.includes(selected.category) ? selected.category : "__custom__"}
                    onChange={(e) => saveCategoryDirect(e.target.value)}
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: "#8A8375",
                      textTransform: "uppercase",
                      background: "transparent",
                      border: "1px solid transparent",
                      borderRadius: 3,
                      padding: "2px 4px",
                      marginLeft: -4,
                    }}
                    onFocus={(e) => (e.target.style.border = "1px solid #C9C0AC")}
                    onBlur={(e) => (e.target.style.border = "1px solid transparent")}
                  >
                    {!categories.includes(selected.category) && (
                      <option value="__custom__">{selected.category.toUpperCase()}</option>
                    )}
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c.toUpperCase()}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => setAddingCategory(true)}
                    title="Add a new category"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#B8AF9E",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: 700,
                      padding: "0 4px",
                    }}
                  >
                    +
                  </button>
                </div>
              )}
            </div>

            {editingLink ? (
              <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
                <input
                  autoFocus
                  value={draftSourceUrl}
                  onChange={(e) => setDraftSourceUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveSourceUrl()}
                  placeholder="https://..."
                  style={{
                    flex: 1,
                    padding: 8,
                    borderRadius: 4,
                    border: "1px solid #C9C0AC",
                    background: "#FBF9F4",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 13,
                  }}
                />
                <button
                  onClick={saveSourceUrl}
                  style={{
                    background: "#5B8C5A",
                    color: "#F1ECE1",
                    border: "none",
                    borderRadius: 4,
                    padding: "0 12px",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 700,
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                >
                  SAVE
                </button>
                <button
                  onClick={() => setEditingLink(false)}
                  style={{
                    background: "transparent",
                    color: "#8A8375",
                    border: "1px solid #C9C0AC",
                    borderRadius: 4,
                    padding: "0 10px",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                >
                  X
                </button>
              </div>
            ) : selected.sourceUrl ? (
              <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
                <a
                  href={selected.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    flex: 1,
                    padding: "8px 0",
                    background: "#E9E2D2",
                    border: "1px solid #C9C0AC",
                    borderRadius: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 700,
                    fontSize: 11,
                    color: "#2A2419",
                    textDecoration: "none",
                  }}
                >
                  <LinkIcon size={12} /> OPEN SOURCE RECORD
                </a>
                <button
                  onClick={() => setEditingLink(true)}
                  title="Edit link"
                  style={{
                    background: "transparent",
                    border: "1px solid #C9C0AC",
                    borderRadius: 4,
                    padding: "0 10px",
                    color: "#8A8375",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                >
                  EDIT
                </button>
              </div>
            ) : (
              <button
                onClick={() => setEditingLink(true)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  width: "100%",
                  padding: "8px 0",
                  marginBottom: 18,
                  background: "transparent",
                  border: "1px dashed #C9C0AC",
                  borderRadius: 4,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 700,
                  fontSize: 11,
                  color: "#8A8375",
                  cursor: "pointer",
                }}
              >
                <LinkIcon size={12} /> ADD LINK
              </button>
            )}

            {selected.checklist && (
              <div
                style={{
                  marginBottom: 18,
                  paddingBottom: 16,
                  borderBottom: "1px dashed #C9C0AC",
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                  <select
                    value={selected.projectType}
                    onChange={(e) => switchProjectType(e.target.value)}
                    title="Preset from the project's admin page — toggle here if it was set up wrong"
                    style={{
                      padding: "4px 8px",
                      borderRadius: 4,
                      border: "1px solid #C9C0AC",
                      background: "transparent",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 700,
                      fontSize: 11,
                      color: "#5C5850",
                    }}
                  >
                    {PROJECT_TYPES.map((pt) => (
                      <option key={pt} value={pt}>
                        {pt.toUpperCase()}
                      </option>
                    ))}
                  </select>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: "#5C5850",
                      cursor: "pointer",
                    }}
                  >
                    <input type="checkbox" checked={selected.isOntario} onChange={toggleOntario} />
                    ONTARIO
                  </label>
                </div>

                {selected.checklist.map((item) => (
                  <div
                    key={item.key}
                    onClick={() => toggleChecklistItem(item.key)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "5px 0",
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 3,
                        border: `1.5px solid ${item.done ? "#5B8C5A" : "#8A8375"}`,
                        background: item.done ? "#5B8C5A" : "transparent",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {item.done && <Check size={11} color="#F1ECE1" strokeWidth={3} />}
                    </div>
                    <div
                      style={{
                        fontFamily: "'Inter', sans-serif",
                        fontSize: 13,
                        color: item.done ? "#8A8375" : "#2A2419",
                        textDecoration: item.done ? "line-through" : "none",
                      }}
                    >
                      {item.label}
                    </div>
                  </div>
                ))}
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: "#B8AF9E",
                    marginTop: 6,
                    marginBottom: 10,
                  }}
                >
                  {selected.checklist.filter((c) => c.done).length}/{selected.checklist.length} DONE — POST/PATCH TO PROCORE & NETSUITE ON CHECK
                </div>

                {forceCompleteConfirm ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <input
                      autoFocus
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Why complete it without finishing the list?"
                      style={{
                        flex: 1,
                        padding: 6,
                        borderRadius: 4,
                        border: "1px solid #C9C0AC",
                        background: "#FBF9F4",
                        fontFamily: "'Inter', sans-serif",
                        fontSize: 13,
                      }}
                    />
                    <button
                      onClick={forceCompleteChecklist}
                      disabled={!note.trim()}
                      style={{
                        background: note.trim() ? "#5B8C5A" : "#E9E2D2",
                        color: note.trim() ? "#F1ECE1" : "#B8AF9E",
                        border: "none",
                        borderRadius: 4,
                        padding: "6px 10px",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 700,
                        fontSize: 10,
                        cursor: note.trim() ? "pointer" : "not-allowed",
                      }}
                    >
                      CONFIRM
                    </button>
                    <button
                      onClick={() => setForceCompleteConfirm(false)}
                      style={{
                        background: "transparent",
                        color: "#8A8375",
                        border: "1px solid #C9C0AC",
                        borderRadius: 4,
                        padding: "6px 8px",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        cursor: "pointer",
                      }}
                    >
                      X
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setForceCompleteConfirm(true)}
                    title="Mark complete without checking off every item — requires a reason"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#B8AF9E",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      cursor: "pointer",
                    }}
                  >
                    Mark complete anyway
                  </button>
                )}
              </div>
            )}

            {selected.status === "snoozed" ? (
              <>
                <div
                  style={{
                    background: "#E9E2D2",
                    borderRadius: 4,
                    padding: 12,
                    marginBottom: 16,
                  }}
                >
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: "#5C5850",
                      marginBottom: 4,
                    }}
                  >
                    DEFERRED — {selected.deferReason}
                  </div>
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: "#8A8375",
                    }}
                  >
                    Due back: {new Date(selected.dueDate).toLocaleDateString()}
                  </div>
                </div>
                <button
                  onClick={reactivateTask}
                  style={{
                    width: "100%",
                    padding: "10px 0",
                    background: "#6B7A8C",
                    color: "#F1ECE1",
                    border: "none",
                    borderRadius: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 700,
                    fontSize: 13,
                    letterSpacing: "0.04em",
                    cursor: "pointer",
                  }}
                >
                  BRING BACK NOW
                </button>
              </>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: "#5C5850",
                    }}
                  >
                    NOTE
                  </span>
                  <span
                    title="Used to resolve, defer, log context, or brief Copilot"
                    style={{ display: "flex", color: "#B8AF9E", cursor: "help" }}
                  >
                    <HelpCircle size={12} />
                  </span>
                </div>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. Sent the CO Tuesday — confirmed by Peter. Or: waiting on Alfonso for the PO and client emails."
                  style={{
                    width: "100%",
                    minHeight: 60,
                    padding: 8,
                    borderRadius: 4,
                    border: "1px solid #C9C0AC",
                    background: "#FBF9F4",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 13,
                    marginBottom: 10,
                    resize: "vertical",
                  }}
                />

                {(() => {
                  const checklistIncomplete = selected.checklist && !selected.checklist.every((c) => c.done);
                  if (checklistIncomplete) {
                    return (
                      <button
                        disabled
                        title="Finish the checklist above, or use 'Mark complete anyway' with a reason"
                        style={{
                          width: "100%",
                          padding: "10px 0",
                          background: "#E9E2D2",
                          color: "#B8AF9E",
                          border: "none",
                          borderRadius: 4,
                          fontFamily: "'JetBrains Mono', monospace",
                          fontWeight: 700,
                          fontSize: 13,
                          letterSpacing: "0.04em",
                          cursor: "not-allowed",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 6,
                          marginBottom: 10,
                        }}
                      >
                        <Check size={14} strokeWidth={3} /> MARK RESOLVED (checklist incomplete)
                      </button>
                    );
                  }
                  return resolvingConfirm ? (
                    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                      <button
                        onClick={() => {
                          resolveTask();
                          setResolvingConfirm(false);
                        }}
                        style={{
                          flex: 1,
                          padding: "10px 0",
                          background: "#5B8C5A",
                          color: "#F1ECE1",
                          border: "none",
                          borderRadius: 4,
                          fontFamily: "'JetBrains Mono', monospace",
                          fontWeight: 700,
                          fontSize: 13,
                          cursor: "pointer",
                        }}
                      >
                        YES, RESOLVE
                      </button>
                      <button
                        onClick={() => setResolvingConfirm(false)}
                        style={{
                          flex: 1,
                          padding: "10px 0",
                          background: "transparent",
                          color: "#8A8375",
                          border: "1px solid #C9C0AC",
                          borderRadius: 4,
                          fontFamily: "'JetBrains Mono', monospace",
                          fontWeight: 700,
                          fontSize: 13,
                          cursor: "pointer",
                        }}
                      >
                        CANCEL
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setResolvingConfirm(true)}
                      style={{
                        width: "100%",
                        padding: "10px 0",
                        background: "#5B8C5A",
                        color: "#F1ECE1",
                        border: "none",
                        borderRadius: 4,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 700,
                        fontSize: 13,
                        letterSpacing: "0.04em",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        marginBottom: 10,
                      }}
                    >
                      <Check size={14} strokeWidth={3} /> MARK RESOLVED
                    </button>
                  );
                })()}

                <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                  <button
                    onClick={() => {
                      setSnoozeMenuOpen((v) => !v);
                      setDeletingConfirm(false);
                    }}
                    disabled={!note.trim()}
                    title={!note.trim() ? "Add a note above first" : undefined}
                    style={{
                      flex: 1,
                      padding: "8px 4px",
                      background: snoozeMenuOpen ? "#6B7A8C" : note.trim() ? "#E9E2D2" : "#F1ECE1",
                      color: snoozeMenuOpen ? "#F1ECE1" : note.trim() ? "#2A2419" : "#B8AF9E",
                      border: "1px solid #C9C0AC",
                      borderRadius: 4,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 700,
                      fontSize: 10,
                      cursor: note.trim() ? "pointer" : "not-allowed",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 3,
                    }}
                  >
                    <Clock size={11} /> SNOOZE
                  </button>
                  <button
                    onClick={addNoteOnly}
                    disabled={!note.trim()}
                    title="Logs this note to History without changing status"
                    style={{
                      flex: 1,
                      padding: "8px 4px",
                      background: note.trim() ? "#E9E2D2" : "#F1ECE1",
                      color: note.trim() ? "#2A2419" : "#B8AF9E",
                      border: "1px solid #C9C0AC",
                      borderRadius: 4,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 700,
                      fontSize: 10,
                      cursor: note.trim() ? "pointer" : "not-allowed",
                    }}
                  >
                    LOG NOTE
                  </button>
                  <button
                    onClick={() => {
                      setDeletingConfirm((v) => !v);
                      setSnoozeMenuOpen(false);
                    }}
                    title="Delete this task and log why, so misclassifications inform prompt tuning"
                    style={{
                      flex: 1,
                      padding: "8px 4px",
                      background: deletingConfirm ? "#C1401C" : "#E9E2D2",
                      color: deletingConfirm ? "#F1ECE1" : "#2A2419",
                      border: "1px solid #C9C0AC",
                      borderRadius: 4,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 700,
                      fontSize: 10,
                      cursor: "pointer",
                    }}
                  >
                    DELETE
                  </button>
                  <button
                    onClick={askCopilot}
                    disabled={!note.trim() || copilotLoading}
                    title={!note.trim() ? "Add a note above first" : "One Claude call, only when you click this"}
                    style={{
                      flex: 1,
                      padding: "8px 4px",
                      background: note.trim() ? "#E9E2D2" : "#F1ECE1",
                      color: note.trim() ? "#2A2419" : "#B8AF9E",
                      border: "1px solid #C9C0AC",
                      borderRadius: 4,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 700,
                      fontSize: 10,
                      cursor: note.trim() ? "pointer" : "not-allowed",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 3,
                    }}
                  >
                    <Bot size={11} /> {copilotLoading ? "..." : "COPILOT"}
                  </button>
                </div>

                {selected.parentTaskId && (
                  <button
                    onClick={() => removeChildFromProject(selected.id)}
                    style={{
                      width: "100%",
                      padding: "8px 0",
                      background: "transparent",
                      color: "#6B7A8C",
                      border: "1px solid #C9C0AC",
                      borderRadius: 4,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 700,
                      fontSize: 10,
                      cursor: "pointer",
                      marginBottom: 10,
                    }}
                  >
                    REMOVE FROM PROJECT
                  </button>
                )}

                {snoozeMenuOpen && (
                  <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                    {deferOptions.map((opt) => (
                      <button
                        key={opt.label}
                        onClick={() => {
                          deferTask(opt.days);
                          setSnoozeMenuOpen(false);
                        }}
                        style={{
                          flex: 1,
                          padding: "8px 0",
                          background: "#E9E2D2",
                          color: "#2A2419",
                          border: "1px solid #C9C0AC",
                          borderRadius: 4,
                          fontFamily: "'JetBrains Mono', monospace",
                          fontWeight: 700,
                          fontSize: 10,
                          cursor: "pointer",
                        }}
                      >
                        {opt.label.toUpperCase()}
                      </button>
                    ))}
                  </div>
                )}

                {deletingConfirm && (
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      marginBottom: 10,
                      alignItems: "center",
                    }}
                  >
                    <input
                      autoFocus
                      value={deleteReason}
                      onChange={(e) => setDeleteReason(e.target.value)}
                      placeholder="Why isn't this a task? (e.g. misread email)"
                      style={{
                        flex: 1,
                        padding: 6,
                        borderRadius: 4,
                        border: "1px solid #C1401C",
                        background: "#FBF9F4",
                        fontFamily: "'Inter', sans-serif",
                        fontSize: 13,
                      }}
                    />
                    <button
                      onClick={() => deleteTask(deleteReason.trim() || "Not specified")}
                      style={{
                        background: "#C1401C",
                        color: "#F1ECE1",
                        border: "none",
                        borderRadius: 4,
                        padding: "6px 10px",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 700,
                        fontSize: 10,
                        cursor: "pointer",
                      }}
                    >
                      CONFIRM
                    </button>
                    <button
                      onClick={() => setDeletingConfirm(false)}
                      style={{
                        background: "transparent",
                        color: "#8A8375",
                        border: "1px solid #C9C0AC",
                        borderRadius: 4,
                        padding: "6px 8px",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        cursor: "pointer",
                      }}
                    >
                      X
                    </button>
                  </div>
                )}

                {copilotSuggestions && (!pickedSuggestion ? (
                  <div>
                    {copilotSuggestions.map((s, i) => (
                      <button
                        key={i}
                        onClick={() => setPickedSuggestion(s)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          background: "#E9E2D2",
                          border: "1px solid #C9C0AC",
                          borderRadius: 4,
                          padding: "8px 10px",
                          marginBottom: 6,
                          cursor: "pointer",
                        }}
                      >
                        <div
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 10,
                            fontWeight: 700,
                            color: "#6B7A8C",
                            marginBottom: 2,
                          }}
                        >
                          {s.action.toUpperCase()}
                        </div>
                        <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: "#2A2419" }}>
                          {s.label}
                        </div>
                      </button>
                    ))}
                    <button
                      onClick={() => setCopilotSuggestions(null)}
                      style={{
                        width: "100%",
                        padding: "6px 0",
                        background: "transparent",
                        color: "#8A8375",
                        border: "1px solid #C9C0AC",
                        borderRadius: 4,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        cursor: "pointer",
                      }}
                    >
                      CANCEL
                    </button>
                  </div>
                ) : (
                  <div>
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        fontWeight: 700,
                        color: "#6B7A8C",
                        marginBottom: 4,
                      }}
                    >
                      {pickedSuggestion.action.toUpperCase()}
                    </div>
                    <div
                      style={{
                        background: "#E9E2D2",
                        borderRadius: 4,
                        padding: 10,
                        fontFamily: "'Inter', sans-serif",
                        fontSize: 13,
                        color: "#2A2419",
                        marginBottom: 8,
                        lineHeight: 1.4,
                      }}
                    >
                      {pickedSuggestion.text}
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={sendCopilotSuggestion}
                        style={{
                          flex: 1,
                          padding: "8px 0",
                          background: "#6B7A8C",
                          color: "#F1ECE1",
                          border: "none",
                          borderRadius: 4,
                          fontFamily: "'JetBrains Mono', monospace",
                          fontWeight: 700,
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        SEND & DEFER
                      </button>
                      <button
                        onClick={() => setPickedSuggestion(null)}
                        style={{
                          flex: 1,
                          padding: "8px 0",
                          background: "transparent",
                          color: "#8A8375",
                          border: "1px solid #C9C0AC",
                          borderRadius: 4,
                          fontFamily: "'JetBrains Mono', monospace",
                          fontWeight: 700,
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        BACK
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
