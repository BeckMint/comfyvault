import React, { useEffect, useState } from "react";
import { FolderPlus, Image, Languages, Moon, RefreshCw, Save, Settings, Sun, Trash2, Type, Workflow, X } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";

interface Props {
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}

const FONT_OPTIONS = [
  { id: "sm", zh: "紧凑", en: "Compact", desc: "14px" },
  { id: "md", zh: "标准", en: "Normal", desc: "16px" },
  { id: "lg", zh: "大号", en: "Large", desc: "18px" },
  { id: "xl", zh: "超大", en: "XL", desc: "20px" },
];

export const SettingsModal: React.FC<Props> = ({ onClose, onSaved, onError }) => {
  const { lang, setLang, t } = useI18n();
  const [outputDirs, setOutputDirs] = useState<string[]>([]);
  const [newOutputDir, setNewOutputDir] = useState("");
  const [dirs, setDirs] = useState<string[]>([]);
  const [newDir, setNewDir] = useState("");
  const [scannedCount, setScannedCount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);

  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("comfyvault_theme") === "light" ? "light" : "dark")
  );
  const [fontSize, setFontSize] = useState<string>(
    () => localStorage.getItem("comfyvault_font_size") || "md"
  );

  useEffect(() => {
    api
      .getSettings()
      .then((res) => {
        setDirs(res.workflow_dirs || []);
        setOutputDirs(res.output_dirs || []);
      })
      .catch((e) => onError(e.message));
  }, []);

  const applyTheme = (next: "dark" | "light") => {
    setTheme(next);
    localStorage.setItem("comfyvault_theme", next);
    if (next === "light") {
      document.documentElement.classList.add("theme-light");
      document.documentElement.classList.remove("dark");
    } else {
      document.documentElement.classList.remove("theme-light");
      document.documentElement.classList.add("dark");
    }
  };

  const applyFontSize = (next: string) => {
    setFontSize(next);
    localStorage.setItem("comfyvault_font_size", next);
    document.documentElement.setAttribute("data-font-size", next);
  };

  const addOutputDir = () => {
    const cleaned = newOutputDir.trim();
    if (!cleaned) return;
    if (!outputDirs.includes(cleaned)) {
      setOutputDirs((prev) => [...prev, cleaned]);
    }
    setNewOutputDir("");
  };

  const removeOutputDir = (idx: number) => {
    if (outputDirs.length <= 1) {
      onError(t("至少需要保留一个相册/Output 目录", "At least one Output/Gallery directory is required"));
      return;
    }
    setOutputDirs((prev) => prev.filter((_, i) => i !== idx));
  };

  const addDir = () => {
    const cleaned = newDir.trim();
    if (!cleaned) return;
    if (!dirs.includes(cleaned)) {
      setDirs((prev) => [...prev, cleaned]);
    }
    setNewDir("");
  };

  const removeDir = (idx: number) => {
    setDirs((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSaveAndScan = async () => {
    setSaving(true);
    try {
      const finalOut =
        newOutputDir.trim() && !outputDirs.includes(newOutputDir.trim())
          ? [...outputDirs, newOutputDir.trim()]
          : outputDirs;
      const finalWf = newDir.trim() && !dirs.includes(newDir.trim()) ? [...dirs, newDir.trim()] : dirs;
      const saved = await api.saveSettings({ workflow_dirs: finalWf, output_dirs: finalOut });
      setOutputDirs(saved.output_dirs || finalOut);
      setDirs(saved.workflow_dirs || finalWf);
      setNewOutputDir("");
      setNewDir("");
      setScanning(true);
      const res = await api.listWorkflowFiles();
      setScannedCount(res.items.length);
      onSaved(
        saved.output_rescan_triggered
          ? t(
              `配置已保存，已触发相册目录增量扫描，并发现 ${res.items.length} 个工作流`,
              `Settings saved. Gallery scan triggered & found ${res.items.length} workflows`
            )
          : t(
              `配置已保存，共扫描到 ${res.items.length} 个工作流文件`,
              `Settings saved. Found ${res.items.length} workflow files`
            )
      );
    } catch (e: any) {
      onError(t(`保存失败: ${e.message}`, `Save failed: ${e.message}`));
    } finally {
      setSaving(false);
      setScanning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/75 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-[#121622] border border-zinc-700/90 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-indigo-400" />
            <h2 className="text-sm font-semibold text-white">
              {t("系统外观、相册与工作流配置", "Appearance, Gallery & Workflow Settings")}
            </h2>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[78vh] overflow-y-auto">
          {/* Appearance: Language + Theme + Global Font Size */}
          <div className="p-4 rounded-xl bg-[#0c0f17] border border-zinc-800 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                  <Languages className="w-3.5 h-3.5 text-sky-400" />
                  {t("界面语言", "Interface Language")}
                </div>
                <div className="text-[11px] text-zinc-500">
                  {t("支持简体中文与英文实时切换（顶部导航栏也可一键切换）", "Switch between Chinese and English anytime (also in top bar)")}
                </div>
              </div>
              <div className="flex items-center bg-[#141824] p-1 rounded-lg border border-zinc-800 shrink-0">
                <button
                  type="button"
                  onClick={() => setLang("zh")}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    lang === "zh" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  简体中文
                </button>
                <button
                  type="button"
                  onClick={() => setLang("en")}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    lang === "en" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  English
                </button>
              </div>
            </div>

            <div className="pt-3 border-t border-zinc-800 flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-semibold text-zinc-200">{t("界面主题", "Theme")}</div>
                <div className="text-[11px] text-zinc-500">
                  {t("支持深色暗房模式与清爽浅色模式（看图器保持深色背景）", "Darkroom and light themes (lightbox stays dark)")}
                </div>
              </div>
              <div className="flex items-center bg-[#141824] p-1 rounded-lg border border-zinc-800 shrink-0">
                <button
                  type="button"
                  onClick={() => applyTheme("dark")}
                  className={`px-3 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors ${
                    theme === "dark" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <Moon className="w-3.5 h-3.5" />
                  {t("深色", "Dark")}
                </button>
                <button
                  type="button"
                  onClick={() => applyTheme("light")}
                  className={`px-3 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors ${
                    theme === "light" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <Sun className="w-3.5 h-3.5" />
                  {t("浅色", "Light")}
                </button>
              </div>
            </div>

            <div className="pt-3 border-t border-zinc-800 flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                  <Type className="w-3.5 h-3.5 text-sky-400" />
                  {t("全局文字大小", "Font Scale")}
                </div>
                <div className="text-[11px] text-zinc-500">
                  {t("实时等比缩放全局界面字号与提示词阅读大小", "Scale global UI & prompt typography")}
                </div>
              </div>
              <div className="flex items-center bg-[#141824] p-1 rounded-lg border border-zinc-800 shrink-0">
                {FONT_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => applyFontSize(opt.id)}
                    title={opt.desc}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      fontSize === opt.id ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {lang === "zh" ? opt.zh : opt.en}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Multi-Output / Gallery Directories */}
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                <Image className="w-3.5 h-3.5 text-emerald-400" />
                {t("相册 / Output 扫描目录（支持多个本地目录）", "Output / Gallery Directories (Multiple folders supported)")}
              </div>
              <p className="text-[11px] text-zinc-400">
                {t(
                  "默认包含 ComfyUI/output；你也可以额外添加其他历史归档相册或外部输出目录，保存后会自动增量索引并实时监听新图。",
                  "Includes ComfyUI/output by default. Add extra archive or gallery folders — saved folders are incrementally indexed and watched live."
                )}
              </p>
            </div>

            <div className="space-y-2 max-h-40 overflow-y-auto">
              {outputDirs.map((d, idx) => (
                <div
                  key={`${d}-${idx}`}
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[#0c0f17] border border-zinc-800 text-xs"
                >
                  <span className="font-mono text-zinc-200 truncate" title={d}>
                    {d}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeOutputDir(idx)}
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-rose-400 shrink-0"
                    title={t("移除该相册目录", "Remove gallery directory")}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={newOutputDir}
                onChange={(e) => setNewOutputDir(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addOutputDir();
                  }
                }}
                placeholder={t("例如：E:\\AI_Albums 或 D:\\ComfyUI_outputs", "e.g. E:\\AI_Albums or D:\\ComfyUI_outputs")}
                className="flex-1 h-9 px-3 rounded-lg bg-[#0b0e16] border border-zinc-700 focus:border-indigo-500 focus:outline-none text-xs font-mono text-zinc-100"
              />
              <button
                type="button"
                onClick={addOutputDir}
                className="h-9 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-200 flex items-center gap-1.5 shrink-0"
              >
                <FolderPlus className="w-3.5 h-3.5 text-emerald-400" />
                {t("添加相册", "Add Folder")}
              </button>
            </div>
          </div>

          {/* Workflow Directories */}
          <div className="space-y-3 pt-2 border-t border-zinc-800/80">
            <div className="space-y-1">
              <div className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                <Workflow className="w-3.5 h-3.5 text-amber-400" />
                {t("工作流扫描目录（支持多个本地目录）", "Workflow Directories (Multiple folders supported)")}
              </div>
              <p className="text-[11px] text-zinc-400">
                {t(
                  "配置存放 ComfyUI 工作流 .json 的文件夹路径（递归扫描子目录，兼容 UI 格式与 API 格式）。",
                  "Folders containing ComfyUI .json workflow files (recursively scanned, supports both UI and API formats)."
                )}
              </p>
            </div>

            <div className="space-y-2 max-h-40 overflow-y-auto">
              {dirs.length === 0 ? (
                <div className="p-3 rounded-xl bg-[#0c0f17] border border-zinc-800 text-xs text-zinc-500">
                  {t("暂未配置工作流目录，请在下方输入路径添加", "No workflow directories configured yet")}
                </div>
              ) : (
                dirs.map((d, idx) => (
                  <div
                    key={`${d}-${idx}`}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[#0c0f17] border border-zinc-800 text-xs"
                  >
                    <span className="font-mono text-zinc-200 truncate" title={d}>
                      {d}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeDir(idx)}
                      className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-rose-400 shrink-0"
                      title={t("移除该目录", "Remove directory")}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={newDir}
                onChange={(e) => setNewDir(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addDir();
                  }
                }}
                placeholder={t("例如：D:\\ComfyUI_files\\workflows", "e.g. D:\\ComfyUI_files\\workflows")}
                className="flex-1 h-9 px-3 rounded-lg bg-[#0b0e16] border border-zinc-700 focus:border-indigo-500 focus:outline-none text-xs font-mono text-zinc-100"
              />
              <button
                type="button"
                onClick={addDir}
                className="h-9 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-200 flex items-center gap-1.5 shrink-0"
              >
                <FolderPlus className="w-3.5 h-3.5 text-amber-400" />
                {t("添加目录", "Add Folder")}
              </button>
            </div>

            {scannedCount !== null && (
              <div className="px-3 py-2 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-xs text-emerald-300">
                {t("扫描完成：共发现", "Scan complete: found")}{" "}
                <span className="font-mono font-bold">{scannedCount}</span>{" "}
                {t("个可用工作流文件。", "workflow files.")}
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 bg-[#0d1018] flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200"
          >
            {t("关闭", "Close")}
          </button>
          <button
            type="button"
            disabled={saving || scanning}
            onClick={handleSaveAndScan}
            className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white flex items-center gap-1.5"
          >
            {scanning ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {t("保存并扫描", "Save & Scan")}
          </button>
        </div>
      </div>
    </div>
  );
};
