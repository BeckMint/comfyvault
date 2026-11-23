export interface DiffToken {
  type: "same" | "added" | "removed";
  text: string;
}

/**
 * Lightweight token-level LCS diff for prompts (handles comma-separated tags and natural prose).
 */
export function diffPromptText(oldText: string, newText: string): DiffToken[] {
  const tokenize = (s: string) =>
    s
      .split(/([,\n]+|\s+)/)
      .filter((t) => t.length > 0);

  const a = tokenize(oldText || "");
  const b = tokenize(newText || "");

  // Guard for very long prompts: fall back to sentence/comma chunks
  const maxCells = 180_000;
  if (a.length * b.length > maxCells) {
    const a2 = (oldText || "").split(/(?=[,\n])/).filter(Boolean);
    const b2 = (newText || "").split(/(?=[,\n])/).filter(Boolean);
    return lcsDiff(a2, b2);
  }
  return lcsDiff(a, b);
}

function lcsDiff(a: string[], b: string[]): DiffToken[] {
  const m = a.length;
  const n = b.length;
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const out: DiffToken[] = [];
  let i = 0;
  let j = 0;
  const push = (type: DiffToken["type"], text: string) => {
    if (out.length > 0 && out[out.length - 1].type === type) {
      out[out.length - 1].text += text;
    } else {
      out.push({ type, text });
    }
  };

  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("removed", a[i]);
      i++;
    } else {
      push("added", b[j]);
      j++;
    }
  }
  while (i < m) {
    push("removed", a[i++]);
  }
  while (j < n) {
    push("added", b[j++]);
  }
  return out;
}
