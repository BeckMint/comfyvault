import React, { useEffect, useRef } from "react";

const STORAGE_KEY = "comfyvault_prompt_heights_v1";

function loadHeightMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveHeight(storageId: string, heightPx: number) {
  const clamped = Math.max(72, Math.min(900, Math.round(heightPx)));
  try {
    const map = loadHeightMap();
    if (map[storageId] === clamped) return;
    map[storageId] = clamped;
    // Cap total entries to prevent unbounded localStorage growth
    const keys = Object.keys(map);
    if (keys.length > 400) {
      for (const oldKey of keys.slice(0, keys.length - 350)) {
        delete map[oldKey];
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage quota errors
  }
}

function getSavedHeight(storageId: string): number | undefined {
  const h = loadHeightMap()[storageId];
  return typeof h === "number" && h >= 72 && h <= 900 ? h : undefined;
}

interface Props extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  storageId: string;
}

export const PersistentTextarea: React.FC<Props> = ({ storageId, style, ...rest }) => {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const savedHeight = getSavedHeight(storageId);

  // Sync saved height whenever storageId changes (e.g. switching workflows in WorkflowCreateModal)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = getSavedHeight(storageId);
    if (h) {
      el.style.height = `${h}px`;
    } else {
      el.style.height = "";
    }
  }, [storageId]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => {
      // Only persist when the user has explicitly resized the textarea (browser sets inline style.height)
      if (!el.style.height) return;
      const h = el.offsetHeight;
      if (h < 72 || h > 900) return;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveHeight(storageId, h);
      }, 180);
    });

    ro.observe(el);
    return () => {
      ro.disconnect();
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [storageId]);

  return (
    <textarea
      ref={ref}
      style={savedHeight ? { ...style, height: `${savedHeight}px` } : style}
      {...rest}
    />
  );
};
