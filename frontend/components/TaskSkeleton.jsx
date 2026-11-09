"use client";

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="h-6 w-20 shrink-0 animate-pulse rounded-md bg-zinc-200" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-4 w-3/4 max-w-xs animate-pulse rounded bg-zinc-200" />
            <div className="h-3 w-28 animate-pulse rounded bg-zinc-100" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden h-6 w-24 animate-pulse rounded-md bg-zinc-100 sm:block" />
          <div className="h-5 w-5 animate-pulse rounded-full bg-zinc-200" />
        </div>
      </div>
      <div className="mt-3 space-y-2 border-t border-zinc-50 pt-3">
        <div className="h-3 w-full animate-pulse rounded bg-zinc-100" />
        <div className="h-3 w-5/6 animate-pulse rounded bg-zinc-100" />
      </div>
    </div>
  );
}

export default function TaskSkeleton({ count = 4 }) {
  return (
    <div className="space-y-2.5" aria-busy="true" aria-label="Loading tasks">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
