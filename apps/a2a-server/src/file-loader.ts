import { type FilePart } from "@a2a-js/sdk";
import { ENV } from "#src/env.ts";
import path from "node:path";
import { Buffer } from "node:buffer";
import { createLogger } from "common";

const log = createLogger("a2a/file-loader");

/**
 * Loads content from a FilePart and converts it to Markdown using Docling if available.
 *
 * @param filePart The A2A FilePart containing the file data or URI.
 * @returns A tuple of [filename, mimeType, content]
 */
export async function loadDocumentContent(filePart: FilePart): Promise<[string, string, string]> {
  const file = filePart.file;
  const name = file.name || "unnamed_file";
  const mimeType = file.mimeType || "application/octet-stream";

  log.event("Processing file", { name, mimeType });

  let fileBuffer: Buffer;

  // 1. Get file bytes
  if ("uri" in file) {
    log.info("Downloading file from URI", { name, uri: file.uri });
    const response = await fetch(file.uri);
    if (!response.ok) {
      throw new Error(`Failed to download file from ${file.uri}: ${response.statusText}`);
    }
    fileBuffer = Buffer.from(await response.arrayBuffer());
  } else if ("bytes" in file) {
    log.info("Decoding file from base64 bytes", { name });
    fileBuffer = Buffer.from(file.bytes, "base64");
  } else {
    throw new Error("Unsupported file part: missing both uri and bytes");
  }

  const ext = path.extname(name).toLowerCase();

  // 2. Try conversion via Docling if configured
  if (ENV.DOCLING_SERVE_URL) {
    try {
      log.event("Converting file via Docling", {
        name,
        doclingUrl: ENV.DOCLING_SERVE_URL,
      });

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
          log.success("Docling conversion succeeded", {
            name,
            contentLength: content.length,
          });
          return [name, mimeType, content];
        }
      } else {
        const errorText = await response.text();
        log.warn("Docling conversion failed", {
          name,
          status: response.status,
          errorText,
        });
      }
    } catch (err) {
      log.error("Error while calling Docling", err);
    }
  } else {
    log.warn("DOCLING_SERVE_URL not set; skipping conversion", { name });
  }

  // 3. Fallback: Try reading as UTF-8 text if it's a known text extension or conversion failed
  const allowedTextExts = [".txt", ".md", ".json", ".csv", ".xml"];
  const isLikelyText = allowedTextExts.includes(ext) || mimeType.startsWith("text/");

  if (isLikelyText) {
    try {
      const content = fileBuffer.toString("utf-8");
      log.success("Fallback text extraction succeeded", {
        name,
        contentLength: content.length,
      });
      return [name, mimeType, content];
    } catch (err) {
      log.error("Failed to read file as UTF-8", err);
    }
  }

  throw new Error(`Could not process file ${name}: Unsupported type or conversion failed.`);
}
