import React, { useEffect, useState } from "react";
import { Loader2, Square } from "lucide-react";
import { useI18n } from "../i18n";
import type { ComfyStatus } from "../types";

interface Props {
  status: ComfyStatus;
  onInterrupt: () => void;
}

export const LiveProgressBar: React.FC<Props> = ({ status, onInterrupt }) => {
  const { t } = useI18n();
  const isBusy =
    status.online &&
    (Boolean(status.executing_prompt_id) || Boolean(status.executing_node) || status.queue_remaining > 0);

  const [elapsed, setElapsed] = useState(0);

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

  if (!isBusy) return null;

  const hasSteps = status.progress_max > 0;
  const pct = hasSteps ? Math.min(100, Math.round((status.progress_value / status.progress_max) * 100)) : 0;

  return (
    <div className="shrink-0 bg-[#121728] border-b border-indigo-500/40 px-4 py-2 flex items-center gap-4 select-none">
      <div className="flex items-center gap-2 shrink-0">
        <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
        <span className="text-xs font-semibold text-indigo-200">{t("ComfyUI 正在生成", "ComfyUI Generating")}</span>
      </div>

      <div className="text-xs text-zinc-200 truncate max-w-[280px]" title={status.executing_node_title || ""}>
        {status.executing_node_title || (status.executing_node ? `${t("节点", "Node")} #${status.executing_node}` : t("排队等待执行...", "Queued..."))}
      </div>

      {/* Progress Track */}
      <div className="flex-1 h-2 rounded-full bg-zinc-800/90 overflow-hidden relative min-w-[120px]">
        {hasSteps ? (
          <div
            className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-emerald-400 transition-all duration-200 rounded-full"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-indigo-400 to-transparent animate-[pulse_1.2s_ease-in-out_infinite] rounded-full mx-auto" />
        )}
      </div>

      <div className="flex items-center gap-3 text-[11px] font-mono text-zinc-300 shrink-0">
        {hasSteps ? (
          <span className="text-indigo-300 font-semibold">
            {status.progress_value}/{status.progress_max} ({pct}%)
          </span>
        ) : (
          <span className="text-zinc-400">{t("处理中...", "Processing...")}</span>
        )}
        {elapsed > 0 && <span className="text-zinc-400">{elapsed}s</span>}
        {status.queue_remaining > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-200 border border-indigo-500/30">
            {t("队列", "Queue")} {status.queue_remaining}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={onInterrupt}
        title={t("立即中断 ComfyUI 当前生成任务", "Interrupt current ComfyUI execution")}
        className="px-2.5 py-1 rounded-md bg-rose-600/25 hover:bg-rose-600/50 border border-rose-500/40 text-rose-200 text-[11px] font-medium flex items-center gap-1 shrink-0 transition-colors"
      >
        <Square className="w-3 h-3 fill-current" />
        {t("中断", "Stop")}
      </button>
    </div>
  );
};
