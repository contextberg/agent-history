import React from 'react';
import { cn } from '../lib/utils';

interface SkeletonProps {
  className?: string;
  style?: React.CSSProperties;
}

export function Skeleton({ className = '', style }: SkeletonProps) {
  return (
    <div
      className={cn("skeleton-shimmer rounded", className)}
      style={{
        backgroundColor: 'var(--bg-inset)',
        ...style,
      }}
    />
  );
}

export function SessionRowSkeleton() {
  return (
    <div className="flex gap-2.5 items-start py-2.5 px-2.5 rounded-lg">
      <Skeleton className="w-4 h-4 mt-1 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-1.5">
          <Skeleton className="w-[60%] h-[13px]" />
          <Skeleton className="w-[30px] h-[10.5px] shrink-0" />
        </div>
        <div className="flex items-center gap-[7px] mt-1.5">
          <Skeleton className="w-[50px] h-[9.5px]" />
          <Skeleton className="w-0.5 h-0.5 rounded-full" />
          <Skeleton className="w-10 h-[10.5px]" />
        </div>
        <Skeleton className="w-[90%] h-[11.5px] mt-2" />
        <Skeleton className="w-[75%] h-[11.5px] mt-1" />
      </div>
    </div>
  );
}

export function SessionListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="py-1.5 pb-2">
      <Skeleton className="w-[60px] h-[10px] my-2.5 mx-4 mb-2" />
      <div className="flex flex-col gap-px px-2">
        {Array.from({ length: count }).map((_, i) => (
          <SessionRowSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export function CommitRowSkeleton() {
  return (
    <div className="flex gap-2.5 items-start py-2.5 px-2.5 rounded-lg">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-1.5">
          <Skeleton className="w-[70%] h-[13px]" />
          <Skeleton className="w-[35px] h-[10.5px] shrink-0" />
        </div>
        <div className="flex items-center gap-[7px] mt-1.5">
          <Skeleton className="w-[50px] h-[10.5px]" />
          <Skeleton className="w-0.5 h-0.5 rounded-full" />
          <Skeleton className="w-20 h-[10.5px]" />
        </div>
      </div>
    </div>
  );
}

export function CommitListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="pb-2">
      <Skeleton className="w-[80%] h-5 my-3 mx-3.5 mb-2" />
      <div className="flex flex-col gap-px px-2">
        {Array.from({ length: count }).map((_, i) => (
          <CommitRowSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export function EmptyStateSkeleton() {
  return (
    <div className="p-3 flex flex-col gap-2">
      <Skeleton className="w-[100px] h-[10px] my-2 mx-2 mb-1" />
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-2.5 py-2 px-3 rounded-lg border"
          style={{
            backgroundColor: 'var(--bg-card)',
            borderColor: 'var(--border-main)',
          }}
        >
          <Skeleton className="w-4 h-4 shrink-0" />
          <div className="flex-1 min-w-0">
            <Skeleton className="w-[40%] h-3" />
            <Skeleton className="w-[70%] h-[11px] mt-1" />
          </div>
        </div>
      ))}
    </div>
  );
}
