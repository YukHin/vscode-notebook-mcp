import * as vscode from "vscode";
import {
  isPlotlyMime,
  renderPlotlyToPng,
  restoreAfterRendering,
  PlotlyFigure
} from "./plotly.js";

const ERROR_MIME = vscode.NotebookCellOutputItem.error(new Error("")).mime;
const STDOUT_MIME = "application/vnd.code.notebook.stdout";
const STDERR_MIME = "application/vnd.code.notebook.stderr";

// One Jupyter output can carry the same data in several mime types (a
// DataFrame has text/html and text/plain). We return one representation per
// output, in this order of preference.
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const TEXT_MIMES = [
  STDOUT_MIME,
  STDERR_MIME,
  "text/markdown",
  "text/plain",
  "text/latex",
  "application/json",
  "text/html"
];
// Mime types that mean nothing outside a live browser view.
const SKIPPED_MIMES = [
  "application/vnd.jupyter.widget-view+json",
  "application/vnd.jupyter.widget-state+json",
  "application/javascript",
  "text/javascript"
];

// Claude's API rejects images over 5 MB once base64-encoded (~3.75 MB raw).
const MAX_IMAGE_BYTES = 3_500_000;

export interface OutputBudget {
  /** Total characters of text across all outputs of one call. */
  maxChars: number;
  maxImages: number;
}

export const DEFAULT_BUDGET: OutputBudget = { maxChars: 20_000, maxImages: 4 };

export interface TextOutput {
  type: "text";
  text: string;
  stream?: "stderr";
}

export interface ErrorOutput {
  type: "error";
  name: string;
  message: string;
  stack: string;
}

export interface ImageOutput {
  type: "image";
  data: string;
  mimeType: string;
}

export type CellOutput = TextOutput | ErrorOutput | ImageOutput;

/** Remove terminal color/cursor codes; tracebacks from IPython are full of them. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export async function parseOutputs(
  outputs: readonly vscode.NotebookCellOutput[],
  budget: OutputBudget = DEFAULT_BUDGET
): Promise<CellOutput[]> {
  let renderedPlotly = false;
  try {
    return await parseOutputsInner(outputs, budget, () => (renderedPlotly = true));
  } finally {
    if (renderedPlotly) await restoreAfterRendering();
  }
}

async function parseOutputsInner(
  outputs: readonly vscode.NotebookCellOutput[],
  budget: OutputBudget,
  onPlotly: () => void
): Promise<CellOutput[]> {
  const decoder = new TextDecoder();
  const results: CellOutput[] = [];
  const notes: string[] = [];
  let imageCount = 0;
  let imagesDropped = 0;

  const addImage = (data: string, mimeType: string): boolean => {
    if (imageCount >= budget.maxImages) {
      imagesDropped++;
      return false;
    }
    imageCount++;
    results.push({ type: "image", data, mimeType });
    return true;
  };

  for (const output of outputs) {
    const plotlyItem = output.items.find((item) => isPlotlyMime(item.mime));
    if (plotlyItem) {
      if (imageCount >= budget.maxImages) {
        imagesDropped++;
        continue;
      }
      try {
        const figure = JSON.parse(decoder.decode(plotlyItem.data)) as PlotlyFigure;
        onPlotly();
        addImage(await renderPlotlyToPng(figure), "image/png");
      } catch (err) {
        results.push({
          type: "text",
          text: `[Plotly render failed: ${err instanceof Error ? err.message : String(err)}]`
        });
      }
      continue;
    }

    const errorItem = output.items.find((item) => item.mime === ERROR_MIME);
    if (errorItem) {
      try {
        const error = JSON.parse(decoder.decode(errorItem.data));
        results.push({
          type: "error",
          name: stripAnsi(error.name ?? "Error"),
          message: stripAnsi(error.message ?? "Unknown error"),
          stack: stripAnsi(error.stack ?? "")
        });
      } catch {
        results.push({ type: "text", text: stripAnsi(decoder.decode(errorItem.data)) });
      }
      continue;
    }

    const imageItem = IMAGE_MIMES.map((m) => output.items.find((i) => i.mime === m)).find(Boolean);
    if (imageItem) {
      if (imageItem.data.byteLength > MAX_IMAGE_BYTES) {
        notes.push(
          `[An ${imageItem.mime} image of ${(imageItem.data.byteLength / 1e6).toFixed(1)} MB was omitted: too large to send. Save a smaller figure (lower dpi or size) to see it.]`
        );
        continue;
      }
      if (addImage(Buffer.from(imageItem.data).toString("base64"), imageItem.mime)) {
        continue;
      }
      // Over the image budget: fall through to the output's text form, if any.
    }

    const textItem = TEXT_MIMES.map((m) => output.items.find((i) => i.mime === m)).find(Boolean);
    if (textItem) {
      const text = stripAnsi(decoder.decode(textItem.data));
      results.push(
        textItem.mime === STDERR_MIME ? { type: "text", text, stream: "stderr" } : { type: "text", text }
      );
      continue;
    }

    const skipped = output.items.find((i) => SKIPPED_MIMES.includes(i.mime));
    if (skipped) {
      notes.push(`[Interactive output (${skipped.mime}) omitted: it only renders in the editor.]`);
    } else if (output.items.some((i) => i.mime === "image/svg+xml")) {
      notes.push("[An SVG image was omitted. Display the figure as PNG to see it.]");
    } else if (output.items.length > 0) {
      notes.push(`[Output in ${output.items.map((i) => i.mime).join(", ")} omitted: no readable form.]`);
    }
  }

  if (imagesDropped > 0) {
    notes.push(
      `[${imagesDropped} more image(s) omitted; ${imageCount} shown. Raise max_images to see more.]`
    );
  }

  applyTextBudget(results, budget.maxChars);
  for (const text of notes) results.push({ type: "text", text });
  return results;
}

/**
 * Fit all text into `maxChars` by giving each piece a fair share (short
 * pieces keep everything; long ones split what's left), then cutting long
 * pieces in the middle. The end of an output usually matters most (the last
 * log lines, the actual exception), so the tail keeps two thirds.
 */
function applyTextBudget(results: CellOutput[], maxChars: number): void {
  type Slot = { get: () => string; set: (s: string) => void };
  const slots: Slot[] = [];
  for (const r of results) {
    if (r.type === "text") {
      slots.push({ get: () => r.text, set: (s) => (r.text = s) });
    } else if (r.type === "error") {
      slots.push({ get: () => r.stack, set: (s) => (r.stack = s) });
    }
  }
  const total = slots.reduce((n, s) => n + s.get().length, 0);
  if (total <= maxChars) return;

  const order = slots.map((_, i) => i).sort((a, b) => slots[a].get().length - slots[b].get().length);
  let remaining = maxChars;
  const allowance = new Array<number>(slots.length);
  order.forEach((slotIndex, k) => {
    const share = Math.floor(remaining / (order.length - k));
    allowance[slotIndex] = Math.min(slots[slotIndex].get().length, share);
    remaining -= allowance[slotIndex];
  });
  slots.forEach((slot, i) => slot.set(truncateMiddle(slot.get(), allowance[i])));
}

export function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 3);
  const tail = limit - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${omitted} characters omitted; raise max_output_chars to see more …]\n${text.slice(text.length - tail)}`;
}

/** A code fence longer than any backtick run inside `text`, so it can't be closed early. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

export function fenced(text: string, language = ""): string[] {
  const fence = fenceFor(text);
  return [fence + language, text, fence];
}

export function formatOutputsAsMarkdown(outputs: CellOutput[]): string {
  const lines: string[] = [];
  for (const output of outputs) {
    if (output.type === "text") {
      if (output.stream === "stderr") lines.push("stderr:");
      lines.push(...fenced(output.text));
    } else if (output.type === "error") {
      lines.push(`**Error**: ${output.name}: ${output.message}`);
      if (output.stack) {
        lines.push(...fenced(output.stack));
      }
    } else {
      lines.push(`[Image output: ${output.mimeType}]`);
    }
  }
  return lines.join("\n");
}
