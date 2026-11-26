export interface TagItem {
  id: number;
  name: string;
  color: string;
  count?: number;
}

export interface LoraShort {
  name: string;
  strength_model: number;
  enabled: boolean;
}

export interface AssetListItem {
  id: number;
  rel_path: string;
  folder: string;
  filename: string;
  media_type: "image" | "video";
  ext: string;
  file_size: number;
  created_at: number;
  width: number;
  height: number;
  duration: number | null;
  fps: number | null;
  thumb_url: string;
  media_url: string;
  comfy_version: string | null;
  workflow_hash: string | null;
  workflow_name: string | null;
  recipe_hash: string | null;
  recipe_count: number;
  base_model: string | null;
  primary_prompt: string;
  loras: LoraShort[];
  seed: number | null;
  steps: number | null;
  cfg: number | null;
  sampler: string | null;
  rating: number;
  flag: "" | "pick" | "reject";
  notes: string;
  parent_id: number | null;
  is_hidden?: number;
  reference_image?: string | null;
  reference_image_url?: string | null;
  tags: TagItem[];
}

export interface PromptNodeEntry {
  node_id: string;
  node_title: string;
  class_type: string;
  input_key: string;
  role: "positive" | "negative" | "system" | "upscale" | "prompt";
  text: string;
}

export interface ModelNodeEntry {
  node_id: string;
  node_title: string;
  class_type: string;
  input_key: string;
  category: string;
  name: string;
}

export interface LoraNodeEntry {
  node_id: string;
  node_title: string;
  class_type: string;
  mode: "standard" | "rgthree" | "stack";
  key_name: string;
  key_strength_model: string | null;
  key_strength_clip: string | null;
  name: string;
  strength_model: number;
  strength_clip: number;
  enabled: boolean;
}

export interface AssetSibling {
  id: number;
  filename: string;
  media_type: "image" | "video";
  seed: number | null;
  rating: number;
  flag: string;
  created_at: number;
  width: number;
  height: number;
  thumb_url: string;
}

export interface AssetDetail extends Omit<AssetListItem, "loras"> {
  gen_duration_sec: number | null;
  recipe_note: { title: string; notes: string };
  prompts: PromptNodeEntry[];
  models: ModelNodeEntry[];
  loras: LoraNodeEntry[];
  params: Record<string, string | number>;
  seed_targets: Array<{ node_id: string; node_title: string; class_type: string; input_key: string; value: number }>;
  param_targets: Record<string, { node_id: string; input_key: string }>;
  has_raw_prompt: boolean;
  has_raw_workflow: boolean;
  is_deleted: boolean;
  siblings: AssetSibling[];
  ancestors: Array<{ id: number; filename: string; media_type: string; created_at: number; rating: number; thumb_url: string }>;
  children: Array<{ id: number; filename: string; media_type: string; created_at: number; rating: number; thumb_url: string }>;
}

export interface ComfyStatus {
  online: boolean;
  comfy_url: string;
  comfy_version: string;
  queue_remaining: number;
  executing_prompt_id: string | null;
  executing_node: string | null;
  executing_node_title?: string | null;
  started_at?: number | null;
  progress_value: number;
  progress_max: number;
}

export interface ScanStatus {
  scanning: boolean;
  scanned: number;
  total: number;
  added: number;
  last_scan_at: number;
}

export interface ThumbStatus {
  running: boolean;
  done: number;
  total: number;
}

export interface SidebarFacets {
  counts: {
    total: number;
    images: number;
    videos: number;
    starred: number;
    picked: number;
    rejected: number;
    trash: number;
    hidden?: number;
  };
  folders: Array<{ folder: string; count: number }>;
  loras: Array<{ name: string; count: number }>;
  model_families: Array<{ name: string; count: number }>;
  models: Array<{ name: string; count: number }>;
  workflows: Array<{ hash: string; name: string; count: number }>;
  versions: Array<{ version: string; count: number }>;
  tags: TagItem[];
}

export interface LoraMatrixRow {
  lora_name: string;
  total_count: number;
  pick_count: number;
  pick_rate: number;
  avg_strength: number;
  min_strength: number;
  max_strength: number;
  last_used: number;
  samples: Array<{
    id: number;
    filename: string;
    media_type: string;
    rating: number;
    flag: string;
    strength_model: number;
    thumb_url: string;
  }>;
}

export interface SnippetItem {
  id: number;
  title: string;
  category: string;
  content: string;
  notes: string;
  created_at: number;
  updated_at: number;
}

export interface WorkflowFileItem {
  path: string;
  base_dir: string;
  rel_path: string;
  folder: string;
  name: string;
  file_size: number;
  mtime: number;
  format: "ui" | "api";
  node_count: number;
}

export interface AssetFilter {
  folder: string;
  folderExact: boolean;
  mediaType: "" | "image" | "video";
  search: string;
  lora: string;
  modelFamily: string;
  baseModel: string;
  workflowHash: string;
  recipeHash: string;
  tagId: number | null;
  minRating: number;
  flag: "" | "pick" | "reject";
  comfyVersion: string;
  showDeleted: boolean;
  showHidden: boolean;
  collapseRecipes: boolean;
  sort: "newest" | "oldest" | "rating" | "largest" | "name";
}
