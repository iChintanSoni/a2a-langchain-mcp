import { type FilePart } from "@a2a-js/sdk";
import { ENV } from "#src/env.ts";
import path from "node:path";
import { Buffer } from "node:buffer";

/**
 * Loads content from a FilePart and converts it to Markdown using Docling if available.
 * 
 * @param filePart The A2A FilePart containing the file data or URI.
 * @returns A tuple of [filename, mimeType, content]
 */
export async function loadDocumentContent(
  filePart: FilePart,
): Promise<[string, string, string]> {
  const file = filePart.file;
  const name = file.name || "unnamed_file";
  const mimeType = file.mimeType || "application/octet-stream";

  console.log(`[file-loader] Processing file: ${name} (${mimeType})`);

  let fileBuffer: Buffer;

  // 1. Get file bytes
  if ("uri" in file) {
    console.log(`[file-loader] Downloading file from URI: ${file.uri}`);
    const response = await fetch(file.uri);
    if (!response.ok) {
      throw new Error(
        `Failed to download file from ${file.uri}: ${response.statusText}`,
      );
    }
    fileBuffer = Buffer.from(await response.arrayBuffer());
  } else if ("bytes" in file) {
    console.log(`[file-loader] Decoding file from base64 bytes`);
    fileBuffer = Buffer.from(file.bytes, "base64");
  } else {
    throw new Error("Unsupported file part: missing both uri and bytes");
  }

  const ext = path.extname(name).toLowerCase();
  
  // 2. Try conversion via Docling if configured
  if (ENV.DOCLING_SERVE_URL) {
    try {
      console.log(`[file-loader] Converting file via Docling: ${name}`);
      
      const formData = new FormData();
      // We create a Blob from the buffer to be compatible with FormData in fetch
      const blob = new Blob([fileBuffer], { type: mimeType });
      formData.append("files", blob, name);
      formData.append("image_export_mode", "placeholder");

      const response = await fetch(`${ENV.DOCLING_SERVE_URL}/v1/convert/file`, {
        method: "POST",
        body: formData,
      });

      if (response.ok) {
        const result = (await response.json()) as any;
        const content = result.document?.md_content;
        if (typeof content === "string") {
          console.log(
            `[file-loader] Successfully converted ${name} (${content.length} chars)`,
          );
          return [name, mimeType, content];
        }
      } else {
        const errorText = await response.text();
        console.warn(
          `[file-loader] Docling conversion failed for ${name}: ${response.status} ${errorText}`,
        );
      }
    } catch (err) {
      console.error(`[file-loader] Error while calling Docling for ${name}:`, err);
    }
  } else {
    console.warn(`[file-loader] DOCLING_SERVE_URL not set; skipping conversion for ${name}`);
  }

  // 3. Fallback: Try reading as UTF-8 text if it's a known text extension or conversion failed
  const allowedTextExts = [".txt", ".md", ".json", ".csv", ".xml"];
  const isLikelyText = allowedTextExts.includes(ext) || mimeType.startsWith("text/");

  if (isLikelyText) {
    try {
      const content = fileBuffer.toString("utf-8");
      console.log(`[file-loader] Fallback: read ${name} as text (${content.length} chars)`);
      return [name, mimeType, content];
    } catch (err) {
      console.error(`[file-loader] Failed to read ${name} as UTF-8:`, err);
    }
  }

  throw new Error(`Could not process file ${name}: Unsupported type or conversion failed.`);
}
