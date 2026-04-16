import { type TextPart } from "@a2a-js/sdk";
import { RequestContext } from "@a2a-js/sdk/server";

function getUserInput(requestContext: RequestContext) {
  const textInput = requestContext.userMessage.parts
    .filter((p): p is TextPart => p.kind === "text")
    .at(0)?.text;
  return textInput;
}

export { getUserInput };
