import React, { useEffect, useState } from "react";
import { AlertTriangle, Cpu, Loader2, Square, X } from "lucide-react";
import { useI18n } from "../i18n";
import type { ComfyStatus } from "../types";

interface Props {
  status: ComfyStatus;
  onInterrupt: () => void | Promise<void>;
}

export const LiveProgressBar: React.FC<Props> = ({ status, onInterrupt }) => {
  const { t } = useI18n();
  const isBusy =
    status.online &&
    (Boolean(status.executing_prompt_id) || Boolean(status.executing_node) || status.queue_remaining > 0);

  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmStop) return;
    const tid = window.setTimeout(() => setConfirmStop(false), 3200);
    return () => window.clearTimeout(tid);
  }, [confirmStop]);

  useEffect(() => {
    if (!isBusy || !status.started_at) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, Math.floor(Date.now() / 1000 - (status.started_at || 0))));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isBusy, status.started_at]);

  useEffect(() => {
    // Reset dismissed & confirm state when a new prompt starts or execution stops
    if (!isBusy) {
      setDismissedKey(null);
      setStopping(false);
      setConfirmStop(false);
    }
  }, [isBusy, status.executing_prompt_id]);

  if (!isBusy) return null;

  const hasSteps = status.progress_max > 0;
  const pct = hasSteps ? Math.min(100, Math.round((status.progress_value / status.progress_max) * 100)) : 0;
  const res = status.resources;
  const alert = status.alert;
  const alertKey = alert ? `${status.executing_prompt_id || "active"}::${alert.level}::${alert.code}` : null;
  const showAlert = Boolean(alert && alertKey && dismissedKey !== alertKey);

  const handleStop = async () => {
    setStopping(true);
    try {
      await onInterrupt();
    } finally {
      setStopping(false);
    }
  };

  const ramPct = res?.ram_pct ?? null;
  const vramPct = res?.vram_pct ?? null;

  return (
    <div className="shrink-0 flex flex-col select-none">
      {/* Highlighted Anomaly Alert Row (directly ABOVE the progress bar) */}
      {showAlert && alert && (
        <div
          className={`px-4 py-2 border-b flex flex-wrap items-center justify-between gap-3 text-xs ${
            alert.level === "danger"
              ? "bg-rose-950/95 border-rose-500/75 text-rose-100 shadow-[inset_0_0_24px_rgba(244,63,94,0.22)]"
              : "bg-amber-950/95 border-amber-500/70 text-amber-100 shadow-[inset_0_0_24px_rgba(245,158,11,0.18)]"
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <AlertTriangle
              className={`w-4 h-4 shrink-0 ${
                alert.level === "danger" ? "text-rose-400 animate-pulse" : "text-amber-400"
              }`}
            />
            <span
              className={`px-1.5 py-0.5 rounded text-[11px] font-bold shrink-0 ${
                alert.level === "danger"
                  ? "bg-rose-500 text-white"
                  : "bg-amber-500 text-black"
              }`}
            >
              {alert.level === "danger"
                ? t(`异常告警 · ${alert.title_zh}`, `CRITICAL · ${alert.title_en}`)
                : t(`资源预警 · ${alert.title_zh}`, `WARNING · ${alert.title_en}`)}
            </span>
            <span className="truncate font-medium" title={t(alert.message_zh, alert.message_en)}>
              {t(alert.message_zh, alert.message_en)}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={stopping}
              onClick={handleStop}
              className={`px-3 py-1 rounded-md text-[11px] font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-50 ${
                alert.level === "danger"
                  ? "bg-rose-600 hover:bg-rose-500 text-white shadow"
                  : "bg-amber-500 hover:bg-amber-400 text-black"
              }`}
            >
              <Square className="w-3 h-3 fill-current" />
              {stopping
                ? t("正在终止...", "Stopping...")
                : t("终止当前任务", "Abort Task")}
            </button>
            <button
              type="button"
              onClick={() => setDismissedKey(alertKey)}
              className="px-2 py-1 rounded-md bg-black/35 hover:bg-black/55 border border-white/15 text-[11px] text-zinc-200 flex items-center gap-1"
              title={t("暂时忽略此告警，继续运行观察", "Dismiss this warning and keep running")}
            >
              {t("继续观察", "Keep Running")}
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {/* Main Progress Bar Row */}
      <div className="bg-[#121728] border-b border-indigo-500/40 px-4 py-2 flex items-center gap-3.5">
        <div className="flex items-center gap-2 shrink-0">
          <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
          <span className="text-xs font-semibold text-indigo-200">{t("ComfyUI 正在生成", "ComfyUI Generating")}</span>
        </div>

        {/* Left-placed Stop button with 3s two-step confirmation (far away from top-right Create button) */}
        <button
          type="button"
          disabled={stopping}
          onClick={() => {
            if (!confirmStop) {
              setConfirmStop(true);
              return;
            }
            setConfirmStop(false);
            handleStop();
          }}
          title={
            confirmStop
              ? t("再次点击确认中断当前生成任务（3秒后自动取消）", "Click again to confirm stopping current task")
              : t("中断当前 ComfyUI 生成任务（需二次点击防误触）", "Stop current ComfyUI task (click twice to confirm)")
          }
          className={`px-2.5 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 shrink-0 transition-all disabled:opacity-50 ${
            confirmStop
              ? "bg-rose-600 hover:bg-rose-500 border border-rose-400 text-white shadow-sm animate-pulse"
              : "bg-rose-600/20 hover:bg-rose-600/35 border border-rose-500/40 text-rose-200"
          }`}
        >
          <Square className="w-3 h-3 fill-current" />
          {stopping
            ? t("中断中...", "Stopping...")
            : confirmStop
            ? t("确认中断?", "Confirm Stop?")
            : t("中断", "Stop")}
        </button>

        <div className="text-xs text-zinc-200 truncate max-w-[240px]" title={status.executing_node_title || ""}>
          {status.executing_node_title ||
            (status.executing_node ? `${t("节点", "Node")} #${status.executing_node}` : t("排队等待执行...", "Queued..."))}
        </div>

        {/* Progress Track */}
        <div className="flex-1 h-2 rounded-full bg-zinc-800/90 overflow-hidden relative min-w-[100px]">
          {hasSteps ? (
            <div
              className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-emerald-400 transition-all duration-200 rounded-full"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-indigo-400 to-transparent animate-[pulse_1.2s_ease-in-out_infinite] rounded-full mx-auto" />
          )}
        </div>

        {/* Right side: read-only telemetry only (safe underneath top-right Create button) */}
        <div className="flex items-center gap-2.5 text-[11px] font-mono text-zinc-300 shrink-0">
          {hasSteps ? (
            <span className="text-indigo-300 font-semibold">
              {status.progress_value}/{status.progress_max} ({pct}%)
            </span>
          ) : (
            <span className="text-zinc-400">{t("处理中...", "Processing...")}</span>
          )}
          {elapsed > 0 && <span className="text-zinc-400">{elapsed}s</span>}

          {/* Live VRAM & RAM pills */}
          {(vramPct !== null || ramPct !== null) && (
            <span className="hidden md:inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-zinc-900/90 border border-zinc-700/80 text-[10px]">
              <Cpu className="w-3 h-3 text-zinc-400" />
              {vramPct !== null && (
                <span
                  title={
                    res?.vram_total_gb
                      ? `VRAM: ${res.vram_used_gb} / ${res.vram_total_gb} GB`
                      : `VRAM: ${vramPct}%`
                  }
                  className={
                    vramPct >= 96
                      ? "text-rose-400 font-bold"
                      : vramPct >= 90
                      ? "text-amber-300 font-semibold"
                      : "text-zinc-300"
                  }
                >
                  VRAM {vramPct}%
                </span>
              )}
              {vramPct !== null && ramPct !== null && <span className="text-zinc-600">·</span>}
              {ramPct !== null && (
                <span
                  title={
                    res?.ram_total_gb
                      ? `RAM: ${res.ram_used_gb} / ${res.ram_total_gb} GB (Free ${res.ram_free_gb} GB)`
                      : `RAM: ${ramPct}%`
                  }
                  className={
                    ramPct >= 92
                      ? "text-rose-400 font-bold"
                      : ramPct >= 85
                      ? "text-amber-300 font-semibold"
                      : "text-zinc-300"
                  }
                >
                  RAM {ramPct}%
                </span>
              )}
            </span>
          )}

          {status.queue_remaining > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-200 border border-indigo-500/30">
              {t("队列", "Queue")} {status.queue_remaining}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
