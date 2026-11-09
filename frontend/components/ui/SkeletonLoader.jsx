export default function SkeletonLoader({ count = 4 }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="glass-card overflow-hidden rounded-2xl p-4">
          <div className="flex items-start gap-3">
            <div className="shimmer mt-1.5 h-2.5 w-2.5 rounded-full" />
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="shimmer h-5 w-24 rounded-full" />
                <div className="shimmer h-4 w-28 rounded-full" />
              </div>
              <div className="shimmer h-4 w-3/4 rounded-md" />
              <div className="shimmer h-3 w-1/2 rounded-md" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
