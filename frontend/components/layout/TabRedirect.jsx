"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function TabRedirect({ tab, label }) {
  const router = useRouter();

  useEffect(() => {
    router.replace(tab === "overview" ? "/" : `/?tab=${tab}`);
  }, [router, tab]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas text-sm text-muted">
      Opening {label}…
    </main>
  );
}
