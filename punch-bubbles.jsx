import React, { useState, useMemo, useRef, useEffect } from "react";
import * as d3 from "d3";
import { X, Link as LinkIcon, Check, Clock, Bot, User, History as HistoryIcon, TrendingUp, HelpCircle, RefreshCw as RefreshIcon } from "lucide-react";

const API_BASE = "https://punch-worker.ben-a90.workers.dev";
const AUTH_URL = "https://auth.ben-a90.workers.dev";
const PUNCH_TOKEN_KEY = "einbau_id_token"; // shared with SCOUT/INTAKE - same origin, one login carries across all three

// Set by the login screen after a successful login/verify — read by every api*
// call below. A plain module-level variable (not React state) because these
// are standalone functions outside the component, same pattern SCOUT/INTAKE
// already use for their own auth tokens.
let punchAuthToken = null;

// A 401 means the token is missing/expired/revoked, or (for PUNCH specifically)
// a valid login from an account that isn't Ben's. Either way, drop the token —
// but instead of silently reloading (which wiped the actual reason off-screen
// before it could be read — exactly what made the last round of this hard to
// diagnose), hand the reason to the login screen via a callback it registers
// on mount, and only fall back to a hard reload if nothing's registered yet.
let onUnauthorizedCallback = null;
async function handleUnauthorized(res) {
  punchAuthToken = null;
  try {
    localStorage.removeItem(PUNCH_TOKEN_KEY);
  } catch (e) {
    // ignore storage errors
  }
  let reason = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body.reason) reason = body.reason;
  } catch (e) {
    // ignore — body wasn't JSON, stick with the plain status
  }
  if (onUnauthorizedCallback) {
    onUnauthorizedCallback(reason);
  } else {
    window.location.reload();
  }
}
function authHeaders(extra) {
  const headers = { ...extra };
  if (punchAuthToken) headers["Authorization"] = `Bearer ${punchAuthToken}`;
  return headers;
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401) return handleUnauthorized(res);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}
async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (res.status === 401) return handleUnauthorized(res);
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}
async function apiPatch(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (res.status === 401) return handleUnauthorized(res);
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status}`);
  return res.json();
}
async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE", headers: authHeaders() });
  if (res.status === 401) return handleUnauthorized(res);
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
  return res.json();
}
// Fire-and-forget wrapper for calls the UI shouldn't block on — local state already
// updated optimistically, this just persists it. Logs failures rather than throwing,
// so a flaky network doesn't crash the panel.
function persist(promise) {
  promise.catch((err) => console.error("PUNCH sync failed:", err));
}

// now/daysAgo are still used by the Portfolio "record picker" mock pool below — that
// feature stays mock until real Procore polling exists (see initialAvailableRecords).
// Saved Searches (searches tab) is no longer part of this — it's a live NetSuite
// proxy view with its own fetch/save cycle, not a tasks-backed list at all.
const now = new Date();

const PROJECT_TYPES = ["T&M", "Contract", "Service Call", "Warranty", "Overhead"];

// Unified checklist registry — one shared key space across all 5 project types
// (mirrors the Worker's CHECKLIST_REGISTRY, which seeds these same keys from Procore
// at sync time). Sharing keys across types is what makes switching Project Type safe:
// buildChecklist below preserves each item (label AND done) whenever its key is still
// present after the switch, instead of discarding the whole checklist and starting
// from a blank template — which is what used to wipe out checked-off items.
const CHECKLIST_REGISTRY = [
  { key: "stage", label: "Stage", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: true } },
  { key: "address", label: "Address Fields", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: true } },
  { key: "timezone", label: "Timezone", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: true } },
  { key: "region", label: "Region", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: true } },
  { key: "department", label: "Department", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: true } },
  { key: "dates", label: "Start/End Date", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: true } },
  { key: "customer", label: "Customer", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: true } },
  { key: "po_number", label: "PO Number", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: false, Overhead: false } },
  { key: "currency", label: "Currency", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: true } },
  { key: "po_on_file", label: "PO on file", types: { "T&M": false, Contract: true, "Service Call": true, Warranty: false, Overhead: false } },
  { key: "tender_emails", label: "Tender emails stored on project?", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: false } },
  { key: "estimates_reviewed", label: "Estimates reviewed?", types: { "T&M": false, Contract: true, "Service Call": true, Warranty: false, Overhead: false } },
  { key: "labour_budget", label: "Labour Budget Created", types: { "T&M": false, Contract: true, "Service Call": true, Warranty: false, Overhead: false } },
  { key: "directory", label: "People added to directory", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: true } },
  { key: "drawings", label: "Drawings moved to Documents folder", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: false } },
  { key: "startup_docs", label: "Startup Docs issued", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: false } },
  { key: "tm_agreement", label: "T&M Agreement issued", types: { "T&M": true, Contract: false, "Service Call": true, Warranty: false, Overhead: false } },
  { key: "budget_populated", label: "Budget populated", types: { "T&M": true, Contract: true, "Service Call": true, Warranty: true, Overhead: false } },
];

const ONTARIO_ITEM = { key: "form1000", label: "Form 1000 Filled out" };

// No project type selected means an empty checklist, not "show everything" — a
// blanket list mixed items that don't actually apply to every type (e.g. Labour
// Budget/Estimates Reviewed showing on a T&M project), so it's safer to show nothing
// until the type is actually known.
function templateForProjectType(projectType) {
  if (!projectType) return [];
  return CHECKLIST_REGISTRY.filter((item) => item.types[projectType]);
}

function buildChecklist(projectType, isOntario, previousChecklist) {
  const base = templateForProjectType(projectType);
  const items = projectType && isOntario ? [...base, ONTARIO_ITEM] : base;
  const prevByKey = new Map((previousChecklist || []).map((c) => [c.key, c]));
  return items.map((item) => {
    const prev = prevByKey.get(item.key);
    return prev ? { key: item.key, label: prev.label, done: prev.done } : { key: item.key, label: item.label, done: false };
  });
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

// Synthesized "win" chime for resolving a task — a quick ascending major triad,
// generated with the Web Audio API so there's no audio asset to load. Reuses a
// single AudioContext across calls; browsers cap how many can exist per page.
let resolveAudioCtx = null;
function playResolveChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!resolveAudioCtx) resolveAudioCtx = new Ctx();
    const ctx = resolveAudioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const start0 = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const start = start0 + i * 0.07;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  } catch (e) {
    // sound is decorative — never let it break the actual resolve action
  }
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

// Deliberately NOT the module-level `now` (frozen at page load) — a history event
// needs the real time it happened, not whenever the tab was last opened. Using the
// stale `now` here meant every note/change logged in a session showed the same
// wrong timestamp until the page was refreshed.
function historyEvent(type, text) {
  return { type, text, at: new Date().toISOString() };
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

const PROCORE_COMPANY_ID = "562949953508586";

function procoreProjectIdFromUrl(url) {
  if (!url) return null;
  const m = url.match(/procore\.com\/(\d+)\//);
  return m ? m[1] : null;
}

function procoreDirectoryLink(projectId) {
  return `https://us02.procore.com/${projectId}/project/directory`;
}

function procoreEstimateLink(projectId) {
  return `https://us02.procore.com/webclients/host/companies/${PROCORE_COMPANY_ID}/projects/${projectId}/tools/estimating/estimate`;
}

// Checklist keys that write back to a real Procore field, editable inline in the
// modal — the "flowing 2 ways" checklist. Stage/Region/Customer options come live
// from the worker (they change over time); Department/Currency/Timezone are static
// enough that Ben's own confirmed lists are hardcoded here rather than round-tripped.
const WRITEBACK_FIELDS = new Set(["stage", "address", "timezone", "region", "department", "dates", "customer", "po_number", "currency"]);

// Confirmed with Ben directly — this Procore account only bills in these two.
const PROCORE_CURRENCIES = [
  { id: 562949954003313, label: "CAD $" },
  { id: 562949954003314, label: "USD $" },
];

// Procore's state_code field expects the 2-letter code, not the full province name —
// pulled from Ben's live dropdown (F12) since Procore's own live endpoint for this
// (/rest/v1.0/internal/regions/{country}) proved unreliable to call server-side.
// Canada only for now, since that's every project this account has.
const PROCORE_PROVINCES = [
  { id: "AB", name: "Alberta" },
  { id: "BC", name: "British Columbia" },
  { id: "MB", name: "Manitoba" },
  { id: "NB", name: "New Brunswick" },
  { id: "NL", name: "Newfoundland and Labrador" },
  { id: "NT", name: "Northwest Territories" },
  { id: "NS", name: "Nova Scotia" },
  { id: "NU", name: "Nunavut" },
  { id: "ON", name: "Ontario" },
  { id: "PE", name: "Prince Edward Island" },
  { id: "QC", name: "Quebec" },
  { id: "SK", name: "Saskatchewan" },
  { id: "YT", name: "Yukon Territory" },
];

// Confirmed with Ben directly — Einbau's Department list is really named after its
// regional branches/roles, pulled from the live dropdown (F12) since there's no
// public Procore endpoint for it.
const PROCORE_DEPARTMENTS = [
  { id: 562949953453259, name: "Warren Wagler" },
  { id: 562949953487335, name: "Walter Corsetti" },
  { id: 562949953507599, name: "Sunita Jackson" },
  { id: 562949953498534, name: "Scot Carter-Nichols" },
  { id: 562949953453256, name: "Rudi Dyck" },
  { id: 562949953454803, name: "Project Management" },
  { id: 562949953454805, name: "Project Logistics" },
  { id: 562949953454802, name: "Project Estimation" },
  { id: 562949953453255, name: "Peter Dyck" },
  { id: 562949953454804, name: "Mel Gabriel" },
  { id: 562949953492649, name: "Luigi Perna" },
  { id: 562949953463907, name: "Kevin Smith" },
  { id: 562949953453258, name: "Hal Rowan" },
  { id: 562949953489165, name: "Elliot Natovitch" },
  { id: 562949953482755, name: "Dwayne Rogers" },
  { id: 562949953473800, name: "Devid Manzke" },
  { id: 562949953489369, name: "Dave LeBlanc" },
  { id: 562949953454806, name: "Danny Pagniello" },
  { id: 562949953495200, name: "Chris Hong" },
  { id: 562949953453257, name: "Ben Wright" },
  { id: 562949953453261, name: "Back Log" },
  { id: 562949953453265, name: "Alfonso Lopez" },
  { id: 562949953497563, name: "Alex Reid" },
];

// Rails' standard timezone list, pulled from Ben's live dropdown (F12) — static,
// Procore expects the name itself as the stored value (no separate id).
const PROCORE_TIMEZONES = [
  "International Date Line West", "American Samoa", "Midway Island", "Hawaii", "Alaska",
  "Pacific Time (US & Canada)", "Tijuana", "Arizona", "Mazatlan", "Mountain Time (US & Canada)",
  "Central America", "Central Time (US & Canada)", "Chihuahua", "Guadalajara", "Mexico City",
  "Monterrey", "Saskatchewan", "Bogota", "Eastern Time (US & Canada)", "Indiana (East)",
  "Lima", "Quito", "Atlantic Time (Canada)", "Caracas", "Georgetown", "La Paz", "Puerto Rico",
  "Santiago", "Newfoundland", "Brasilia", "Buenos Aires", "Montevideo", "Greenland",
  "Mid-Atlantic", "Azores", "Cape Verde Is.", "Edinburgh", "Lisbon", "London", "Monrovia",
  "UTC", "Amsterdam", "Belgrade", "Berlin", "Bern", "Bratislava", "Brussels", "Budapest",
  "Casablanca", "Copenhagen", "Dublin", "Ljubljana", "Madrid", "Paris", "Prague", "Rome",
  "Sarajevo", "Skopje", "Stockholm", "Vienna", "Warsaw", "West Central Africa", "Zagreb",
  "Zurich", "Athens", "Bucharest", "Cairo", "Harare", "Helsinki", "Jerusalem", "Kaliningrad",
  "Kyiv", "Pretoria", "Riga", "Sofia", "Tallinn", "Vilnius", "Baghdad", "Istanbul", "Kuwait",
  "Minsk", "Moscow", "Nairobi", "Riyadh", "St. Petersburg", "Volgograd", "Tehran", "Abu Dhabi",
  "Baku", "Muscat", "Samara", "Tbilisi", "Yerevan", "Kabul", "Almaty", "Astana", "Ekaterinburg",
  "Islamabad", "Karachi", "Tashkent", "Chennai", "Kolkata", "Mumbai", "New Delhi",
  "Sri Jayawardenepura", "Kathmandu", "Dhaka", "Urumqi", "Rangoon", "Bangkok", "Hanoi",
  "Jakarta", "Krasnoyarsk", "Novosibirsk", "Beijing", "Chongqing", "Hong Kong", "Irkutsk",
  "Kuala Lumpur", "Perth", "Singapore", "Taipei", "Ulaanbaatar", "Osaka", "Sapporo", "Seoul",
  "Tokyo", "Yakutsk", "Adelaide", "Darwin", "Brisbane", "Canberra", "Guam", "Hobart",
  "Melbourne", "Port Moresby", "Sydney", "Vladivostok", "Magadan", "New Caledonia",
  "Solomon Is.", "Srednekolymsk", "Auckland", "Fiji", "Kamchatka", "Marshall Is.", "Wellington",
  "Chatham Is.", "Nuku'alofa", "Samoa", "Tokelau Is.",
];

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

// The app-switcher dropdown, mirrored across PUNCH/SCOUT/INTAKE. PUNCH is
// Ben's personal tool (see the username check in punch-worker) so it's listed
// but not linked from the other two — everyone can see it exists, only Ben
// can actually get in.
const APP_SWITCHER_LINKS = [
  { name: "PUNCH", url: "https://lambwright.github.io/PUNCH/", color: "#E2871A", current: true },
  { name: "SCOUT", url: "https://lambwright.github.io/scout-addin/app.html", color: "#8FC742", current: false },
  { name: "INTAKE", url: "https://lambwright.github.io/scout-intake/", color: "#8FC742", current: false },
  { name: "TALLY", url: "https://lambwright.github.io/tally/", color: "#E2871A", current: false },
];

// The real Project Manager roster, as read off Procore's own live PM dropdown —
// NetSuite's employee list has no field distinguishing these ~6 from the other
// ~44 active employees, so this is filtered client-side against a maintained
// list rather than a query. See loadPmOptions.
const KNOWN_PM_NAMES = new Set([
  "CHRIS HONG", "DEVID MANZKE", "HAL ROWAN", "PETER DYCK", "RUDI DYCK", "SCOT CARTER-NICHOLS",
]);

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
  // Stage Enforcer-flagged tasks (punch-worker sets list: "stage_review"). Reuses the
  // bubbles view as-is rather than a new bespoke layout — category already carries the
  // origin stage bucket (On Hold / Completed and Invoiced / Pre-Construction) and shows
  // on hover + in the detail modal, and each accumulated record already gets its own
  // linked History entry via the same mechanism email replies use.
  // "list" (not "bubbles") deliberately — this is the same compact-row layout
  // Portfolio uses, and since that row rendering is written generically (no
  // tab === "portfolio" checks baked in), Stage Review tasks get the identical
  // look/feel for free: priority-colored left border, single summary line,
  // #ticket · category metadata line, age badge, click to open the shared detail
  // modal (which already shows the linked History entries).
  { id: "stage_review", label: "STAGE REVIEW", view: "list" },
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

  // Einbau ID login — same shared auth as SCOUT/INTAKE. Nothing else in this
  // component fetches real data until authToken is set; punchAuthToken (the
  // module-level copy the api* helpers actually read) is kept in sync alongside it.
  const [authToken, setAuthToken] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [authUser, setAuthUser] = useState(null);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [appSwitcherOpen, setAppSwitcherOpen] = useState(false);

  function setAuth(token, user) {
    punchAuthToken = token;
    setAuthToken(token);
    setAuthUser(user || null);
  }

  useEffect(() => {
    onUnauthorizedCallback = (reason) => {
      setAuthToken(null);
      setAuthUser(null);
      setTasks([]);
      setRecurringTasks([]);
      setLoginError(reason);
    };
    return () => {
      onUnauthorizedCallback = null;
    };
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem(PUNCH_TOKEN_KEY);
    if (!stored) {
      setAuthChecking(false);
      return;
    }
    fetch(`${AUTH_URL}/auth/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stored}`, "Content-Type": "application/json" },
      body: "{}",
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.valid) {
          const fresh = data.refreshedToken || stored;
          if (data.refreshedToken) localStorage.setItem(PUNCH_TOKEN_KEY, data.refreshedToken);
          setAuth(fresh, data.user);
        } else {
          localStorage.removeItem(PUNCH_TOKEN_KEY);
        }
      })
      .catch(() => localStorage.removeItem(PUNCH_TOKEN_KEY))
      .finally(() => setAuthChecking(false));
  }, []);

  async function doLogin(e) {
    e.preventDefault();
    setLoginError("");
    setLoginSubmitting(true);
    try {
      const res = await fetch(`${AUTH_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginUsername.trim(), password: loginPassword }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) {
        setLoginError("Invalid username or password.");
        return;
      }
      localStorage.setItem(PUNCH_TOKEN_KEY, data.token);
      setLoginPassword("");
      setAuth(data.token, data.user);
    } catch (err) {
      setLoginError("Couldn't reach the login server — check your connection.");
    } finally {
      setLoginSubmitting(false);
    }
  }
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
  const [resolveBurst, setResolveBurst] = useState(null);
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
  const [expandedChecklistItem, setExpandedChecklistItem] = useState(null);
  const [procoreDetails, setProcoreDetails] = useState({});
  const [procoreDetailLoading, setProcoreDetailLoading] = useState(() => new Set());
  const [budgetPopulating, setBudgetPopulating] = useState(false);
  const [budgetPopulateResult, setBudgetPopulateResult] = useState(null);

  // Write-back editor for the 9 Procore-native admin fields — which one (if any) is
  // being edited, its dropdown options (fetched once per field and cached), and the
  // in-progress form values. Starts blank on every open rather than pre-filled from
  // the checklist label, since that label is a formatted display string, not a
  // reliable source for a dropdown's underlying id.
  const [editingChecklistField, setEditingChecklistField] = useState(null);
  const [procoreOptions, setProcoreOptions] = useState({});
  const [procoreOptionsLoading, setProcoreOptionsLoading] = useState(() => new Set());
  const [editDraft, setEditDraft] = useState({});
  const [savingChecklistField, setSavingChecklistField] = useState(false);
  const [checklistFieldError, setChecklistFieldError] = useState(null);

  // Address suggestions — null: not checked yet (or not applicable), []: checked,
  // no known location matched the project title, [...]: candidates to offer before
  // showing the blank manual-entry form. showManualAddress skips straight past
  // suggestions once Ben picks "Enter manually" (or there's nothing to suggest).
  const [addressSuggestions, setAddressSuggestions] = useState(null);
  const [addressSuggestLoading, setAddressSuggestLoading] = useState(false);
  const [showManualAddress, setShowManualAddress] = useState(false);
  const [addTaskPanelOpen, setAddTaskPanelOpen] = useState(false);
  const [addTaskMode, setAddTaskMode] = useState("existing"); // "existing" | "new" — inside an opened project

  const svgRef = useRef(null);
  const draggingId = useRef(null);
  const dragMoved = useRef(false);
  const lastChildDragPos = useRef(null);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [portfolioSortMode, setPortfolioSortMode] = useState("age"); // "age" | "number"
  const [digests, setDigests] = useState([]);
  const [digestLoading, setDigestLoading] = useState(false);
  const [digestGenerating, setDigestGenerating] = useState(false);
  const [digestError, setDigestError] = useState(null);
  const [digestsFetched, setDigestsFetched] = useState(false);

  // Saved Searches (NetSuite Inbound Projects) — a live proxy view, not a local
  // tasks list like every other tab. "Done" here just means "NetSuite already has
  // the value," so there's nothing to persist locally; pendingEdits holds only the
  // in-progress draft for whichever record(s) are currently being edited.
  const [pendingProjects, setPendingProjects] = useState([]);
  const [pendingOptions, setPendingOptions] = useState({ department: [], class: [], location: [], approvalStatus: [] });
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingError, setPendingError] = useState(null);
  const [pendingFetched, setPendingFetched] = useState(false);
  const [pendingEdits, setPendingEdits] = useState({}); // { [recordId]: { customer?, projectManager?, department?, class?, location?, approvalStatus? } }
  const [pendingSavingId, setPendingSavingId] = useState(null);
  const [pendingSavedId, setPendingSavedId] = useState(null); // brief post-save confirmation flash
  const [openedPendingId, setOpenedPendingId] = useState(null); // which pendingProjects row's detail panel is open
  const [pmOptions, setPmOptions] = useState([]); // full employee list (~50), fetched once
  const [customerQuery, setCustomerQuery] = useState({}); // { [recordId]: text typed so far }
  const [customerResults, setCustomerResults] = useState({}); // { [recordId]: [{id,name}] }

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
      markUnseenBatch(newOnes.filter((t) => !t.isProject).map((t) => t.id));
      return [...prev, ...newOnes];
    });
    setRecurringTasks((prev) => {
      const existingIds = new Set(prev.map((t) => t.id));
      const newOnes = normalizedRecur.filter((t) => !existingIds.has(t.id));
      return [...prev, ...newOnes];
    });
  }

  useEffect(() => {
    if (!authToken) return;
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
    // Fired here too, not just when the Saved Searches tab is opened — otherwise the
    // tab's count badge reads 0 on the main page until someone actually clicks into
    // it once, since pendingProjects starts empty and nothing else populates it.
    loadPendingProjects();
    loadPmOptions();
    return () => {
      cancelled = true;
    };
  }, [authToken]);

  // Poll for new tasks (new emails/Teams messages) without a manual reload. Bumped
  // from 45s to 15min after a Neon public-network-transfer overage warning — the
  // dominant cost was GET /tasks re-shipping every open task on every poll, not the
  // interval itself, but this is a cheap extra lever while that bill month settles.
  // Ben wants to revisit this once the raw_text fix's actual impact is visible.
  useEffect(() => {
    if (!authToken) return;
    const interval = setInterval(() => {
      fetchAndMergeTasks(false).catch((err) => console.error("Background refresh failed:", err));
    }, 900000);
    return () => clearInterval(interval);
  }, [authToken]);

  async function manualRefresh() {
    setIsRefreshing(true);
    try {
      // Portfolio sync now runs hourly on its own (previously it never ran
      // automatically at all), but pull it into the manual refresh too so clicking
      // this button doesn't mean waiting up to an hour for a brand-new Procore
      // project to show up.
      await apiGet("/portfolio/sync").catch((err) => console.error("Portfolio sync failed:", err));
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

  async function loadPendingProjects() {
    setPendingLoading(true);
    setPendingError(null);
    try {
      const data = await apiGet("/netsuite/pending-projects");
      setPendingProjects(data.projects || []);
      setPendingOptions((prev) => ({ ...prev, ...data.options }));
    } catch (err) {
      setPendingError(err.message);
    } finally {
      setPendingLoading(false);
      setPendingFetched(true);
    }
  }

  // Project Manager (~50 active employees) is small enough to fetch in full once,
  // rather than search-as-you-type like Customer (~1,500 records) needs.
  async function loadPmOptions() {
    try {
      const data = await apiGet("/netsuite/pending-options?field=projectManager");
      // The NetSuite query has no way to distinguish "is actually a PM" from "is any
      // active employee" (~50 of them) — no PM/role field to filter on found in
      // NetSuite's schema for this. Filtering client-side to the actual real PM
      // roster instead, matched case-insensitively against entityid as NetSuite has
      // it stored. This is a hand-maintained list, not a live query — if a PM ever
      // gets added/removed, this needs a matching edit here.
      const options = (data.options || []).filter((o) =>
        KNOWN_PM_NAMES.has((o.name || "").trim().toUpperCase())
      );
      setPmOptions(options);
    } catch (err) {
      console.error("Failed to load project manager list:", err);
    }
  }

  function updatePendingEdit(recordId, field, value) {
    setPendingEdits((prev) => ({ ...prev, [recordId]: { ...prev[recordId], [field]: value } }));
  }

  // Debounced customer search — fires ~300ms after typing stops, not per keystroke,
  // to avoid hammering NetSuite with a query for every character typed.
  const customerSearchTimers = useRef({});
  function searchCustomers(recordId, query) {
    setCustomerQuery((prev) => ({ ...prev, [recordId]: query }));
    clearTimeout(customerSearchTimers.current[recordId]);
    if (query.trim().length < 2) {
      setCustomerResults((prev) => ({ ...prev, [recordId]: [] }));
      return;
    }
    customerSearchTimers.current[recordId] = setTimeout(() => {
      apiGet(`/netsuite/pending-options?field=customer&q=${encodeURIComponent(query.trim())}`)
        .then((data) => setCustomerResults((prev) => ({ ...prev, [recordId]: data.options || [] })))
        .catch((err) => console.error("Customer search failed:", err));
    }, 300);
  }

  // Writes only the fields actually touched in this record's draft — a record with
  // no edits yet has no entry in pendingEdits at all, so this is a no-op for those.
  async function savePendingProject(recordId) {
    const draft = pendingEdits[recordId];
    if (!draft || Object.keys(draft).length === 0) return;
    setPendingSavingId(recordId);
    try {
      const body = {};
      if (draft.customer !== undefined) body.customer = draft.customer?.id || null;
      if (draft.projectManager !== undefined) body.projectManager = draft.projectManager || null;
      if (draft.department !== undefined) body.department = draft.department || null;
      if (draft.class !== undefined) body.class = draft.class || null;
      if (draft.location !== undefined) body.location = draft.location || null;
      if (draft.approvalStatus !== undefined) body.approvalStatus = draft.approvalStatus || null;
      await apiPatch(`/netsuite/pending-projects/${recordId}`, body);
      // The worklist is "not Rejected and no NS Project yet" (matches Ben's own real
      // saved search) — an Approved record stays on it until some separate downstream
      // process actually turns it into a Job, so only Rejected means "gone from here
      // right now." Anything else just needs a re-fetch to reflect the new values.
      if (draft.approvalStatus === "3") {
        setPendingProjects((prev) => prev.filter((p) => p.id !== recordId));
      } else {
        await loadPendingProjects();
      }
      setPendingEdits((prev) => {
        const next = { ...prev };
        delete next[recordId];
        return next;
      });
      // No visible confirmation existed before this — the button just went back to
      // its disabled resting state, indistinguishable from "nothing happened." A
      // 2s flash is enough to actually notice without needing a permanent badge.
      setPendingSavedId(recordId);
      setTimeout(() => setPendingSavedId((cur) => (cur === recordId ? null : cur)), 2000);
    } catch (err) {
      console.error("Failed to save Inbound Project fields:", err);
      setPendingError(err.message);
    } finally {
      setPendingSavingId(null);
    }
  }

  useEffect(() => {
    if (tab === "searches" && !pendingFetched) {
      loadPendingProjects();
      loadPmOptions();
    }
  }, [tab, pendingFetched]);

  useEffect(() => {
    if (tab === "digest" && !digestsFetched) {
      loadDigests();
    }
  }, [tab, digestsFetched]);

  const currentTab = tabs.find((t) => t.id === tab);
  const snoozedTasks = tasks.filter((t) => t.status === "snoozed");
  const activeTasksUnsorted =
    tab === "snoozed"
      ? snoozedTasks
      : tab === "recurring"
      ? [...recurringTasks].sort((a, b) => daysUntilDue(a) - daysUntilDue(b))
      // Nested project children live only inside their project's opened view,
      // never on the top-level board.
      : tasks.filter((t) => t.status === "open" && t.list === tab && !t.parentTaskId);

  // Portfolio defaults to age (insertion order) same as everywhere else, but project
  // number is often more useful there — extracted from the summary's leading
  // "YYYY_NNNN" token, newest first.
  function projectNumberOf(t) {
    const m = (t.summary || "").match(/(\d{4}_\d{4})/);
    return m ? m[1] : "";
  }
  const activeTasks =
    tab === "portfolio" && portfolioSortMode === "number"
      ? [...activeTasksUnsorted].sort((a, b) => projectNumberOf(b).localeCompare(projectNumberOf(a)))
      : activeTasksUnsorted;
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

  // Neon-green "unread" ring: unlike newlyAddedIds (a few-second pop-in animation,
  // cleared by its own setTimeout), this persists across reloads until the task is
  // actually opened — so an inbound bubble you haven't looked at yet keeps flashing
  // even if you close the tab and come back tomorrow.
  const UNSEEN_KEY = "punch_unseen_task_ids";
  const [unseenIds, setUnseenIds] = useState(() => {
    try {
      const raw = localStorage.getItem(UNSEEN_KEY);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (e) {
      return new Set();
    }
  });
  const unseenIdsRef = useRef(unseenIds);
  useEffect(() => {
    unseenIdsRef.current = unseenIds;
  }, [unseenIds]);
  function persistUnseen(next) {
    setUnseenIds(next);
    try {
      localStorage.setItem(UNSEEN_KEY, JSON.stringify([...next]));
    } catch (e) {
      // ignore storage errors (e.g. private browsing quota)
    }
  }
  // Batches so a forEach over several new tasks in the same tick doesn't clobber
  // itself reading a stale ref between calls.
  function markUnseenBatch(ids) {
    if (!ids.length) return;
    persistUnseen(new Set([...unseenIdsRef.current, ...ids]));
  }
  function markSeen(id) {
    if (!unseenIdsRef.current.has(id)) return;
    const next = new Set(unseenIdsRef.current);
    next.delete(id);
    persistUnseen(next);
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
    const isUnseen = !n.isProject && unseenIds.has(n.id);
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
          {isUnseen && (
            // Neon-green halo: a new inbound task nobody's looked at yet. Persists
            // across reloads (unlike the brief inflate/drift pop-in) and only clears
            // the first time this task is actually opened.
            <circle r={n.r + 5} fill="none" stroke="#39FF14" strokeWidth="2.5" style={{ animation: "unseenFlash 0.9s ease-in-out infinite" }} />
          )}
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
    // newHistory has to be computed synchronously, not inside the setState updater
    // below — React doesn't guarantee that updater runs before this function
    // continues, so relying on it to assign a variable used a few lines later was
    // sending an empty {} body to the PATCH (history silently dropped as undefined)
    // whenever the updater happened to run after this point instead of before it.
    const event = historyEvent(type, text);
    const current = (selected && selected.id === taskId ? selected.history : null) || [];
    const newHistory = [...current, event];
    updateStore(taskId, (t) => ({ ...t, history: newHistory }));
    setSelected((prev) => (prev && prev.id === taskId ? { ...prev, history: newHistory } : prev));
    persist(apiPatch(apiPathFor(taskId), { history: newHistory }));
  }

  function openDetail(task) {
    markSeen(task.id);
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

    // Peek-panel/edit-editor state was keyed by item type only, not by task — leaving
    // it set when switching between two Portfolio records could show one task's
    // cached Drawings/Forms/etc. on a different task. Clear on every open.
    setExpandedChecklistItem(null);
    setProcoreDetails({});
    setProcoreDetailLoading(new Set());
    setBudgetPopulateResult(null);
    setEditingChecklistField(null);
    setEditDraft({});
    setChecklistFieldError(null);
    setAddressSuggestions(null);
    setShowManualAddress(false);

    // Portfolio records are a live mirror of Procore, not PUNCH's own data — refresh
    // on open so a PM's change made directly in Procore (not through PUNCH) is never
    // silently stale here. Manual checklist items are preserved server-side.
    if (task.list === "portfolio" && task.checklist && task.sourceUrl) {
      apiGet(`/portfolio/procore-refresh?task_id=${task.id}`)
        .then((row) => {
          const refreshed = normalizeTask(row);
          updateStore(task.id, (t) => ({ ...t, ...refreshed }));
          setSelected((prev) => (prev && prev.id === task.id ? { ...prev, ...refreshed } : prev));
        })
        .catch((err) => console.error("Procore refresh failed:", err));
    }
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

  // Checklist items backed by a live look into Procore rather than just a checkbox —
  // maps the checklist key to which /portfolio/procore-detail "item" to fetch. Both
  // form-related keys share the same "forms" fetch since Ben just wants the full
  // forms list either way, not a filtered view.
  const CHECKLIST_DETAIL_ITEMS = {
    drawings: "drawings",
    po_on_file: "po_on_file",
    tm_agreement: "forms",
    form1000: "forms",
    budget_populated: "budget",
    tender_emails: "emails",
  };

  function toggleProcoreDetail(itemKey) {
    if (expandedChecklistItem === itemKey) {
      setExpandedChecklistItem(null);
      return;
    }
    setExpandedChecklistItem(itemKey);
    const detailType = CHECKLIST_DETAIL_ITEMS[itemKey];
    if (!detailType || procoreDetails[detailType]) return;
    setProcoreDetailLoading((prev) => new Set(prev).add(detailType));
    apiGet(`/portfolio/procore-detail?task_id=${selected.id}&item=${detailType}`)
      .then((data) => setProcoreDetails((prev) => ({ ...prev, [detailType]: data })))
      .catch(() => setProcoreDetails((prev) => ({ ...prev, [detailType]: { error: "Couldn't load from Procore" } })))
      .finally(() =>
        setProcoreDetailLoading((prev) => {
          const next = new Set(prev);
          next.delete(detailType);
          return next;
        })
      );
  }

  // Replaces the old "Procore Budget Importer" PA flow — runs against just the one
  // project being looked at, on click, instead of a twice-daily scan of the whole
  // company. Safe to click more than once: the backend skips anything already on
  // the budget, same duplicate protection the old flow had.
  function populateBudget() {
    setBudgetPopulating(true);
    setBudgetPopulateResult(null);
    apiPost(`/portfolio/populate-budget?task_id=${selected.id}`, {})
      .then((result) => {
        setBudgetPopulateResult(result);
        if (result.checklist) {
          updateStore(selected.id, (t) => ({ ...t, checklist: result.checklist }));
          setSelected((prev) => ({ ...prev, checklist: result.checklist }));
        }
      })
      .catch((err) => setBudgetPopulateResult({ error: err.message }))
      .finally(() => setBudgetPopulating(false));
  }

  // Renders the "take a peek" panel content for a checklist item wired to
  // /portfolio/procore-detail — folder contents, forms list, or a budget count.
  // Read-only by design: Ben confirmed this is enough to spot a missing file and
  // go follow up with the responsible party directly in Procore, not a sync target.
  function renderProcoreDetail(detailType, detail) {
    if (detailType === "drawings" || detailType === "po_on_file") {
      if (!detail.found) return `Folder "${detail.folderName}" not found in Procore Documents`;
      if (!detail.files || !detail.files.length) return `${detail.folderName}: no files yet`;
      return (
        <div>
          {detail.files.map((f, i) => (
            <div key={i}>{f.name}</div>
          ))}
        </div>
      );
    }
    if (detailType === "forms") {
      if (!detail.forms || !detail.forms.length) return "No forms found on this project";
      return (
        <div>
          {detail.forms.map((f, i) => (
            <div key={i}>
              {f.name}
              {f.template ? ` (${f.template})` : ""}
            </div>
          ))}
        </div>
      );
    }
    if (detailType === "budget") {
      return `${detail.count} budget code${detail.count === 1 ? "" : "s"} added`;
    }
    if (detailType === "emails") {
      if (!detail.emails || !detail.emails.length) return "No emails stored on this project yet";
      return (
        <div>
          {detail.emails.map((e, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              {e.subject || "(no subject)"}
              {e.sentAt ? ` — ${new Date(e.sentAt).toLocaleDateString()}` : ""}
              {e.attachmentCount ? ` (${e.attachmentCount} attachment${e.attachmentCount === 1 ? "" : "s"})` : ""}
            </div>
          ))}
        </div>
      );
    }
    return null;
  }

  const editInputStyle = {
    padding: "4px 8px",
    borderRadius: 4,
    border: "1px solid #C9C0AC",
    background: "transparent",
    fontFamily: FONT_MONO,
    fontSize: SIZE_XS,
    color: "#5C5850",
    width: "100%",
    boxSizing: "border-box",
  };

  function editSelect(field, options, valueKey, getLabel) {
    const current = editDraft.id != null ? String(editDraft.id) : "";
    return (
      <select
        autoFocus
        value={current}
        onChange={(e) => {
          const opt = options.find((o) => String(o[valueKey]) === e.target.value);
          setEditDraft(opt ? { ...opt } : {});
        }}
        style={editInputStyle}
      >
        <option value="">— select —</option>
        {options.map((o) => (
          <option key={o[valueKey]} value={o[valueKey]}>
            {getLabel(o)}
          </option>
        ))}
      </select>
    );
  }

  // Draft is always shaped to exactly match what buildProcoreWriteback expects for
  // this field on the worker — see saveChecklistField.
  function renderChecklistFieldEditor(key) {
    if (LIVE_OPTION_FIELDS.has(key) || key === "department" || key === "currency") {
      const options = procoreOptions[key];
      if (!options) return <div style={{ fontFamily: FONT_MONO, fontSize: SIZE_XS, color: "#8A8375" }}>Loading options…</div>;
      if (key === "currency") return editSelect(key, options, "id", (o) => o.label);
      return editSelect(key, options, "id", (o) => o.name);
    }

    if (key === "timezone") {
      return (
        <select
          autoFocus
          value={editDraft.name || ""}
          onChange={(e) => setEditDraft({ name: e.target.value })}
          style={editInputStyle}
        >
          <option value="">— select —</option>
          {PROCORE_TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      );
    }

    if (key === "address") {
      if (addressSuggestLoading) {
        return <div style={{ fontFamily: FONT_MONO, fontSize: SIZE_XS, color: "#8A8375" }}>Checking known locations…</div>;
      }
      if (!showManualAddress && addressSuggestions && addressSuggestions.length > 0) {
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {addressSuggestions.map((loc) => (
              <div
                key={loc.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "6px 8px",
                  border: "1px solid #C9C0AC",
                  borderRadius: 4,
                  background: "#F1ECE1",
                }}
              >
                <div style={{ fontFamily: FONT_BODY, fontSize: SIZE_XS, color: "#2A2419" }}>
                  <div style={{ fontWeight: 700 }}>{loc.name}</div>
                  <div style={{ color: "#8A8375" }}>
                    {loc.address}
                    {loc.city ? `, ${loc.city}` : ""}
                    {loc.province ? `, ${loc.province}` : ""}
                  </div>
                  <div style={{ color: "#B8AF9E", fontFamily: FONT_MONO, fontSize: 9 }}>
                    matched on "{loc.matchedOn}" — used {loc.times_used}×
                  </div>
                </div>
                <button
                  onClick={() => useSuggestedAddress(loc)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 4,
                    border: "1px solid #5B8C5A",
                    background: "#5B8C5A",
                    color: "#F1ECE1",
                    fontFamily: FONT_MONO,
                    fontWeight: 700,
                    fontSize: SIZE_XS,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  USE THIS
                </button>
              </div>
            ))}
            <button
              onClick={() => setShowManualAddress(true)}
              style={{
                padding: "4px 8px",
                border: "1px dashed #C9C0AC",
                background: "transparent",
                borderRadius: 4,
                color: "#8A8375",
                fontFamily: FONT_MONO,
                fontSize: SIZE_XS,
                cursor: "pointer",
                alignSelf: "flex-start",
              }}
            >
              None of these — enter manually
            </button>
          </div>
        );
      }

      // Country/State are Procore dropdowns, not free text — writing "Canada" instead
      // of "CA" is what caused the write-back 502 Ben hit, so these send codes only.
      const countryOptions = procoreOptions.country;
      const stateOptions = procoreOptions.state || PROCORE_PROVINCES;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            autoFocus
            placeholder="Street"
            value={editDraft.street || ""}
            onChange={(e) => setEditDraft((d) => ({ ...d, street: e.target.value }))}
            style={editInputStyle}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <input
              placeholder="City"
              value={editDraft.city || ""}
              onChange={(e) => setEditDraft((d) => ({ ...d, city: e.target.value }))}
              style={editInputStyle}
            />
            <select
              value={editDraft.state || ""}
              onChange={(e) => setEditDraft((d) => ({ ...d, state: e.target.value }))}
              style={{ ...editInputStyle, maxWidth: 130 }}
            >
              <option value="">State/Prov.</option>
              {stateOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              placeholder="Zip/Postal"
              value={editDraft.zip || ""}
              onChange={(e) => setEditDraft((d) => ({ ...d, zip: e.target.value }))}
              style={editInputStyle}
            />
            {countryOptions ? (
              <select
                value={editDraft.country || ""}
                onChange={(e) => setEditDraft((d) => ({ ...d, country: e.target.value }))}
                style={{ ...editInputStyle, maxWidth: 140 }}
              >
                <option value="">Country</option>
                {countryOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <div style={{ ...editInputStyle, maxWidth: 140, color: "#8A8375" }}>Loading countries…</div>
            )}
          </div>
        </div>
      );
    }

    if (key === "dates") {
      return (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            autoFocus
            type="date"
            value={editDraft.startDate || ""}
            onChange={(e) => setEditDraft((d) => ({ ...d, startDate: e.target.value }))}
            style={editInputStyle}
          />
          <span style={{ fontFamily: FONT_MONO, fontSize: SIZE_XS, color: "#8A8375" }}>→</span>
          <input
            type="date"
            value={editDraft.endDate || ""}
            onChange={(e) => setEditDraft((d) => ({ ...d, endDate: e.target.value }))}
            style={editInputStyle}
          />
        </div>
      );
    }

    if (key === "po_number") {
      return (
        <input
          autoFocus
          placeholder="PO Number"
          value={editDraft.text || ""}
          onChange={(e) => setEditDraft({ text: e.target.value })}
          style={editInputStyle}
        />
      );
    }

    return null;
  }

  // Fields whose valid options live in Procore and can change over time — fetched
  // once per field and cached for the rest of the session.
  const LIVE_OPTION_FIELDS = new Set(["stage", "region", "customer"]);

  function loadProcoreOptions(field) {
    if (procoreOptions[field] || procoreOptionsLoading.has(field)) return;
    setProcoreOptionsLoading((prev) => new Set(prev).add(field));
    apiGet(`/portfolio/procore-options?field=${field}`)
      .then((data) => setProcoreOptions((prev) => ({ ...prev, [field]: data.options })))
      .catch(() => setProcoreOptions((prev) => ({ ...prev, [field]: [] })))
      .finally(() =>
        setProcoreOptionsLoading((prev) => {
          const next = new Set(prev);
          next.delete(field);
          return next;
        })
      );
  }

  function startEditChecklistField(key, itemDone) {
    setEditingChecklistField(key);
    setEditDraft({});
    setChecklistFieldError(null);
    if (LIVE_OPTION_FIELDS.has(key)) loadProcoreOptions(key);
    if (key === "department" && !procoreOptions.department) {
      setProcoreOptions((prev) => ({ ...prev, department: PROCORE_DEPARTMENTS }));
    }
    if (key === "currency" && !procoreOptions.currency) {
      setProcoreOptions((prev) => ({ ...prev, currency: PROCORE_CURRENCIES }));
    }
    if (key === "address") {
      loadProcoreOptions("country");
      if (!procoreOptions.state) {
        setProcoreOptions((prev) => ({ ...prev, state: PROCORE_PROVINCES }));
      }
      setShowManualAddress(false);
      if (itemDone) {
        // Already has an address — nothing to suggest, go straight to the form.
        setAddressSuggestions([]);
      } else {
        setAddressSuggestions(null);
        setAddressSuggestLoading(true);
        apiGet(`/locations/suggest?query=${encodeURIComponent(selected.summary)}`)
          .then((data) => setAddressSuggestions(data.matches || []))
          .catch(() => setAddressSuggestions([]))
          .finally(() => setAddressSuggestLoading(false));
      }
    }
  }

  function useSuggestedAddress(loc) {
    setEditDraft({
      street: loc.address,
      city: loc.city || "",
      state: loc.province || "",
      zip: loc.postal_code || "",
      country: loc.country || "",
    });
    setShowManualAddress(true);
  }

  function cancelEditChecklistField() {
    setEditingChecklistField(null);
    setEditDraft({});
    setChecklistFieldError(null);
    setAddressSuggestions(null);
    setShowManualAddress(false);
  }

  // editDraft is always shaped to match exactly what the worker's buildProcoreWriteback
  // expects for the field being edited (e.g. {id, name} for a dropdown pick, {text} for
  // PO Number) — see saveChecklistField's callers for each field's shape.
  function saveChecklistField() {
    const field = editingChecklistField;
    setSavingChecklistField(true);
    setChecklistFieldError(null);
    apiPatch(`/portfolio/procore-writeback?task_id=${selected.id}`, { field, value: editDraft })
      .then((data) => {
        setTasks((prev) => prev.map((t) => (t.id === selected.id ? { ...t, checklist: data.checklist } : t)));
        setSelected((prev) => ({ ...prev, checklist: data.checklist }));
        pushHistory(selected.id, "procore_writeback", `Updated in Procore: ${data.item.label}`);
        setEditingChecklistField(null);
        setEditDraft({});
        setAddressSuggestions(null);
        setShowManualAddress(false);
      })
      .catch((err) => setChecklistFieldError(err.message || "Couldn't save to Procore"))
      .finally(() => setSavingChecklistField(false));
  }

  function addNoteOnly() {
    if (!note.trim()) return;
    pushHistory(selected.id, "note", note.trim());
    setNote("");
    setSelected(null);
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
    const taskId = selected.id;
    const oldType = selected.projectType;

    if (!newType) {
      // Clearing back to no type — no Procore data needed, just an empty checklist.
      const newChecklist = [];
      updateStore(taskId, (t) => ({ ...t, projectType: newType, checklist: newChecklist }));
      setSelected((prev) => (prev && prev.id === taskId ? { ...prev, projectType: newType, checklist: newChecklist } : prev));
      persist(apiPatch(`/tasks/${taskId}`, { project_type: newType, checklist: newChecklist }));
      pushHistory(taskId, "project_type_changed", `Project type cleared (was ${oldType})`);
      return;
    }

    // Picking a real type always re-fetches live from Procore rather than just
    // re-templating whatever checklist was already loaded client-side — that
    // client-side-only path was how a project with no type set in Procore (which
    // starts with an empty checklist) ended up showing every field as blank after
    // picking a type, even when Procore genuinely had values for them.
    apiGet(`/portfolio/procore-refresh?task_id=${taskId}&type=${encodeURIComponent(newType)}`)
      .then((row) => {
        const refreshed = normalizeTask(row);
        updateStore(taskId, (t) => ({ ...t, ...refreshed }));
        setSelected((prev) => (prev && prev.id === taskId ? { ...prev, ...refreshed } : prev));
        pushHistory(taskId, "project_type_changed", `Project type set to ${newType} (was ${oldType}) — refreshed from Procore`);
      })
      .catch((err) => console.error("Project type refresh failed:", err));
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
        completed_at: new Date().toISOString(),
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

  function celebrateResolve() {
    playResolveChime();
    const id = Date.now();
    setResolveBurst(id);
    setTimeout(() => setResolveBurst((prev) => (prev === id ? null : prev)), 900);
  }

  function resolveTask() {
    celebrateResolve();
    pushHistory(selected.id, "resolved", note.trim() || "Marked resolved");
    persist(
      apiPatch(`/tasks/${selected.id}`, {
        status: "done",
        resolution_note: note,
        completed_at: new Date().toISOString(),
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
        @keyframes unseenFlash { 0%,100% { opacity: 0.35; filter: drop-shadow(0 0 2px rgba(57,255,20,0.7)); } 50% { opacity: 1; filter: drop-shadow(0 0 10px rgba(57,255,20,1)); } }
        @keyframes burstOut { 0% { transform: translate(-50%,-50%) scale(1); opacity: 1; } 100% { transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(0.25); opacity: 0; } }
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
          <div style={{ position: "relative" }}>
            <div
              onClick={() => setAppSwitcherOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                cursor: "pointer",
                userSelect: "none",
              }}
            >
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
              <span style={{ color: "#8A8375", fontSize: 12, transform: appSwitcherOpen ? "rotate(180deg)" : "none" }}>▾</span>
            </div>
            <span
              style={{
                fontFamily: "'Inter', sans-serif",
                fontSize: 9,
                fontStyle: "italic",
                color: "#8A8375",
                opacity: 0.5,
                display: "block",
                marginTop: 2,
              }}
            >
              An Einbau Product
            </span>
            {appSwitcherOpen && (
              <>
                <div
                  onClick={() => setAppSwitcherOpen(false)}
                  style={{ position: "fixed", inset: 0, zIndex: 999 }}
                />
                <div
                  style={{
                    position: "absolute",
                    top: "100%",
                    left: 0,
                    marginTop: 6,
                    background: "#26221D",
                    border: "1px solid #3A352C",
                    borderRadius: 4,
                    minWidth: 180,
                    zIndex: 1000,
                    overflow: "hidden",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                  }}
                >
                  {APP_SWITCHER_LINKS.map((app) => (
                    <a
                      key={app.name}
                      href={app.comingSoon ? undefined : app.url}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 14px",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: "0.05em",
                        textDecoration: "none",
                        color: app.current ? app.color : app.comingSoon ? "#5C5850" : "#D9D2C4",
                        background: app.current ? "rgba(226,135,26,0.08)" : "transparent",
                        cursor: app.comingSoon ? "default" : "pointer",
                        borderBottom: "1px solid #2E2A24",
                      }}
                    >
                      {app.name}
                      {app.comingSoon && (
                        <span style={{ fontSize: 9, color: "#5C5850", fontWeight: 400 }}>COMING SOON</span>
                      )}
                    </a>
                  ))}
                </div>
              </>
            )}
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
                // Saved Searches isn't backed by tasks at all (it's a live NetSuite
                // worklist, pendingProjects) — the generic tasks.filter below would
                // always read 0 for it otherwise, regardless of what's actually pending.
                : t.id === "searches"
                ? pendingProjects.length
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
          {tab !== "snoozed" && tab !== "digest" && tab !== "searches" && !openedProjectId && (
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

        {addPanelOpen && tab !== "snoozed" && tab !== "digest" && tab !== "searches" && !openedProjectId && (
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
        {tab === "searches" ? (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <button
                onClick={loadPendingProjects}
                disabled={pendingLoading}
                style={{
                  padding: "9px 16px",
                  background: pendingLoading ? "#E9E2D2" : "#E2871A",
                  color: "#1E1C1A",
                  border: "none",
                  borderRadius: 4,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 700,
                  fontSize: 11,
                  cursor: pendingLoading ? "default" : "pointer",
                }}
              >
                {pendingLoading ? "LOADING..." : "REFRESH FROM NETSUITE"}
              </button>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: "#8B8680" }}>
                NetSuite Inbound Projects sitting at "Pending Completion" — read and written live, nothing cached here.
              </span>
            </div>

            {pendingError && (
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#C1401C", marginBottom: 14 }}>
                {pendingError}
              </div>
            )}

            {pendingLoading && pendingProjects.length === 0 ? (
              <div style={{ fontFamily: "'JetBrains Mono', monospace", color: "#8B8680", fontSize: 12 }}>
                LOADING...
              </div>
            ) : pendingProjects.length === 0 ? (
              <div style={{ fontFamily: "'JetBrains Mono', monospace", color: "#5C5850", fontSize: 13 }}>
                Nothing pending completion right now.
              </div>
            ) : (
              // Compact row, same shape/spirit as Portfolio's list rows (colored left
              // border, single summary line, small metadata line, right-aligned status)
              // rather than an always-expanded card — click opens the actual editor
              // below. Border color stands in for Portfolio's priority color here:
              // green when nothing's missing, red when something needs attention.
              pendingProjects.map((p) => {
                const missingCount = p.missingFields.length;
                const color = missingCount > 0 ? "#C1401C" : "#8FC742";
                return (
                  <div
                    key={p.id}
                    onClick={() => setOpenedPendingId(p.id)}
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
                    }}
                  >
                    <div style={{ width: 14, height: 14, borderRadius: "50%", border: "1.5px solid #5C5850", flexShrink: 0 }} />
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
                        {p.name}
                      </div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#8B8680" }}>
                        {p.procoreId ? `#${p.procoreId}` : "NO PROCORE ID"}
                      </div>
                    </div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, fontWeight: 700, color, flexShrink: 0 }}>
                      {missingCount > 0 ? `${missingCount} MISSING` : "COMPLETE"}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : tab === "digest" ? (
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
              // foreignObject doesn't auto-size to its content like a normal div would -
              // it needs an explicit height, and the old fixed 108/148 clipped anything
              // longer than about one line of summary. Estimate wrapped line count at
              // this box's actual width instead (capped so a pathological summary can't
              // blow the tooltip up into a full paragraph).
              const summaryLines = Math.min(4, Math.max(1, Math.ceil((hoveredNode.summary || "").length / 30)));
              const tooltipHeight = 92 + summaryLines * 16 + (latest ? 44 : 0);
              return (
                <g
                  transform={`translate(${hoveredNode.x},${hoveredNode.y})`}
                  style={{ pointerEvents: "auto" }}
                  onPointerEnter={(e) => handleHoverEnter(hoveredNode.id, e)}
                  onPointerLeave={handleHoverLeave}
                >
                  <foreignObject x={-110} y={hoveredNode.r + 8} width={220} height={tooltipHeight}>
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
            {tab === "portfolio" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <span style={{ fontFamily: FONT_MONO, fontSize: SIZE_XS, color: "#8A8375" }}>SORT:</span>
                {[
                  { key: "age", label: "AGE" },
                  { key: "number", label: "PROJECT #" },
                ].map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => setPortfolioSortMode(opt.key)}
                    style={{
                      padding: "3px 8px",
                      borderRadius: 4,
                      border: `1px solid ${portfolioSortMode === opt.key ? "#E2871A" : "#3A3632"}`,
                      background: portfolioSortMode === opt.key ? "#E2871A22" : "transparent",
                      color: portfolioSortMode === opt.key ? "#E2871A" : "#8A8375",
                      fontFamily: FONT_MONO,
                      fontWeight: 700,
                      fontSize: SIZE_XS,
                      cursor: "pointer",
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
            {activeTasks.map((t) => {
              const color = priorityColor[effectivePriority(t)];
              const age = daysOpen(t.createdAt);
              const hasNote = (t.history || []).some((h) => h.type === "note");
              const checklistDone = t.checklist ? t.checklist.filter((c) => c.done).length : null;
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
                      {t.summary.replace(/^New Procore project:\s*/, "")}
                    </div>
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        color: "#8B8680",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <span>
                        #{t.ticket} · {t.category.toUpperCase()}
                      </span>
                      {checklistDone !== null && (
                        <span title="Checklist items complete" style={{ color: "#B8AF9E" }}>
                          {checklistDone}/{t.checklist.length}
                        </span>
                      )}
                      {hasNote && (
                        <span title="Has a note" style={{ color: "#B8AF9E" }}>
                          ✎
                        </span>
                      )}
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
                      {ev.source_url && (
                        <a
                          href={ev.source_url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ marginLeft: 6, color: "#8FC742", textDecoration: "none" }}
                        >
                          ↗ view
                        </a>
                      )}
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
              {selected.list !== "portfolio" && (
                <>
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
                </>
              )}
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: SIZE_SM,
                  color: "#8A8375",
                }}
              >
                · {daysOpen(selected.createdAt)}D OPEN
              </span>
              {selected.list !== "portfolio" && (
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
              )}
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
            {selected.list !== "portfolio" && (
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
            )}

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
                    value={selected.projectType || ""}
                    onChange={(e) => switchProjectType(e.target.value || null)}
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
                    <option value="">— SELECT TYPE —</option>
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

                <div style={{ maxHeight: 320, overflowY: "auto", paddingRight: 4 }}>
                {selected.checklist.map((item) => {
                  const detailType = CHECKLIST_DETAIL_ITEMS[item.key];
                  const isLink = item.key === "directory" || item.key === "estimates_reviewed";
                  const isWriteback = WRITEBACK_FIELDS.has(item.key);
                  const isEditingThis = editingChecklistField === item.key;
                  const projectId = procoreProjectIdFromUrl(selected.sourceUrl);
                  const linkHref = !isLink
                    ? null
                    : !projectId
                    ? null
                    : item.key === "directory"
                    ? procoreDirectoryLink(projectId)
                    : procoreEstimateLink(projectId);
                  const isExpanded = expandedChecklistItem === item.key;
                  const detail = detailType ? procoreDetails[detailType] : null;
                  const isLoading = detailType && procoreDetailLoading.has(detailType);

                  return (
                    <div key={item.key}>
                      <div
                        onClick={isWriteback ? undefined : () => toggleChecklistItem(item.key)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "5px 0",
                          cursor: isWriteback ? "default" : "pointer",
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
                            flex: 1,
                            fontFamily: FONT_BODY,
                            fontSize: SIZE_MD,
                            color: item.done ? "#8A8375" : "#2A2419",
                            textDecoration: item.done ? "line-through" : "none",
                          }}
                        >
                          {item.label}
                        </div>
                        {isWriteback && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              isEditingThis ? cancelEditChecklistField() : startEditChecklistField(item.key, item.done);
                            }}
                            title="Update this in Procore"
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 3,
                              padding: "2px 6px",
                              background: "transparent",
                              border: "1px solid #C9C0AC",
                              borderRadius: 3,
                              fontFamily: FONT_MONO,
                              fontWeight: 700,
                              fontSize: SIZE_XS,
                              color: "#8A8375",
                              cursor: "pointer",
                              flexShrink: 0,
                            }}
                          >
                            {isEditingThis ? "✕ CANCEL" : "✎ EDIT"}
                          </button>
                        )}
                        {detailType && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleProcoreDetail(item.key);
                            }}
                            title="Peek at this in Procore"
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 3,
                              padding: "2px 6px",
                              background: "transparent",
                              border: "1px solid #C9C0AC",
                              borderRadius: 3,
                              fontFamily: FONT_MONO,
                              fontWeight: 700,
                              fontSize: SIZE_XS,
                              color: "#8A8375",
                              cursor: "pointer",
                              flexShrink: 0,
                            }}
                          >
                            {isExpanded ? "▾" : "▸"} VIEW
                          </button>
                        )}
                        {item.key === "budget_populated" && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              populateBudget();
                            }}
                            disabled={budgetPopulating}
                            title="Fetch this project's live cost codes and post any missing boilerplate budget lines"
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 3,
                              padding: "2px 6px",
                              background: "transparent",
                              border: "1px solid #C9C0AC",
                              borderRadius: 3,
                              fontFamily: FONT_MONO,
                              fontWeight: 700,
                              fontSize: SIZE_XS,
                              color: budgetPopulating ? "#C9C0AC" : "#8A8375",
                              cursor: budgetPopulating ? "default" : "pointer",
                              flexShrink: 0,
                            }}
                          >
                            {budgetPopulating ? "RUNNING…" : "▶ RUN"}
                          </button>
                        )}
                        {isLink && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (linkHref) window.open(linkHref, "_blank", "noopener,noreferrer");
                            }}
                            disabled={!linkHref}
                            title={linkHref ? "Open in Procore" : "No Procore project linked"}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              padding: "2px 6px",
                              background: "transparent",
                              border: "1px solid #C9C0AC",
                              borderRadius: 3,
                              color: linkHref ? "#8A8375" : "#C9C0AC",
                              cursor: linkHref ? "pointer" : "default",
                              flexShrink: 0,
                            }}
                          >
                            <LinkIcon size={12} />
                          </button>
                        )}
                      </div>

                      {isExpanded && detailType && (
                        <div
                          style={{
                            marginLeft: 24,
                            marginBottom: 8,
                            padding: "6px 10px",
                            background: "#EDE6D6",
                            borderRadius: 4,
                            fontFamily: FONT_MONO,
                            fontSize: SIZE_XS,
                            color: "#5C5850",
                            lineHeight: 1.6,
                          }}
                        >
                          {isLoading && "Loading from Procore…"}
                          {!isLoading && detail && detail.error && (
                            <span style={{ color: "#C1401C" }}>{detail.error}</span>
                          )}
                          {!isLoading && detail && !detail.error && renderProcoreDetail(detailType, detail)}
                        </div>
                      )}

                      {item.key === "budget_populated" && budgetPopulateResult && (
                        <div
                          style={{
                            marginLeft: 24,
                            marginBottom: 8,
                            padding: "6px 10px",
                            background: "#EDE6D6",
                            borderRadius: 4,
                            fontFamily: FONT_MONO,
                            fontSize: SIZE_XS,
                            color: "#5C5850",
                            lineHeight: 1.6,
                          }}
                        >
                          {budgetPopulateResult.error ? (
                            <span style={{ color: "#C1401C" }}>{budgetPopulateResult.error}</span>
                          ) : (
                            <>
                              <div>
                                {budgetPopulateResult.templateUsed} template — {budgetPopulateResult.posted.length} added,{" "}
                                {budgetPopulateResult.skipped.length} already there
                                {budgetPopulateResult.errors.length ? `, ${budgetPopulateResult.errors.length} failed` : ""}
                              </div>
                              {budgetPopulateResult.errors.map((e, i) => (
                                <div key={i} style={{ color: "#C1401C" }}>
                                  {e.code}: {e.reason}
                                </div>
                              ))}
                            </>
                          )}
                        </div>
                      )}

                      {isEditingThis && (
                        <div
                          style={{
                            marginLeft: 24,
                            marginBottom: 8,
                            padding: "8px 10px",
                            background: "#EDE6D6",
                            borderRadius: 4,
                          }}
                        >
                          {renderChecklistFieldEditor(item.key)}
                          {checklistFieldError && (
                            <div style={{ fontFamily: FONT_MONO, fontSize: SIZE_XS, color: "#C1401C", marginTop: 6 }}>
                              {checklistFieldError}
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                            <button
                              onClick={saveChecklistField}
                              disabled={
                                savingChecklistField ||
                                ((LIVE_OPTION_FIELDS.has(item.key) || item.key === "department" || item.key === "currency" || item.key === "timezone") &&
                                  editDraft.id == null &&
                                  !editDraft.name)
                              }
                              style={{
                                padding: "4px 10px",
                                borderRadius: 4,
                                border: "1px solid #5B8C5A",
                                background: "#5B8C5A",
                                color: "#F1ECE1",
                                fontFamily: FONT_MONO,
                                fontWeight: 700,
                                fontSize: SIZE_XS,
                                cursor: "pointer",
                                opacity: savingChecklistField ? 0.6 : 1,
                              }}
                            >
                              {savingChecklistField ? "SAVING…" : "SAVE TO PROCORE"}
                            </button>
                            <button
                              onClick={cancelEditChecklistField}
                              style={{
                                padding: "4px 10px",
                                borderRadius: 4,
                                border: "1px solid #C9C0AC",
                                background: "transparent",
                                color: "#8A8375",
                                fontFamily: FONT_MONO,
                                fontWeight: 700,
                                fontSize: SIZE_XS,
                                cursor: "pointer",
                              }}
                            >
                              CANCEL
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                </div>
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
                  {selected.list !== "portfolio" && (
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
                  )}
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
      <div style={{ textAlign: "center", padding: "40px 0 10px", pointerEvents: "none" }}>
        <img
          src="https://lambwright.github.io/scout-addin/logo.png"
          alt=""
          style={{
            height: 80,
            opacity: 0.1,
            WebkitMaskImage: "linear-gradient(to bottom, black, transparent)",
            maskImage: "linear-gradient(to bottom, black, transparent)",
          }}
        />
      </div>
      {resolveBurst && (
        // The "win" moment for MARK RESOLVED — fixed to the viewport (not the modal)
        // so it stays visible through the modal closing, rather than getting
        // unmounted the instant setSelected(null) runs.
        <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9999 }}>
          {Array.from({ length: 20 }).map((_, i) => {
            const angle = (i / 20) * 360 + (Math.random() * 14 - 7);
            const distance = 90 + Math.random() * 80;
            const dx = Math.cos((angle * Math.PI) / 180) * distance;
            const dy = Math.sin((angle * Math.PI) / 180) * distance;
            const dot = ["#E2871A", "#39FF14", "#F1ECE1", "#C9A227"][i % 4];
            return (
              <span
                key={`${resolveBurst}-${i}`}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: dot,
                  "--dx": `${dx}px`,
                  "--dy": `${dy}px`,
                  animation: "burstOut 0.8s cubic-bezier(0.2,0.8,0.3,1) both",
                }}
              />
            );
          })}
        </div>
      )}
      {authToken && (
        <div
          style={{
            position: "fixed", top: 10, right: 16, zIndex: 500,
            display: "flex", alignItems: "center", gap: 8,
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#8A8375",
          }}
        >
          {authUser && <span>{(authUser.displayName || authUser.username || "").toUpperCase()}</span>}
          <button
            onClick={() => {
              localStorage.removeItem(PUNCH_TOKEN_KEY);
              setTasks([]);
              setRecurringTasks([]);
              setAuth(null, null);
            }}
            style={{
              background: "transparent", border: "1px solid #3A352C", color: "#8A8375",
              borderRadius: 4, padding: "4px 8px", fontFamily: "inherit", fontSize: 10, cursor: "pointer",
            }}
          >
            LOG OUT
          </button>
        </div>
      )}

      {/* Saved Searches detail panel — separate from the shared task modal above
          since pendingProjects (live NetSuite records) aren't tasks and have their
          own field shape. Matches the shared modal's chrome (overlay, light card,
          close button) so it still "rhymes" visually, even though its content is
          necessarily different. */}
      {openedPendingId && (() => {
        const p = pendingProjects.find((pp) => pp.id === openedPendingId);
        if (!p) return null;
        const draft = pendingEdits[p.id] || {};
        const hasDraft = Object.keys(draft).length > 0;
        const fieldValue = (field, idKey) => {
          if (draft[field] !== undefined) return draft[field] || "";
          return p[idKey] || "";
        };
        const isMissing = (field) => p.missingFields.includes(field) && draft[field] === undefined;
        const lightSelectStyle = (missing) => ({
          padding: "4px 8px",
          borderRadius: 4,
          border: `1px solid ${missing ? "#C1401C" : "#C9C0AC"}`,
          background: "transparent",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: "#5C5850",
          width: "100%",
          boxSizing: "border-box",
        });
        const customerDisplay =
          draft.customer !== undefined ? draft.customer?.name || "" : customerQuery[p.id] ?? p.customerName ?? "";

        return (
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
            onClick={() => setOpenedPendingId(null)}
          >
            <div
              style={{
                background: "#F1ECE1",
                width: 380,
                maxWidth: "90vw",
                maxHeight: "85vh",
                overflowY: "auto",
                borderRadius: 6,
                padding: 24,
                position: "relative",
                boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setOpenedPendingId(null)}
                style={{ position: "absolute", top: 14, right: 14, background: "none", border: "none", cursor: "pointer", color: "#8A8375" }}
                aria-label="Close"
              >
                <X size={18} />
              </button>

              <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 15, color: "#2A2419", marginBottom: 2, paddingRight: 24 }}>
                {p.name}
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#8A8375", marginBottom: 16 }}>
                {p.procoreId ? `#${p.procoreId}` : "NO PROCORE ID"}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "#8A8375", marginBottom: 3 }}>CUSTOMER</div>
                  <input
                    list={`customer-list-${p.id}`}
                    value={customerDisplay}
                    placeholder="Type to search..."
                    onChange={(e) => {
                      const text = e.target.value;
                      searchCustomers(p.id, text);
                      const match = (customerResults[p.id] || []).find((o) => o.name === text);
                      if (match) updatePendingEdit(p.id, "customer", match);
                      else setPendingEdits((prev) => ({ ...prev, [p.id]: { ...prev[p.id], customer: undefined } }));
                    }}
                    style={lightSelectStyle(isMissing("customer"))}
                  />
                  <datalist id={`customer-list-${p.id}`}>
                    {(customerResults[p.id] || []).map((o) => (
                      <option key={o.id} value={o.name} />
                    ))}
                  </datalist>
                </div>

                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "#8A8375", marginBottom: 3 }}>PROJECT MANAGER</div>
                  <select
                    value={fieldValue("projectManager", "projectManagerId")}
                    onChange={(e) => updatePendingEdit(p.id, "projectManager", e.target.value)}
                    style={lightSelectStyle(isMissing("projectManager"))}
                  >
                    <option value="">— Select —</option>
                    {pmOptions.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "#8A8375", marginBottom: 3 }}>DEPARTMENT</div>
                  <select
                    value={fieldValue("department", "departmentId")}
                    onChange={(e) => updatePendingEdit(p.id, "department", e.target.value)}
                    style={lightSelectStyle(isMissing("department"))}
                  >
                    <option value="">— Select —</option>
                    {pendingOptions.department.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "#8A8375", marginBottom: 3 }}>CLASS</div>
                  <select
                    value={fieldValue("class", "classId")}
                    onChange={(e) => updatePendingEdit(p.id, "class", e.target.value)}
                    style={lightSelectStyle(isMissing("class"))}
                  >
                    <option value="">— Select —</option>
                    {pendingOptions.class.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "#8A8375", marginBottom: 3 }}>LOCATION</div>
                  <select
                    value={fieldValue("location", "locationId")}
                    onChange={(e) => updatePendingEdit(p.id, "location", e.target.value)}
                    style={lightSelectStyle(isMissing("location"))}
                  >
                    <option value="">— Select —</option>
                    {pendingOptions.location.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "#8A8375", marginBottom: 3 }}>APPROVAL STATUS</div>
                  <select
                    value={fieldValue("approvalStatus", "approvalStatusId") || "4"}
                    onChange={(e) => updatePendingEdit(p.id, "approvalStatus", e.target.value)}
                    style={lightSelectStyle(false)}
                  >
                    {pendingOptions.approvalStatus.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {p.address.street && (
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#8A8375", marginBottom: 14 }}>
                  {[p.address.street, p.address.city, p.address.state, p.address.zip, p.address.country].filter(Boolean).join(", ")}
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  onClick={() => savePendingProject(p.id)}
                  disabled={!hasDraft || pendingSavingId === p.id}
                  style={{
                    padding: "8px 16px",
                    background: hasDraft && pendingSavingId !== p.id ? "#5B8C5A" : "#D8D0BE",
                    color: hasDraft && pendingSavingId !== p.id ? "#F1ECE1" : "#8A8375",
                    border: "none",
                    borderRadius: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 700,
                    fontSize: 11,
                    cursor: hasDraft && pendingSavingId !== p.id ? "pointer" : "default",
                  }}
                >
                  {pendingSavingId === p.id ? "SAVING..." : "SAVE"}
                </button>
                {pendingSavedId === p.id && (
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700, color: "#5B8C5A" }}>
                    ✓ SAVED
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {(authChecking || !authToken) && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 100000, background: "#1E1C1A",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "'Inter', sans-serif",
          }}
        >
          {authChecking ? (
            <div style={{ color: "#8A8375", fontFamily: "'JetBrains Mono', monospace", fontSize: 12, letterSpacing: "0.05em" }}>
              CHECKING SESSION…
            </div>
          ) : (
            <form
              onSubmit={doLogin}
              style={{ background: "#26221D", border: "1px solid #3A352C", borderRadius: 6, padding: 32, width: 300 }}
            >
              <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 20, letterSpacing: "0.05em", color: "#E2871A", marginBottom: 4 }}>
                PUNCH
              </div>
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#8A8375",
                  marginBottom: 20, textTransform: "uppercase", letterSpacing: "0.08em",
                }}
              >
                Einbau ID sign-in
              </div>
              <input
                type="text"
                autoComplete="username"
                placeholder="Username"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                required
                style={{
                  width: "100%", boxSizing: "border-box", padding: "10px 12px", marginBottom: 10,
                  background: "#1E1C1A", border: "1px solid #3A352C", borderRadius: 4,
                  color: "#F1ECE1", fontFamily: "'Inter', sans-serif", fontSize: 13,
                }}
              />
              <input
                type="password"
                autoComplete="current-password"
                placeholder="Password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                required
                style={{
                  width: "100%", boxSizing: "border-box", padding: "10px 12px", marginBottom: 14,
                  background: "#1E1C1A", border: "1px solid #3A352C", borderRadius: 4,
                  color: "#F1ECE1", fontFamily: "'Inter', sans-serif", fontSize: 13,
                }}
              />
              <button
                type="submit"
                disabled={loginSubmitting}
                style={{
                  width: "100%", padding: "10px 0", background: "#E2871A", color: "#1E1C1A",
                  border: "none", borderRadius: 4, fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 700, fontSize: 12, letterSpacing: "0.05em",
                  cursor: loginSubmitting ? "default" : "pointer", opacity: loginSubmitting ? 0.6 : 1,
                }}
              >
                {loginSubmitting ? "SIGNING IN…" : "SIGN IN"}
              </button>
              {loginError && (
                <div style={{ marginTop: 10, color: "#C1401C", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                  {loginError}
                </div>
              )}
            </form>
          )}
        </div>
      )}
    </div>
  );
}
