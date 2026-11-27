import type {
  AssetDetail,
  AssetFilter,
  AssetListItem,
  LoraMatrixRow,
  SidebarFacets,
  SnippetItem,
  TagItem,
  WorkflowFileItem,
} from "./types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  getFacets: () => req<SidebarFacets>("/api/facets"),

  listAssets: (filter: AssetFilter, limit = 300, offset = 0) => {
    const p = new URLSearchParams();
    if (filter.folder !== "__ALL__") p.set("folder", filter.folder);
    if (filter.folderExact) p.set("folder_exact", "1");
    if (filter.mediaType) p.set("media_type", filter.mediaType);
    if (filter.search.trim()) p.set("search", filter.search.trim());
    if (filter.lora) p.set("lora", filter.lora);
    if (filter.modelFamily) p.set("model_family", filter.modelFamily);
    if (filter.baseModel) p.set("base_model", filter.baseModel);
    if (filter.workflowHash) p.set("workflow_hash", filter.workflowHash);
    if (filter.recipeHash) p.set("recipe_hash", filter.recipeHash);
    if (filter.tagId !== null) p.set("tag_id", String(filter.tagId));
    if (filter.minRating > 0) p.set("min_rating", String(filter.minRating));
    if (filter.flag) p.set("flag", filter.flag);
    if (filter.comfyVersion) p.set("comfy_version", filter.comfyVersion);
    if (filter.showDeleted) p.set("show_deleted", "1");
    if (filter.showHidden) p.set("show_hidden", "1");
    if (filter.collapseRecipes) p.set("collapse_recipes", "1");
    p.set("sort", filter.sort);
    p.set("limit", String(limit));
    p.set("offset", String(offset));
    return req<{ total: number; items: AssetListItem[]; limit: number; offset: number }>(`/api/assets?${p.toString()}`);
  },

  getAssetDetail: (id: number) => req<AssetDetail>(`/api/assets/${id}`),

  patchAsset: (id: number, patch: { rating?: number; flag?: string; notes?: string; is_deleted?: boolean; is_hidden?: number | boolean }) =>
    req<AssetDetail>(`/api/assets/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  batchTrash: (ids: number[], is_deleted = true) =>
    req<{ ok: boolean }>("/api/assets/batch-trash", { method: "POST", body: JSON.stringify({ ids, is_deleted }) }),

  purgeAssets: (ids: number[], delete_disk = true) =>
    req<{ ok: boolean; purged: number; deleted_files: number }>("/api/assets/purge", {
      method: "POST",
      body: JSON.stringify({ ids, delete_disk }),
    }),

  attachTag: (assetId: number, payload: { tag_id?: number; name?: string; color?: string }) =>
    req<{ ok: boolean; tag?: TagItem }>(`/api/assets/${assetId}/tags`, { method: "POST", body: JSON.stringify(payload) }),

  detachTag: (assetId: number, tagId: number) =>
    req<{ ok: boolean }>(`/api/assets/${assetId}/tags/${tagId}`, { method: "DELETE" }),

  saveRecipeNote: (recipeHash: string, title: string, notes: string) =>
    req<{ ok: boolean }>(`/api/recipes/${recipeHash}/note`, {
      method: "PUT",
      body: JSON.stringify({ title, notes }),
    }),

  rerollAsset: (assetId: number, batchCount = 1) =>
    req<{ ok: boolean; prompt_ids: string[] }>(`/api/assets/${assetId}/reroll`, {
      method: "POST",
      body: JSON.stringify({ batch_count: batchCount }),
    }),

  getRemixContext: (assetId: number) =>
    req<{
      prompt_json: Record<string, any>;
      ui_titles: Record<string, string>;
      field_options: Record<string, Record<string, any[]>>;
    }>(`/api/assets/${assetId}/remix-context`),

  remixAsset: (
    assetId: number,
    payload: {
      prompt_json?: Record<string, any>;
      prompt_edits?: Array<{ node_id: string; input_key: string; text: string }>;
      lora_edits?: Array<Record<string, unknown>>;
      param_edits?: Record<string, unknown>;
      randomize_seed: boolean;
      batch_count: number;
    }
  ) => req<{ ok: boolean; prompt_ids: string[] }>(`/api/assets/${assetId}/remix`, { method: "POST", body: JSON.stringify(payload) }),

  saveAssetPrompt: (assetId: number, prompt_json: Record<string, any>) =>
    req<{ ok: boolean }>(`/api/assets/${assetId}/save-prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt_json }),
    }),

  saveRemixAsWorkflow: (assetId: number, name: string, prompt_json: Record<string, any>) =>
    req<{ ok: boolean; path: string; filename: string }>(`/api/assets/${assetId}/save-as-workflow`, {
      method: "POST",
      body: JSON.stringify({ name, prompt_json }),
    }),

  revealInExplorer: (assetId: number) => req<{ ok: boolean }>(`/api/assets/${assetId}/reveal`, { method: "POST" }),

  transformAsset: (assetId: number, rotate_cw: number, flip_h: boolean) =>
    req<{
      ok: boolean;
      unchanged?: boolean;
      id?: number;
      width?: number;
      height?: number;
      file_size?: number;
      thumb_url?: string;
      media_url?: string;
    }>(`/api/assets/${assetId}/transform`, {
      method: "POST",
      body: JSON.stringify({ rotate_cw, flip_h }),
    }),

  triggerScan: (force = false) =>
    req<{ started: boolean }>("/api/scan", { method: "POST", body: JSON.stringify({ force }) }),

  interruptComfy: () => req<{ ok: boolean }>("/api/comfy/interrupt", { method: "POST" }),
  controlComfy: (action: "start" | "stop" | "restart") =>
    req<{ ok: boolean; message: string }>("/api/comfy/control", {
      method: "POST",
      body: JSON.stringify({ action }),
    }),

  revealFolder: (folder: string) =>
    req<{ ok: boolean }>("/api/folders/reveal", { method: "POST", body: JSON.stringify({ folder }) }),
  renameFolder: (folder: string, new_name: string) =>
    req<{ ok: boolean; new_folder: string; updated: number }>("/api/folders/rename", {
      method: "POST",
      body: JSON.stringify({ folder, new_name }),
    }),
  deleteFolder: (folder: string) =>
    req<{ ok: boolean; removed: number }>("/api/folders/delete", {
      method: "POST",
      body: JSON.stringify({ folder }),
    }),

  getSettings: () => req<{ workflow_dirs: string[]; output_dirs: string[] }>("/api/settings"),
  saveSettings: (payload: { workflow_dirs?: string[]; output_dirs?: string[] }) =>
    req<{ ok: boolean; workflow_dirs: string[]; output_dirs: string[]; output_rescan_triggered?: boolean }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  listWorkflowFiles: () => req<{ workflow_dirs: string[]; items: WorkflowFileItem[] }>("/api/workflows/files"),
  uploadWorkflowIcon: async (path: string, file: File) => {
    const fd = new FormData();
    fd.append("path", path);
    fd.append("image", file);
    const res = await fetch("/api/workflows/icon", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data as { ok: boolean; icon_url: string };
  },
  deleteWorkflowIcon: (path: string) =>
    req<{ ok: boolean }>("/api/workflows/icon", {
      method: "DELETE",
      body: JSON.stringify({ path }),
    }),
  loadWorkflowFile: (path: string) =>
    req<{
      name: string;
      path: string;
      format: "ui" | "api";
      prompt_json: Record<string, any>;
      workflow_json: any;
      ui_titles: Record<string, string>;
      field_options: Record<string, Record<string, any[]>>;
    }>("/api/workflows/load-file", { method: "POST", body: JSON.stringify({ path }) }),
  saveWorkflowFile: (path: string, prompt_json: Record<string, any>) =>
    req<{ ok: boolean; updated_nodes: number; mtime: number }>("/api/workflows/save-file", {
      method: "POST",
      body: JSON.stringify({ path, prompt_json }),
    }),
  runWorkflow: (payload: {
    prompt_json: Record<string, any>;
    workflow_json?: any;
    randomize_seed: boolean;
    batch_count: number;
    reference_image?: string;
  }) => req<{ ok: boolean; prompt_ids: string[] }>("/api/workflows/run", { method: "POST", body: JSON.stringify(payload) }),

  uploadComfyImage: async (file: File) => {
    const fd = new FormData();
    fd.append("image", file);
    const res = await fetch("/api/comfy/upload-image", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data as { name: string; subfolder?: string; type?: string };
  },

  listComfyLoras: () =>
    req<{ items: string[]; ranges: Record<string, { min: number; max: number; source?: string }> }>("/api/comfy/loras"),

  getLoraMatrix: () => req<{ items: LoraMatrixRow[] }>("/api/loras/matrix"),

  listSnippets: () => req<{ items: SnippetItem[] }>("/api/snippets"),
  createSnippet: (payload: { title: string; category: string; content: string; notes?: string }) =>
    req<SnippetItem>("/api/snippets", { method: "POST", body: JSON.stringify(payload) }),
  updateSnippet: (id: number, payload: { title: string; category: string; content: string; notes?: string }) =>
    req<SnippetItem>(`/api/snippets/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteSnippet: (id: number) => req<{ ok: boolean }>(`/api/snippets/${id}`, { method: "DELETE" }),

  getPromptConverterStatus: () =>
    req<{
      playwright_installed: boolean;
      browser_channel: string | null;
      profile_dir: string;
      profile_initialized: boolean;
      local_qwenvl_available?: boolean;
      busy: boolean;
      login_open?: boolean;
      stage?: string;
      step?: number;
      total_steps?: number;
      message_zh?: string;
      message_en?: string;
      started_at?: number;
    }>("/api/prompt-converter/status"),

  openPromptConverterLogin: (provider: "gemini" | "chatgpt") =>
    req<{ ok: boolean; message?: string; error?: string }>("/api/prompt-converter/login", {
      method: "POST",
      body: JSON.stringify({ provider }),
    }),

  resetPromptConverterBrowser: () =>
    req<{ ok: boolean; busy?: boolean; message?: string }>("/api/prompt-converter/reset", {
      method: "POST",
    }),

  inspectWorkflowPrompt: (path: string) =>
    req<{
      workflow_path: string;
      workflow_name: string;
      model_family: string;
      prompt_nodes: Array<{
        node_id: string;
        node_title: string;
        class_type: string;
        input_key: string;
        role: string;
        text: string;
        has_divider: boolean;
        fixed_prefix: string;
        editable_suffix: string;
      }>;
      primary_node: {
        node_id: string;
        node_title: string;
        class_type: string;
        input_key: string;
        role: string;
        text: string;
        has_divider: boolean;
        fixed_prefix: string;
        editable_suffix: string;
      } | null;
    }>("/api/prompt-converter/inspect-workflow", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  convertPromptWithWebLLM: async (payload: {
    source_text: string;
    provider: "gemini" | "chatgpt" | "local_qwenvl";
    workflow_path: string;
    target_node_id?: string;
    target_input_key?: string;
    model_family?: string;
    media_type?: "image" | "video";
    has_divider?: boolean;
    lang_pref?: "auto" | "en" | "zh";
    show_window?: boolean;
    image?: File | null;
  }) => {
    type ConvertRes = {
      ok: boolean;
      provider: string;
      model_family: string;
      has_divider: boolean;
      fixed_prefix: string;
      converted_part: string;
      final_prompt: string;
      workflow_path: string;
      target_node_id: string;
      target_input_key: string;
      reference_image?: string | null;
      reference_image_url?: string | null;
    };
    if (payload.image) {
      const fd = new FormData();
      fd.append("source_text", payload.source_text || "");
      fd.append("provider", payload.provider);
      fd.append("workflow_path", payload.workflow_path);
      if (payload.target_node_id) fd.append("target_node_id", payload.target_node_id);
      if (payload.target_input_key) fd.append("target_input_key", payload.target_input_key);
      if (payload.model_family) fd.append("model_family", payload.model_family);
      if (payload.media_type) fd.append("media_type", payload.media_type);
      if (payload.has_divider !== undefined) fd.append("has_divider", payload.has_divider ? "true" : "false");
      if (payload.lang_pref) fd.append("lang_pref", payload.lang_pref);
      fd.append("show_window", payload.show_window ? "true" : "false");
      fd.append("image", payload.image);
      const res = await fetch("/api/prompt-converter/convert", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data as ConvertRes;
    }
    const { image: _unused, ...jsonPayload } = payload;
    return req<ConvertRes>("/api/prompt-converter/convert", {
      method: "POST",
      body: JSON.stringify(jsonPayload),
    });
  },
};

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function formatTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
