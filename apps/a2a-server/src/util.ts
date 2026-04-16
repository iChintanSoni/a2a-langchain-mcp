import { type TextPart, type FilePart } from "@a2a-js/sdk";
import { RequestContext } from "@a2a-js/sdk/server";

function getUserInput(requestContext: RequestContext) {
  const textInput = requestContext.userMessage.parts
    .filter((p): p is TextPart => p.kind === "text")
    .map((p) => p.text)
    .join("\n");
  return textInput;
}

function getFileParts(requestContext: RequestContext) {
  return requestContext.userMessage.parts.filter(
    (p): p is FilePart => p.kind === "file",
  );
}

export { getUserInput, getFileParts };
