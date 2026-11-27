import React, { useEffect, useRef, useState } from "react";
import { Check, ClipboardPaste, FileCode2, ImagePlus, Trash2, Upload, X } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";

interface Props {
  workflowPath: string;
  workflowName: string;
  currentIconUrl?: string | null;
  onUpdated: (newIconUrl: string | null) => void;
  onClose: () => void;
  onToast?: (msg: string, tone?: "ok" | "err") => void;
}

export const WorkflowIconModal: React.FC<Props> = ({
  workflowPath,
  workflowName,
  currentIconUrl,
  onUpdated,
  onClose,
  onToast,
}) => {
  const { t } = useI18n();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(currentIconUrl || null);
  const [dragOver, setDragOver] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const pickImageFile = (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
      setError(t("请选择图片文件（PNG / JPG / WebP / GIF）", "Please select an image file (PNG / JPG / WebP / GIF)"));
      return;
    }
    setError(null);
    setSelectedFile(file);
    const url = URL.createObjectURL(file);
    setPreviewUrl((prev) => {
      if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
      return url;
    });
  };

  useEffect(() => {
    return () => {
      if (previewUrl && previewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  // Global Ctrl+V paste + Esc close while modal is open
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            pickImageFile(f);
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
    };
  }, [saving, onClose]);

  const handleSave = async () => {
    if (!selectedFile) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.uploadWorkflowIcon(workflowPath, selectedFile);
      onUpdated(res.icon_url);
      onToast?.(t("工作流图标已更新", "Workflow icon updated"), "ok");
      onClose();
    } catch (e: any) {
      setError(e?.message || t("保存图标失败", "Failed to save icon"));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.deleteWorkflowIcon(workflowPath);
      onUpdated(null);
      onToast?.(t("已恢复默认图标", "Restored default icon"), "ok");
      onClose();
    } catch (e: any) {
      setError(e?.message || t("恢复默认图标失败", "Failed to remove icon"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/65 flex items-center justify-center p-4"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-[#111521] border border-zinc-700/90 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 bg-[#161b2a] border-b border-zinc-800 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5">
              <ImagePlus className="w-4 h-4 text-indigo-400 shrink-0" />
              {t("自定义工作流图标", "Custom Workflow Icon")}
            </h3>
            <p className="text-[11px] text-zinc-400 truncate mt-0.5" title={workflowName}>
              {workflowName}
            </p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Preview + Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragOver(false);
              const f = e.dataTransfer?.files?.[0];
              if (f) pickImageFile(f);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`rounded-xl border-2 border-dashed p-5 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all ${
              dragOver
                ? "border-indigo-400 bg-indigo-500/15"
                : "border-zinc-700 hover:border-indigo-500/70 bg-[#0b0e16]"
            }`}
          >
            <div className="w-24 h-24 rounded-2xl overflow-hidden bg-[#151a28] border border-zinc-700/80 flex items-center justify-center shadow-lg">
              {previewUrl ? (
                <img src={previewUrl} alt="Icon Preview" className="w-full h-full object-cover" />
              ) : (
                <FileCode2 className="w-10 h-10 text-zinc-500" />
              )}
            </div>

            <div className="text-center space-y-1">
              <div className="text-xs font-medium text-zinc-200 flex items-center justify-center gap-1.5">
                <Upload className="w-3.5 h-3.5 text-indigo-400" />
                {t("拖拽图片到这里，或点击选择文件", "Drag & drop an image here, or click to upload")}
              </div>
              <div className="text-[11px] text-zinc-400 flex items-center justify-center gap-1">
                <ClipboardPaste className="w-3 h-3 text-amber-400" />
                {t("也支持直接按 Ctrl + V 粘贴剪贴板图片（自动居中裁剪为方形图标）", "Or press Ctrl + V to paste from clipboard (auto square-cropped)")}
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickImageFile(f);
                e.target.value = "";
              }}
            />
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-rose-950/50 border border-rose-500/40 text-xs text-rose-200">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between gap-2 pt-1">
            {currentIconUrl ? (
              <button
                type="button"
                disabled={saving}
                onClick={handleRemove}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-rose-900/50 border border-zinc-700 hover:border-rose-500/40 text-xs text-zinc-300 hover:text-rose-200 flex items-center gap-1.5 disabled:opacity-40"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {t("恢复默认", "Reset")}
              </button>
            ) : (
              <div />
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={onClose}
                className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 disabled:opacity-40"
              >
                {t("取消", "Cancel")}
              </button>
              <button
                type="button"
                disabled={!selectedFile || saving}
                onClick={handleSave}
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5"
              >
                <Check className="w-3.5 h-3.5" />
                {saving ? t("保存中...", "Saving...") : t("设为图标", "Set Icon")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
