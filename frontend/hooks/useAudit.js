"use client";

import { useCallback, useState } from "react";
import { searchContactAudit } from "@/lib/api";
import { mockAuditSearch } from "@/lib/mockData";

function normalizeChunk(chunk, index) {
  const timestamp = chunk.timestamp || chunk.timestamp_label || chunk.created_at;
  let timestampLabel = chunk.timestamp_label || "";
  if (!timestampLabel && timestamp) {
    const parsed = Date.parse(typeof timestamp === "number" ? timestamp * 1000 : timestamp);
    timestampLabel = Number.isNaN(parsed)
      ? String(timestamp)
      : new Date(parsed).toLocaleString([], {
          day: "numeric",
          month: "short",
          hour: "numeric",
          minute: "2-digit",
        });
  }

  return {
    id: chunk.id || `chunk-${index}`,
    counterparty_name: chunk.counterparty_name || chunk.sender_name || "Contact",
    timestamp_label: timestampLabel || "Recent",
    text: chunk.text || chunk.document || chunk.excerpt || "",
  };
}

function normalizeAudit(data, query) {
  if (typeof data === "string") {
    return { query, summary: data, chunks: [], live: true };
  }

  const rawChunks = data?.chunks || data?.documents || data?.results || [];
  return {
    query,
    summary: data?.summary || data?.audit || data?.synthesis || "",
    chunks: rawChunks.map(normalizeChunk).filter((chunk) => chunk.text),
    live: true,
  };
}

export function useAudit() {
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("Sample retrieval from the local desk archive.");
  const [result, setResult] = useState(() => mockAuditSearch("Payment update with Rahul"));

  const search = useCallback(async (query) => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;

    setLoading(true);
    try {
      const data = await searchContactAudit(trimmed);
      const normalized = normalizeAudit(data, trimmed);
      if (!normalized.summary && normalized.chunks.length === 0) {
        throw new Error("empty audit");
      }
      setResult(normalized);
      setNotice("");
    } catch {
      setResult(mockAuditSearch(trimmed));
      setNotice("Live retrieval is unavailable, so this timeline is a local sample matched to your query.");
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, notice, result, search };
}
