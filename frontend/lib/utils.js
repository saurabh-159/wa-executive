import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function priorityTone(priority) {
  const value = String(priority || "MEDIUM").toUpperCase();
  if (value === "HIGH" || value === "URGENT") return "high";
  if (value === "LOW") return "low";
  return "medium";
}

export function isHighPriority(task) {
  const value = String(task?.priority || "").toUpperCase();
  return value === "HIGH" || value === "URGENT";
}

export function formatDeadline(value) {
  if (!value) return "No deadline";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return String(value);

  const date = new Date(parsed);
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((startOf(date) - startOf(new Date())) / 86400000);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (dayDiff === 0) return `Today ${time}`;
  if (dayDiff === 1) return `Tomorrow ${time}`;
  if (dayDiff === -1) return `Yesterday ${time}`;
  if (dayDiff > 1 && dayDiff < 7) {
    return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function deadlineIsTight(value) {
  const label = formatDeadline(value).toLowerCase();
  return (
    label.includes("today") ||
    label.includes("tomorrow") ||
    label.includes("yesterday") ||
    label.includes("overdue")
  );
}

export function buildWhatsAppReminder(task) {
  const name = task.counterparty_name || "there";
  const title = task.task_heading || "our open item";
  const due = task.due_date_time ? formatDeadline(task.due_date_time) : "";

  if (task.category === "I_OWE_THEM") {
    return `Hi ${name}, quick update on "${title}". I'm on it${
      due ? ` and will close this by ${due}` : " and will close it shortly"
    }.`;
  }

  return `Hi ${name}, gentle reminder on "${title}".${
    due ? ` Due: ${due}.` : ""
  } Could you share a quick status when you have a moment?`;
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  document.body.removeChild(area);
}
