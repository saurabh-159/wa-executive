"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAuthStatus, fetchTasks, updateTaskStatus } from "@/lib/api";
import { MOCK_TASKS } from "@/lib/mockData";

function normalizeTask(task) {
  return {
    ...task,
    task_heading: task.task_heading || "Untitled commitment",
    category: task.category || "I_OWE_THEM",
    counterparty_name: task.counterparty_name || "Unknown",
    context_their_message: task.context_their_message || "",
    context_your_reply: task.context_your_reply || "",
    full_thread_summary: task.full_thread_summary || "",
    due_date_time: task.due_date_time || "",
    priority: String(task.priority || "MEDIUM").toUpperCase(),
    status: task.status || "PENDING",
    sender_jid: task.sender_jid || "",
  };
}

export function useTasks() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [usingMock, setUsingMock] = useState(false);
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [qrImage, setQrImage] = useState(null);
  const usingMockRef = useRef(false);
  const dismissedRef = useRef(new Set());

  const applyMock = useCallback(() => {
    usingMockRef.current = true;
    setUsingMock(true);
    setTasks(
      MOCK_TASKS.filter((task) => !dismissedRef.current.has(task.id)).map(normalizeTask)
    );
  }, []);

  const loadLinkState = useCallback(async () => {
    try {
      const auth = await fetchAuthStatus();
      const connected = Boolean(
        auth?.connected ||
          auth?.status === "ready" ||
          auth?.status === "syncing" ||
          auth?.status === "connected"
      );
      setConnected(connected);
      setQrImage(connected ? null : auth?.qr_image || null);
      setSyncing(Boolean(auth?.isSyncing || auth?.status === "syncing"));
    } catch {
      setConnected(false);
      setQrImage(null);
      setSyncing(false);
    }
  }, []);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      try {
        const data = await fetchTasks("PENDING");
        const list = Array.isArray(data) ? data.map(normalizeTask) : [];
        usingMockRef.current = false;
        setUsingMock(false);
        setTasks(list);
      } catch {
        if (!silent || usingMockRef.current) applyMock();
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
      await loadLinkState();
    },
    [applyMock, loadLinkState]
  );

  useEffect(() => {
    load();
    const timer = setInterval(() => load({ silent: true }), 12000);
    const onLogout = () => {
      dismissedRef.current = new Set();
      usingMockRef.current = false;
      setUsingMock(false);
      setTasks([]);
      setConnected(false);
      setQrImage(null);
      setSyncing(false);
    };
    window.addEventListener("wa-logout", onLogout);
    return () => {
      clearInterval(timer);
      window.removeEventListener("wa-logout", onLogout);
    };
  }, [load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    return load();
  }, [load]);

  const markDone = useCallback(async (taskId) => {
    if (!usingMockRef.current) {
      await updateTaskStatus(taskId, "COMPLETED");
    }
    dismissedRef.current.add(taskId);
    setTasks((current) => current.filter((task) => task.id !== taskId));
  }, []);

  return {
    tasks,
    loading,
    refreshing,
    usingMock,
    connected,
    syncing,
    qrImage,
    refresh,
    markDone,
  };
}
