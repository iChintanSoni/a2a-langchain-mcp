import express, { type Express } from 'express';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type { DefaultRequestHandler } from '@a2a-js/sdk/server';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';

export function createApp(requestHandler: DefaultRequestHandler): Express {
  const app = express();

  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  return app;
}
