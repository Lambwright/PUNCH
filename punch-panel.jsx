import React, { useState, useRef } from "react";
import { GripVertical, Check, Mail, MessagesSquare, NotebookPen, Hand } from "lucide-react";

// Mock data for scaffolding — swap for GET https://punch-worker.ben-a90.workers.dev/tasks
const initialTasks = [
  {
    id: "1",
    ticket: "0042",
    summary: "Push through change order for Bayview job before Thursday",
    category: "Change Order",
    priority: "high",
    source: "teams",
    status: "open",
  },
  {
    id: "2",
    ticket: "0043",
    summary: "Approve NetSuite access request for new estimator",
    category: "NetSuite Access",
    priority: "urgent",
    source: "email",
    status: "open",
  },
  {
    id: "3",
    ticket: "0044",
    summary: "Send startup documents for the Meridian job",
    category: "Accounting",
    priority: "normal",
    source: "email",
    status: "open",
  },
  {
    id: "4",
    ticket: "0045",
    summary: "Review invoice adjustment flagged by Warren",
    category: "Accounting",
    priority: "low",
    source: "manual",
    status: "open",
  },
];

const priorityStyles = {
  urgent: { bar: "#C1401C", label: "URGENT" },
  high: { bar: "#E2871A", label: "HIGH" },
  normal: { bar: "#8B8680", label: "NORMAL" },
  low: { bar: "#5B7A8C", label: "LOW" },
};

const sourceIcon = {
  email: Mail,
  teams: MessagesSquare,
  journal: NotebookPen,
  manual: Hand,
};

export default function PunchPanel() {
  const [tasks, setTasks] = useState(initialTasks);
  const dragItem = useRef(null);
  const dragOverItem = useRef(null);

  function handleDragStart(index) {
    dragItem.current = index;
  }

  function handleDragEnter(index) {
    dragOverItem.current = index;
  }

  function handleDragEnd() {
    const list = [...tasks];
    const draggedItem = list[dragItem.current];
    list.splice(dragItem.current, 1);
    list.splice(dragOverItem.current, 0, draggedItem);
    dragItem.current = null;
    dragOverItem.current = null;
    setTasks(list);
    // TODO: PATCH each affected task's order_index to the Worker
  }

  function completeTask(id) {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status: "done" } : t))
    );
    // TODO: PATCH https://punch-worker.ben-a90.workers.dev/tasks/:id { status: "done" }
  }

  const openTasks = tasks.filter((t) => t.status === "open");
  const doneCount = tasks.filter((t) => t.status === "done").length;

  return (
    <div
      style={{
        minHeight: "100%",
        background: "#1E1C1A",
        backgroundImage:
          "radial-gradient(circle at 15% 10%, rgba(226,135,26,0.06), transparent 40%)",
        padding: "40px 24px",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;700&display=swap');
      `}</style>

      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div
            style={{
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 700,
              fontSize: 40,
              letterSpacing: "0.04em",
              color: "#F1ECE1",
              textTransform: "uppercase",
              lineHeight: 1,
            }}
          >
            Punch
          </div>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              color: "#8B8680",
              marginTop: 8,
              letterSpacing: "0.02em",
            }}
          >
            {openTasks.length} OPEN &nbsp;·&nbsp; {doneCount} CLOSED TODAY
          </div>
        </div>

        {/* Task list */}
        {openTasks.length === 0 ? (
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              color: "#5C5850",
              fontSize: 13,
              padding: "24px 0",
              borderTop: "1px dashed #3A3733",
            }}
          >
            LIST CLEAR — nothing punched in.
          </div>
        ) : (
          openTasks.map((task, index) => {
            const p = priorityStyles[task.priority];
            const SourceIcon = sourceIcon[task.source];
            return (
              <div
                key={task.id}
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragEnter={() => handleDragEnter(index)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => e.preventDefault()}
                style={{
                  display: "flex",
                  alignItems: "stretch",
                  background: "#F1ECE1",
                  marginBottom: 10,
                  borderRadius: "2px",
                  overflow: "hidden",
                  boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
                  cursor: "grab",
                  clipPath:
                    "polygon(0% 3px, 2% 0%, 4% 3px, 6% 0%, 8% 3px, 10% 0%, 12% 3px, 14% 0%, 16% 3px, 18% 0%, 20% 3px, 22% 0%, 24% 3px, 26% 0%, 28% 3px, 30% 0%, 32% 3px, 34% 0%, 36% 3px, 38% 0%, 40% 3px, 42% 0%, 44% 3px, 46% 0%, 48% 3px, 50% 0%, 52% 3px, 54% 0%, 56% 3px, 58% 0%, 60% 3px, 62% 0%, 64% 3px, 66% 0%, 68% 3px, 70% 0%, 72% 3px, 74% 0%, 76% 3px, 78% 0%, 80% 3px, 82% 0%, 84% 3px, 86% 0%, 88% 3px, 90% 0%, 92% 3px, 94% 0%, 96% 3px, 98% 0%, 100% 3px, 100% 100%, 0% 100%)",
                }}
              >
                {/* Priority bar */}
                <div style={{ width: 6, background: p.bar, flexShrink: 0 }} />

                {/* Drag handle */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "0 6px 0 10px",
                    color: "#B8AF9E",
                  }}
                >
                  <GripVertical size={16} />
                </div>

                {/* Content */}
                <div style={{ flex: 1, padding: "14px 12px" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      marginBottom: 4,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 11,
                        fontWeight: 700,
                        color: "#8A8375",
                        letterSpacing: "0.03em",
                      }}
                    >
                      #{task.ticket}
                    </span>
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        fontWeight: 700,
                        color: p.bar,
                        letterSpacing: "0.05em",
                      }}
                    >
                      {p.label}
                    </span>
                  </div>

                  <div
                    style={{
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 14.5,
                      fontWeight: 500,
                      color: "#2A2419",
                      lineHeight: 1.4,
                      marginBottom: 8,
                    }}
                  >
                    {task.summary}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10.5,
                      color: "#8A8375",
                      letterSpacing: "0.02em",
                    }}
                  >
                    <SourceIcon size={12} />
                    <span>{task.category.toUpperCase()}</span>
                  </div>
                </div>

                {/* Checkbox */}
                <button
                  onClick={() => completeTask(task.id)}
                  aria-label="Mark task complete"
                  style={{
                    width: 44,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "transparent",
                    border: "none",
                    borderLeft: "1px dashed #C9C0AC",
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      border: "1.5px solid #8A8375",
                      borderRadius: "3px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "transparent",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#5B8C5A")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "transparent")}
                  >
                    <Check size={14} strokeWidth={3} />
                  </div>
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
