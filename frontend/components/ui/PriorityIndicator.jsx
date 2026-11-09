import { cn, priorityTone } from "@/lib/utils";

const tones = {
  high: "bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.45)]",
  medium: "bg-saffron shadow-glow-saffron",
  low: "bg-muted",
};

const labels = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
};

export default function PriorityIndicator({ priority, className }) {
  const tone = priorityTone(priority);

  return (
    <span
      className={cn("inline-flex h-2.5 w-2.5 shrink-0 rounded-full", tones[tone], className)}
      title={labels[tone]}
      aria-label={labels[tone]}
    />
  );
}
