import { cn } from "@/lib/utils";

export default function Badge({ category, className }) {
  const youOwe = category === "I_OWE_THEM";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-[0.14em]",
        youOwe
          ? "border-saffron/30 bg-saffron-soft text-saffron-deep shadow-glow-saffron"
          : "border-emerald-200 bg-emerald-50 text-emerald-800 shadow-glow-emerald",
        className
      )}
    >
      {youOwe ? "YOU OWE" : "THEY OWE"}
    </span>
  );
}
