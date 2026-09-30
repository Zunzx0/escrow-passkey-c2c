export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-[#eef2f7] ${className}`} />;
}

export function ListingCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-[12px] border border-[var(--color-border)] bg-white">
      <Skeleton className="aspect-square w-full rounded-none" />
      <div className="space-y-2.5 p-3.5">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    </div>
  );
}
