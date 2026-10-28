import { z } from "zod";

export const ResponseFormat = {
  Markdown: "markdown",
  JSON: "json"
} as const;

export const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format");

export const NotebookUriSchema = z
  .string()
  .optional()
  .describe(
    "Notebook URI to target. If omitted, the active notebook is used. Use notebook_list_open to discover URIs."
  );

export const CellIndexSchema = z
  .number()
  .int()
  .min(0)
  .describe("Zero-based cell index");

/**
 * Target a cell by stable id (preferred) or by index. Exactly one is required;
 * resolveCell() in utils/notebook.ts enforces that.
 */
export const CellTargetSchema = {
  cell_id: z
    .string()
    .optional()
    .describe(
      "Stable cell id from notebook_list_cells. Preferred over index: it keeps pointing at the same cell when cells are inserted or deleted."
    ),
  index: CellIndexSchema.optional().describe(
    "Zero-based cell index. Use cell_id instead when the notebook may change between calls."
  )
};

export const TimeoutSchema = z
  .number()
  .positive()
  .max(24 * 60 * 60)
  .default(60)
  .describe(
    "Seconds to wait for the run to finish. If it is still running then, the tool returns the outputs so far with status 'running' (the cell keeps running); use notebook_wait_cell to keep waiting or notebook_interrupt_kernel to stop it."
  );

export const OutputBudgetSchema = {
  max_output_chars: z
    .number()
    .int()
    .min(500)
    .max(200_000)
    .default(20_000)
    .describe(
      "Total characters of text output to return across all outputs. Long text keeps its start and end."
    ),
  max_images: z
    .number()
    .int()
    .min(0)
    .max(20)
    .default(4)
    .describe("Maximum number of images to return.")
};
